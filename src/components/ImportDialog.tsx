import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { api } from '../lib/api';
import {
  ARCHIVE_RE,
  EPUB_RE,
  IMAGE_RE,
  PDF_RE,
  SEVENZ_ONLY_RE,
  IMPORT_ACCEPT,
  NOVEL_RE,
  filesFromFileList,
  filesFromDataTransfer,
  groupItems,
  pdfToImages,
  type GroupMode,
} from '../lib/importers';
import { useErrorToast, useToast } from './Toasts';
import { naturalCompare } from '../lib/util';

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
  const [pdfWidth, setPdfWidth] = useState(1200);
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
  const [manualOrder, setManualOrder] = useState(false);
  const [showFiles, setShowFiles] = useState(true);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  /** 小说 / 文字型 EPUB：一次上传由服务端自动分章，不进入图片页列表 */
  const [novelFiles, setNovelFiles] = useState<Pick[]>([]);
  /** 文字版 PDF：服务端已直接建好小说（解析阶段即完成） */
  const [novelCreatedId, setNovelCreatedId] = useState('');
  const [phase, setPhase] = useState('');
  /** 几千张图片时一次性渲染全部行会卡死界面，默认只渲染前 300 行 */
  const [listLimit, setListLimit] = useState(300);

  const imgRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dirRef.current) {
      dirRef.current.setAttribute('webkitdirectory', '');
      dirRef.current.setAttribute('directory', '');
    }
  }, []);

  const { groups, remoteGroupCount } = useMemo(() => {
    const remoteItems = items.filter((i) => i.remote);
    const localItems = items.filter((i) => !i.remote);
    const rg = groupItems(remoteItems, mode, per, manualOrder);
    const lg = groupItems(localItems, mode, per, manualOrder);
    return { groups: [...rg, ...lg], remoteGroupCount: rg.length };
  }, [items, mode, per, manualOrder]);

  /** 只要顺序变化不重建缩略图（key 与顺序无关），拖排序时不会闪烁或卡顿 */
  const itemsSignature = useMemo(() => items.map(pickKey).join('|'), [items]);
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const it of items.slice(0, 80)) {
      if (!it.remote && it.blob instanceof Blob && it.blob.size > 0 && /^image\//.test(it.blob.type)) {
        next[pickKey(it)] = URL.createObjectURL(it.blob);
      }
    }
    setThumbs(next);
    return () => {
      for (const u of Object.values(next)) URL.revokeObjectURL(u);
    };
  }, [itemsSignature]);

  function reorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
    setItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setManualOrder(true);
  }

  function sortByName() {
    setItems((prev) => [...prev].sort((a, b) => naturalCompare(a.path, b.path)));
    setManualOrder(true);
  }

  function reverseOrder() {
    setItems((prev) => [...prev].reverse());
    setManualOrder(true);
  }

  function removeAt(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
    setManualOrder(true);
  }

  async function ingest(picks: Pick[]) {
    setParsing(true);
    const next: Pick[] = [];
    const msgs: string[] = [];
    const novelQueue: Pick[] = [];
    for (const p of picks) {
      if (IMAGE_RE.test(p.name)) {
        next.push(p);
      } else if (ARCHIVE_RE.test(p.name) || SEVENZ_ONLY_RE.test(p.name)) {
        // 所有压缩包（含 zip/cbz）统一交给服务端 7-Zip 解压：
        // 浏览器解压大包要先把整包读进内存再逐页回传，又慢又不稳；服务端一次上传即可。
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
      } else if (PDF_RE.test(p.name)) {
        // PDF 交给服务端：先识别文字层（文档/小说型 PDF 直接按章节导入小说，秒级）；
        // 扫描版由服务端渲染成图片；服务端渲染不可用时退回浏览器 pdf.js 渲染
        try {
          const file = p.blob instanceof File ? p.blob : new File([p.blob], p.name);
          const res = await api.importArchive(file);
          if ((res as { kind?: string }).kind === 'novel' && (res as unknown as { comic?: { id?: string } }).comic?.id) {
            setNovelCreatedId((res as unknown as { comic: { id: string } }).comic.id);
            msgs.push(`${p.name}：识别为文字版 PDF，已自动分章导入小说`);
          } else {
            for (const f of res.files) {
              next.push({ name: f.name, blob: new Blob(), path: f.path, remote: true });
            }
            setRemote((prev) => prev || { sessionId: res.sessionId });
            msgs.push(`${p.name}：服务端已渲染，共 ${res.files.length} 页`);
          }
        } catch {
          try {
            const got = await pdfToImages(p.blob, cleanName(p.name), { targetWidth: pdfWidth });
            for (const g of got) next.push({ name: g.name, blob: g.blob, path: g.path });
            if (!got.length) msgs.push(`${p.name} 没有可渲染的页面`);
            else msgs.push(`${p.name}：已在本机渲染 ${got.length} 页`);
          } catch (err) {
            msgs.push(`${p.name} 解析失败：${(err as Error).message}`);
          }
        }
      } else if (EPUB_RE.test(p.name)) {
        // EPUB 不在浏览器里整包解压了（几百章的大书要解几十秒，是「EPUB 解析非常慢」的根因）。
        // 直接上传给服务端：文字书自动分章（秒级）；图片漫画服务端返回 kind:'image'，
        // 导入时自动回退到压缩包流程，按 spine 顺序出图。
        novelQueue.push(p);
        msgs.push(`${p.name}：交给服务端解析，文字书自动分章，图漫自动出页`);
      } else if (NOVEL_RE.test(p.name)) {
        novelQueue.push(p);
        msgs.push(`${p.name}：小说文本，将自动识别章节并生成目录`);
      } else {
        msgs.push(`${p.name}：暂不支持的格式（可用图片 / ZIP·CBZ·RAR·7Z·CBR / PDF / EPUB / TXT 小说 / TAR 等）`);
      }
    }
    if (novelQueue.length) setNovelFiles((prev) => [...prev, ...novelQueue]);
    setNotes(msgs);
    setItems((prev) => {
      const merged = [...prev, ...next];
      const seen = new Set<string>();
      const unique = merged.filter((it) => {
        const key = pickKey(it);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // 未手动排序时，列表顺序与 groupItems 的自然排序保持一致，避免看到的和导入的不一样
      return manualOrder ? unique : unique.sort((a, b) => naturalCompare(a.path, b.path));
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
    if (!groups.length && !novelFiles.length && !novelCreatedId) return;
    setBusy(true);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    setProgress({ done: 0, total });
    try {
      let cid = comicId || novelCreatedId;

      // 文字版 PDF 已在解析阶段直接入库：没有别的内容时直接完成
      if (novelCreatedId && !groups.length && !novelFiles.length) {
        toast('导入完成，已按章节生成小说目录');
        onDone(novelCreatedId);
        return;
      }

      // 0) 小说 TXT / 文字 EPUB：一次上传，服务端自动分章并生成目录，不逐页上传。
      //    图片漫画 EPUB 服务端会返回 kind:'image'，这里自动回退：按 spine 解出页面并落盘成话。
      let novelDone = 0;
      if (novelFiles.length) {
        for (let ni = 0; ni < novelFiles.length; ni++) {
          const nf = novelFiles[ni];
          setPhase(`正在上传并解析：${nf.name}（${ni + 1}/${novelFiles.length}）`);
          const file = nf.blob instanceof File ? nf.blob : new File([nf.blob], nf.name);
          const r = await api.importNovelFile(file, (loaded, tot) => {
            setProgress({ done: Math.round((loaded / 1024 / 1024) * 10) / 10, total: Math.round((tot / 1024 / 1024) * 10) / 10 });
            setPhase(`正在上传 ${nf.name} · ${Math.round((loaded / 1024 / 1024) * 10) / 10} / ${Math.round((tot / 1024 / 1024) * 10) / 10} MB`);
          });
          if (r.comic?.id && !cid) cid = r.comic.id;
          if (r.kind === 'image') {
            // 图片漫画 EPUB：服务端解出页面后直接落盘，不再回传浏览器
            setPhase(`正在解出页面：${nf.name}`);
            const res = await api.importArchive(file);
            if (res.sessionId && (res.files || []).length) {
              if (!cid) {
                const comic = await api.create({
                  title: meta.title.trim() || nf.name.replace(/\.[^.]+$/, '') || '未命名漫画',
                  author: meta.author.trim(),
                  direction: meta.direction,
                });
                cid = comic.id;
              }
              const gm = new Map<string, string[]>();
              for (const f of res.files) {
                const parts = String(f.path || f.name).split('/');
                const g = parts.length > 1 ? parts[0] : '';
                if (!gm.has(g)) gm.set(g, []);
                gm.get(g)!.push(f.path);
              }
              const fl = res.fields || {};
              await api.commitArchive(res.sessionId, {
                groups: [...gm.entries()].map(([dir, paths], i) => ({
                  title: dir || nf.name.replace(/\.[^.]+$/, '') || `第 ${i + 1} 话`,
                  paths,
                })),
                comicId: cid,
                title: meta.title.trim() || fl.title || nf.name.replace(/\.[^.]+$/, '') || '未命名漫画',
                author: meta.author.trim() || fl.author || '',
                direction: meta.direction,
              });
              if (res.meta) setComicInfo(res.meta);
            }
          } else {
            novelDone += 1;
          }
        }
        setPhase('');
        if (!groups.length) {
          toast(novelDone
            ? `导入完成，已自动生成 ${novelDone} 本小说的章节目录`
            : '导入完成');
          onDone(cid!);
          return;
        }
      }

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
        const comicIdFinal: string = cid; // 已在上面确保创建
        // 跨章节 2 路并发上传（同章节内批次仍串行保页序），多话导入明显提速
        const uploadOne = async (i: number) => {
          const g = localGroups[i];
          const gi = remoteGroupCount + i;
          const chapters = await api.addChapter(comicIdFinal, {
            title: titles[gi] || g.title || `第 ${gi + 1} 话`,
            number: gi + 1,
          });
          const chapter = chapters[chapters.length - 1];
          await api.uploadPages(
            comicIdFinal,
            chapter.id,
            g.items.map((it) => ({ name: it.name, blob: it.blob })),
            undefined,
            (done) => {
              const before = localGroups.slice(0, i).reduce((n, x) => n + x.items.length, 0);
              setProgress({ done: remoteDone + before + done, total });
            },
          );
        };
        const LANES = 2;
        let laneCursor = 0;
        await Promise.all(Array.from({ length: Math.min(LANES, localGroups.length) }, async () => {
          for (;;) {
            const i = laneCursor;
            laneCursor += 1;
            if (i >= localGroups.length) return;
            await uploadOne(i);
          }
        }));
      }
      toast(`导入完成，共 ${total} 页`);
      onDone(cid!);
    } catch (err) {
      errorToast(err, '导入失败');
    } finally {
      setBusy(false);
      setPhase('');
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
          <button className="btn primary" onClick={start} disabled={busy || (!groups.length && !novelFiles.length)}>
            {busy
              ? (phase ? '导入中…' : `导入中 ${percent}%`)
              : (novelFiles.length && !groups.length
                ? `开始导入（${novelFiles.length} 本小说 · 自动生成目录）`
                : `开始导入（${groups.length} 话 / ${items.length} 页）`)}
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
        onClick={() => photoRef.current?.click()}
      >
        <div className="big">拖拽图片 / 压缩包 / PDF / EPUB / TXT 小说 到此处</div>
        <div>支持图片、各类压缩包、PDF、EPUB、TXT/MD 小说；小说与文字 EPUB 会自动识别章节生成目录，一次导入即可阅读</div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button className="btn primary" onClick={() => imgRef.current?.click()}>
          <Icon name="upload" size={16} /> 选择文件（图片 / 压缩包 / PDF / EPUB / TXT，可多选）
        </button>
        <button className="btn sm" onClick={() => photoRef.current?.click()} title="手机浏览器从相册一次多选图片">
          <Icon name="image" size={15} /> 从相册选图
        </button>
        <button className="btn sm" onClick={() => dirRef.current?.click()}>
          <Icon name="folder" size={15} /> 整个文件夹
        </button>
        {(items.length > 0 || novelFiles.length > 0) && (
          <button className="btn sm ghost" onClick={() => { setItems([]); setNovelFiles([]); setTitles({}); setListLimit(300); }}>
            <Icon name="trash" size={15} /> 清空
          </button>
        )}
        <span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 'auto' }}>
          {parsing ? '解析中…' : `已就绪 ${items.length} 页${novelFiles.length ? ` · ${novelFiles.length} 本小说` : ''}`}
        </span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, lineHeight: 1.7 }}>
        <b>可以反复添加：</b>每次选择都会<b>追加</b>到列表，不会清空之前已选的文件，最后统一排序再导入。
        「选择文件」支持图片、ZIP/CBZ/RAR/7Z、PDF、EPUB、TXT 等全部格式；
        部分手机浏览器一次只能选 1 个，多点几次即可；「从相册选图」会打开相册，通常能一次多选。
      </div>

      {/* 纯图片选择器：accept=image/* 会让国产手机浏览器调起「相册」而不是单选的文件管理器 */}
      <input
        id="cv-import-photos"
        ref={photoRef}
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
        id="cv-import-images"
        ref={imgRef}
        type="file"
        multiple
        accept={IMPORT_ACCEPT}
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
          <div className="sort-panel">
            <div className="sort-panel-head">
              <button className="btn sm ghost" onClick={() => setShowFiles((v) => !v)}>
                <Icon name="list" size={14} /> 文件排序（{items.length} 个）
              </button>
              <span className={`sort-mode ${manualOrder ? 'custom' : ''}`}>
                {manualOrder ? '自定义顺序' : '智能自然排序'}
              </span>
              <div className="row" style={{ gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
                <button className="chip sm active" type="button" onClick={() => photoRef.current?.click()}>
                  <Icon name="image" size={13} /> ＋ 继续添加图片
                </button>
                <button className="chip sm" type="button" onClick={() => imgRef.current?.click()}>
                  <Icon name="file" size={13} /> ＋ 继续添加文件
                </button>
                <button className="chip sm" type="button" onClick={sortByName}>按名称排序</button>
                <button className="chip sm" type="button" onClick={reverseOrder}>反转</button>
                {manualOrder && (
                  <button className="chip sm active" type="button" onClick={() => setManualOrder(false)}>恢复智能排序</button>
                )}
              </div>
            </div>

            {showFiles && (
              <div className="sort-list">
                {/* 一次渲染几千行会让界面卡死，默认只渲染前 300 行，可继续展开 */}
                {(items.length > listLimit ? items.slice(0, listLimit) : items).map((it, i) => (
                  <div
                    key={pickKey(it)}
                    className={`sort-item ${dragIndex === i ? 'dragging' : ''}`}
                    draggable
                    onDragStart={(e) => { setDragIndex(i); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragIndex !== null) reorder(dragIndex, i);
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    <span className="sort-index">{i + 1}</span>
                    {thumbs[pickKey(it)] ? (
                      <img src={thumbs[pickKey(it)]} alt="" />
                    ) : (
                      <span className="sort-thumb-empty"><Icon name="image" size={14} /></span>
                    )}
                    <span className="sort-name" title={it.path}>{it.path}</span>
                    <div className="sort-ops">
                      <button type="button" title="上移" disabled={i === 0} onClick={() => reorder(i, i - 1)}>↑</button>
                      <button type="button" title="下移" disabled={i === items.length - 1} onClick={() => reorder(i, i + 1)}>↓</button>
                      <button type="button" title="移除" onClick={() => removeAt(i)}>×</button>
                    </div>
                  </div>
                ))}
                {items.length > listLimit && (
                  <button className="btn sm ghost" type="button" style={{ marginTop: 8 }}
                    onClick={() => setListLimit((v) => v + 300)}>
                    显示更多（还有 {items.length - listLimit} 个）
                  </button>
                )}
              </div>
            )}
            <div className="sort-hint">
              点「继续添加图片 / 文件」可随时再选一批，新图片会<b>追加到当前列表一起排序</b>，不会另起一批、编号连续；拖动行或用 ↑↓ 调整顺序，导入时按此顺序排列页面。
            </div>
          </div>

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
              {phase && <div style={{ fontSize: 12, marginBottom: 6 }}>{phase}</div>}
              <div className="progress">
                <i style={{ width: `${percent}%` }} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                {phase
                  ? ''
                  : `正在上传 ${Math.floor(progress.done)} / ${progress.total} 页 · ${percent}%`}
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
          提示：压缩包里的目录结构会自动识别为「话」；PDF 会按页渲染成图片；EPUB 会按书内
          阅读顺序提取图片并整本为一话；RAR/7Z/CBR/CB7
          由服务端用 7-Zip 引擎解压；包内的 ComicInfo.xml 会自动填充标题、作者、出版社、年份、
          评分、分级与阅读方向，导出 CBZ 时这些字段会原样写回。
        </div>
      )}
    </Modal>
  );
}

function pickKey(it: Pick) {
  return `${it.path}::${it.blob.size}`;
}

function cleanName(name: string) {
  return name.replace(/\.[^.]+$/, '');
}
