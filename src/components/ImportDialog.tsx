import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { api } from '../lib/api';
import {
  ARCHIVE_RE,
  IMAGE_RE,
  PDF_RE,
  SEVENZ_ONLY_RE,
  extractArchive,
  filesFromFileList,
  filesFromDataTransfer,
  groupItems,
  pdfToImages,
  type GroupMode,
} from '../lib/importers';
import { useErrorToast, useToast } from './Toasts';

interface Pick {
  name: string;
  blob: Blob;
  path: string;
  /** 来自服务端解压的压缩包（RAR/7z 等），落盘时走 commit 接口而不是重新上传 */
  remote?: boolean;
}

export function ImportDialog({
  comicId,
  onClose,
  onDone,
}: {
  comicId?: string;
  onClose: () => void;
  onDone: (comicId: string) => void;
}) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const [items, setItems] = useState<Pick[]>([]);
  const [mode, setMode] = useState<GroupMode>('folder');
  const [per, setPer] = useState(25);
  const [pdfWidth, setPdfWidth] = useState(1600);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [notes, setNotes] = useState<string[]>([]);
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [dropped, setDropped] = useState(false);
  const [meta, setMeta] = useState({
    title: '',
    author: '',
    artist: '',
    tags: '',
    description: '',
    direction: 'ltr' as 'ltr' | 'rtl',
    publisher: '',
    year: '' as string | number,
    rating: '' as string | number,
    ageRating: '',
  });
  const [comicInfo, setComicInfo] = useState<Record<string, string> | null>(null);
  const [remote, setRemote] = useState<{ sessionId: string } | null>(null);

  const imgRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const arcRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dirRef.current) {
      dirRef.current.setAttribute('webkitdirectory', '');
      dirRef.current.setAttribute('directory', '');
    }
  }, []);

  const { groups, remoteGroupCount } = useMemo(() => {
    const remoteItems = items.filter((i) => i.remote);
    const localItems = items.filter((i) => !i.remote);
    const rg = groupItems(remoteItems, mode, per);
    const lg = groupItems(localItems, mode, per);
    return { groups: [...rg, ...lg], remoteGroupCount: rg.length };
  }, [items, mode, per]);

  async function ingest(picks: Pick[]) {
    setParsing(true);
    const next: Pick[] = [];
    const msgs: string[] = [];
    for (const p of picks) {
      if (IMAGE_RE.test(p.name)) {
        next.push(p);
      } else if (ARCHIVE_RE.test(p.name)) {
        try {
          const { items: got, meta } = await extractArchive(p.blob);
          for (const g of got) {
            next.push({ name: g.name, blob: g.blob, path: `${cleanName(p.name)}/${g.path}` });
          }
          if (meta) {
            setMeta((m) => ({
              title: m.title || meta.title || '',
              author: m.author || meta.author || '',
              artist: m.artist || meta.artist || '',
              tags: m.tags || (meta.tags || []).join(', '),
              description: m.description || meta.description || '',
              direction: meta.direction || m.direction,
              publisher: m.publisher || meta.publisher || '',
              year: m.year || meta.year || '',
              rating: m.rating || meta.rating || '',
              ageRating: m.ageRating || meta.ageRating || '',
            }));
            if (meta.raw) setComicInfo(meta.raw);
          }
          if (!got.length) msgs.push(`${p.name} 中没有找到图片`);
        } catch (err) {
          msgs.push(`${p.name} 解压失败：${(err as Error).message}`);
        }
      } else if (PDF_RE.test(p.name)) {
        try {
          const got = await pdfToImages(p.blob, cleanName(p.name), { targetWidth: pdfWidth });
          for (const g of got) next.push({ name: g.name, blob: g.blob, path: g.path });
          if (!got.length) msgs.push(`${p.name} 没有可渲染的页面`);
        } catch (err) {
          msgs.push(`${p.name} 解析失败：${(err as Error).message}`);
        }
      } else if (SEVENZ_ONLY_RE.test(p.name)) {
        try {
          const file = p.blob instanceof File ? p.blob : new File([p.blob], p.name);
          const res = await api.importArchive(file);
          for (const f of res.files) {
            next.push({ name: f.name, blob: new Blob(), path: f.path, remote: true });
          }
          setRemote((prev) => prev || { sessionId: res.sessionId });
          const f = res.fields || {};
          setMeta((m) => ({
            title: m.title || f.title || '',
            author: m.author || f.author || '',
            artist: m.artist || f.artist || '',
            tags: m.tags || (f.tags || []).join(', '),
            description: m.description || f.description || '',
            direction: f.direction || m.direction,
            publisher: m.publisher || f.publisher || '',
            year: m.year || f.year || '',
            rating: m.rating || f.rating || '',
            ageRating: m.ageRating || f.ageRating || '',
          }));
          if (res.meta) setComicInfo(res.meta);
          msgs.push(`${p.name}：服务端已解压，共 ${res.files.length} 张图片`);
        } catch (err) {
          msgs.push(`${p.name} 解压失败：${(err as Error).message}`);
        }
      }
    }
    setNotes(msgs);
    setItems((prev) => {
      const merged = [...prev, ...next];
      const seen = new Set<string>();
      return merged.filter((it) => {
        const key = `${it.path}::${it.blob.size}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
    if (next.length) {
      // 有目录结构时默认按目录分话
      if (next.some((n) => n.path.includes('/'))) setMode((m) => (m === 'count' ? 'count' : 'folder'));
    }
    setParsing(false);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropped(false);
    const list = await filesFromDataTransfer(e.dataTransfer);
    if (list.length) await ingest(list);
  }

  async function start() {
    if (!groups.length) return;
    setBusy(true);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    setProgress({ done: 0, total });
    try {
      let cid = comicId;
      const remoteGroups = groups.slice(0, remoteGroupCount);
      const localGroups = groups.slice(remoteGroupCount);

      // 1) 服务端解压出来的压缩包内容：直接让服务端落盘，不用回传浏览器
      if (remote && remoteGroups.length) {
        const res = await api.commitArchive(remote.sessionId, {
          groups: remoteGroups.map((g, i) => ({
            title: titles[i] || g.title || `第 ${i + 1} 话`,
            paths: g.items.map((it) => it.path),
          })),
          comicId: cid,
          title: meta.title.trim() || '未命名漫画',
          author: meta.author.trim(),
          artist: meta.artist.trim(),
          description: meta.description.trim(),
          tags: meta.tags
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
          direction: meta.direction,
          publisher: meta.publisher.trim(),
          year: Number(meta.year) || null,
          rating: Number(meta.rating) || null,
          ageRating: meta.ageRating.trim(),
          comicInfo,
        });
        cid = res.comic.id;
        setRemote(null);
        setProgress({ done: remoteGroups.reduce((n, g) => n + g.items.length, 0), total });
      }

      // 2) 浏览器本地的图片 / ZIP / PDF：按原流程上传
      if (localGroups.length) {
        if (!cid) {
          const comic = await api.create({
            title: meta.title.trim() || '未命名漫画',
            author: meta.author.trim(),
            artist: meta.artist.trim(),
            description: meta.description.trim(),
            tags: meta.tags
              .split(/[,，]/)
              .map((t) => t.trim())
              .filter(Boolean),
            direction: meta.direction,
            publisher: meta.publisher.trim(),
            year: Number(meta.year) || null,
            rating: Number(meta.rating) || null,
            ageRating: meta.ageRating.trim(),
            comicInfo,
          });
          cid = comic.id;
        }
        const remoteDone = groups.slice(0, remoteGroupCount).reduce((n, g) => n + g.items.length, 0);
        for (let i = 0; i < localGroups.length; i++) {
          const g = localGroups[i];
          const gi = remoteGroupCount + i;
          const chapters = await api.addChapter(cid, {
            title: titles[gi] || g.title || `第 ${gi + 1} 话`,
            number: gi + 1,
          });
          const chapter = chapters[chapters.length - 1];
          await api.uploadPages(
            cid,
            chapter.id,
            g.items.map((it) => ({ name: it.name, blob: it.blob })),
            undefined,
            (done) => {
              const before = localGroups.slice(0, i).reduce((n, x) => n + x.items.length, 0);
              setProgress({ done: remoteDone + before + done, total });
            },
          );
        }
      }
      toast(`导入完成，共 ${total} 页`);
      onDone(cid!);
    } catch (err) {
      errorToast(err, '导入失败');
    } finally {
      setBusy(false);
    }
  }

  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Modal
      title={comicId ? '导入图片 · 自动分话' : '新建漫画并导入'}
      icon={<Icon name="upload" />}
      onClose={busy ? () => {} : onClose}
      width={780}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={start} disabled={busy || !groups.length}>
            {busy ? `导入中 ${percent}%` : `开始导入（${groups.length} 话 / ${items.length} 页）`}
          </button>
        </>
      }
    >
      <div
        className={`dropzone ${dropped ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDropped(true);
        }}
        onDragLeave={() => setDropped(false)}
        onDrop={onDrop}
        onClick={() => imgRef.current?.click()}
      >
        <div className="big">拖拽图片 / 文件夹 / ZIP·CBZ·RAR·7Z / PDF 到此处</div>
        <div>或点击选择文件 —— RAR、7Z、CBR、CB7 会由服务端解压，不占用浏览器内存</div>
      </div>

      <div className="row">
        <button className="btn sm" onClick={() => imgRef.current?.click()}>
          <Icon name="image" size={15} /> 选择图片
        </button>
        <button className="btn sm" onClick={() => dirRef.current?.click()}>
          <Icon name="folder" size={15} /> 选择文件夹
        </button>
        <button className="btn sm" onClick={() => arcRef.current?.click()}>
          <Icon name="file" size={15} /> ZIP / CBZ / RAR / 7Z / PDF
        </button>
        {items.length > 0 && (
          <button className="btn sm ghost" onClick={() => { setItems([]); setTitles({}); }}>
            <Icon name="trash" size={15} /> 清空
          </button>
        )}
        <span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 'auto' }}>
          {parsing ? '解析中…' : `已就绪 ${items.length} 页`}
        </span>
      </div>

      <input
        id="cv-import-images"
        ref={imgRef}
        type="file"
        multiple
        accept="image/*"
        hidden
        onChange={(e) => {
          if (e.target.files) ingest(filesFromFileList(e.target.files));
          e.target.value = '';
        }}
      />
      <input
        id="cv-import-folder"
        ref={dirRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) ingest(filesFromFileList(e.target.files));
          e.target.value = '';
        }}
      />
      <input
        id="cv-import-archive"
        ref={arcRef}
        type="file"
        multiple
        accept=".zip,.cbz,.pdf,.rar,.cbr,.7z,.cb7,.ace,.arj,.lzh,.cab,.iso"
        hidden
        onChange={(e) => {
          if (e.target.files) ingest(filesFromFileList(e.target.files));
          e.target.value = '';
        }}
      />

      {!comicId && (
        <div className="grid-2">
          <div className="field">
            <label>漫画标题</label>
            <input
              className="input"
              placeholder="从 ComicInfo.xml 自动读取，可修改"
              value={meta.title}
              onChange={(e) => setMeta({ ...meta, title: e.target.value })}
            />
          </div>
          <div className="field">
            <label>作者</label>
            <input
              className="input"
              value={meta.author}
              onChange={(e) => setMeta({ ...meta, author: e.target.value })}
            />
          </div>
          <div className="field">
            <label>标签（逗号分隔）</label>
            <input
              className="input"
              value={meta.tags}
              onChange={(e) => setMeta({ ...meta, tags: e.target.value })}
            />
          </div>
          <div className="field">
            <label>阅读方向</label>
            <select
              className="select"
              value={meta.direction}
              onChange={(e) => setMeta({ ...meta, direction: e.target.value as 'ltr' | 'rtl' })}
            >
              <option value="ltr">从左往右（LTR）</option>
              <option value="rtl">从右往左（日漫 RTL）</option>
            </select>
          </div>
          <div className="field">
            <label>出版社</label>
            <input
              className="input"
              value={meta.publisher}
              onChange={(e) => setMeta({ ...meta, publisher: e.target.value })}
            />
          </div>
          <div className="field">
            <label>发行年份</label>
            <input
              className="input"
              type="number"
              value={meta.year}
              onChange={(e) => setMeta({ ...meta, year: e.target.value })}
            />
          </div>
        </div>
      )}

      {comicInfo && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          已从 ComicInfo.xml 读取 {Object.keys(comicInfo).length} 个字段：
          {[comicInfo.Publisher, comicInfo.Year, comicInfo.AgeRating, comicInfo.Rating]
            .filter(Boolean)
            .join(' · ') || Object.keys(comicInfo).slice(0, 6).join(' · ')}
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="row">
            <span style={{ fontWeight: 700, fontSize: 13 }}>分话方式</span>
            {(
              [
                ['folder', '按文件夹'],
                ['count', '按页数'],
                ['prefix', '按文件名编号'],
                ['all', '全部一话'],
              ] as [GroupMode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                className={`chip ${mode === m ? 'active' : ''}`}
                onClick={() => setMode(m)}
                type="button"
              >
                {label}
              </button>
            ))}
            {mode === 'count' && (
              <input
                type="number"
                min={1}
                value={per}
                onChange={(e) => setPer(Math.max(1, Number(e.target.value) || 1))}
                className="input"
                style={{ width: 90 }}
              />
            )}
            {items.some((i) => /\.pdf/i.test(i.path)) && (
              <select
                className="select"
                style={{ width: 150 }}
                value={pdfWidth}
                onChange={async (e) => {
                  setPdfWidth(Number(e.target.value));
                }}
              >
                <option value={1200}>PDF 清晰度 1200</option>
                <option value={1600}>PDF 清晰度 1600</option>
                <option value={2200}>PDF 清晰度 2200</option>
              </select>
            )}
          </div>

          <div className="file-list">
            {groups.map((g, i) => (
              <div className="li" key={i}>
                <Icon name="folder" size={15} />
                <input
                  className="input"
                  style={{ width: '42%' }}
                  value={titles[i] ?? g.title}
                  onChange={(e) => setTitles({ ...titles, [i]: e.target.value })}
                />
                <span style={{ color: 'var(--muted)' }}>{g.items.length} 页</span>
                <span className="grow" style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {g.items[0]?.name} … {g.items[g.items.length - 1]?.name}
                </span>
              </div>
            ))}
          </div>

          {busy && (
            <div>
              <div className="progress">
                <i style={{ width: `${percent}%` }} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                正在上传 {progress.done} / {progress.total} 页
              </div>
            </div>
          )}
        </>
      )}

      {notes.length > 0 && (
        <div style={{ color: 'var(--warn)', fontSize: 12 }}>
          {notes.map((n, i) => (
            <div key={i}>· {n}</div>
          ))}
        </div>
      )}

      {items.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>
          提示：压缩包里的目录结构会自动识别为「话」；PDF 会按页渲染成图片；RAR/7Z/CBR/CB7
          由服务端用 7-Zip 引擎解压；包内的 ComicInfo.xml 会自动填充标题、作者、出版社、年份、
          评分、分级与阅读方向，导出 CBZ 时这些字段会原样写回。
        </div>
      )}
    </Modal>
  );
}

function cleanName(name: string) {
  return name.replace(/\.[^.]+$/, '');
}
