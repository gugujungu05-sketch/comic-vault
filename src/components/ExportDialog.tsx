import { useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { exportUrl, shareExportUrl } from '../lib/api';
import type { Chapter } from '../types';
import { downloadUrl, formatBytes } from '../lib/util';
import { useToast } from './Toasts';

const FORMATS: { key: string; label: string; ext: string; desc: string }[] = [
  { key: 'cbz', label: 'CBZ', ext: '.cbz', desc: '漫画标准压缩包，含 ComicInfo.xml，Tachiyomi / YACReader / Panels 可直接识别' },
  { key: 'zip', label: 'ZIP', ext: '.zip', desc: '通用压缩包，按话分目录，任何解压软件都能打开' },
  { key: 'pdf', label: 'PDF', ext: '.pdf', desc: '按原图比例排版，适合打印、传阅与长期归档' },
  { key: 'epub', label: 'EPUB', ext: '.epub', desc: '固定版式漫画电子书，支持 Apple Books / Calibre / 掌阅等' },
];

/** 下载范围：单话 / 多话（自选）/ 整本三档，后端 ?chapters= 早已支持，这里把入口讲清楚 */
type Scope = 'all' | 'single' | 'multi';

export function ExportDialog({
  comicId,
  comicTitle,
  chapters,
  shareToken,
  sharePassword,
  initialSelected,
  initialMode,
  onClose,
}: {
  comicId: string;
  comicTitle: string;
  chapters: Chapter[];
  shareToken?: string | null;
  sharePassword?: string;
  initialSelected?: string[];
  initialMode?: Scope;
  onClose: () => void;
}) {
  const toast = useToast();
  const [format, setFormat] = useState('cbz');
  const [scope, setScope] = useState<Scope>(
    initialMode ?? (initialSelected?.length ? 'multi' : 'all'),
  );
  const [selected, setSelected] = useState<string[]>(initialSelected ?? []);
  const [singleId, setSingleId] = useState(
    initialSelected?.[0] ?? chapters[0]?.id ?? '',
  );
  const [busy, setBusy] = useState(false);

  const ids = scope === 'all'
    ? chapters.map((c) => c.id)
    : scope === 'single'
      ? [singleId].filter(Boolean)
      : selected;
  const isWhole = scope === 'all';
  const pageCount = chapters
    .filter((c) => ids.includes(c.id))
    .reduce((n, c) => n + c.pages.length, 0);
  const scopeLabel = scope === 'all'
    ? '整本'
    : scope === 'single'
      ? '单话'
      : `${ids.length} 话（多话）`;

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function doExport(fmt: string) {
    if (!ids.length) return;
    const url = shareToken
      ? shareExportUrl(shareToken, fmt, isWhole ? undefined : ids, sharePassword)
      : exportUrl(comicId, fmt, isWhole ? undefined : ids);
    setBusy(true);
    downloadUrl(url);
    toast(`已开始下载 ${comicTitle} · ${scopeLabel} · ${fmt.toUpperCase()}`);
    setTimeout(() => setBusy(false), 1200);
  }

  return (
    <Modal
      title="保存到本地"
      icon={<Icon name="download" />}
      onClose={onClose}
      width={640}
      footer={
        <button className="btn primary" onClick={() => doExport(format)} disabled={busy || !ids.length}>
          <Icon name="download" size={16} /> 下载 {format.toUpperCase()} · {scopeLabel}
        </button>
      }
    >
      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>下载范围</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {([
            ['all', `整本（${chapters.length} 话）`],
            ['single', '单话（只下一话）'],
            ['multi', '多话（自己勾选）'],
          ] as [Scope, string][]).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`chip ${scope === k ? 'active' : ''}`}
              onClick={() => setScope(k)}
            >
              {label}
            </button>
          ))}
        </div>

        {scope === 'single' && (
          <div className="field" style={{ marginTop: 10 }}>
            <label>选择要下载的那一话</label>
            <select
              className="select"
              value={singleId}
              onChange={(e) => setSingleId(e.target.value)}
            >
              {chapters.map((c, i) => (
                <option key={c.id} value={c.id}>
                  第 {i + 1} 话 · {c.title}（{c.pages.length} 页）
                </option>
              ))}
            </select>
          </div>
        )}

        {scope === 'multi' && (
          <>
            <div className="row" style={{ gap: 6, marginTop: 10 }}>
              <button className="btn sm ghost" onClick={() => setSelected(chapters.map((c) => c.id))}>全选</button>
              <button className="btn sm ghost" onClick={() => setSelected([])}>清空</button>
              <span className="grow" />
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>已选 {ids.length} 话 / {pageCount} 页</span>
            </div>
            <div className="file-list" style={{ marginTop: 8 }}>
              {chapters.map((c) => (
                <div className="li" key={c.id} style={{ cursor: 'pointer' }} onClick={() => toggle(c.id)}>
                  <input type="checkbox" checked={selected.includes(c.id)} readOnly />
                  <span className="grow">{c.title}</span>
                  <span style={{ color: 'var(--muted)' }}>{c.pages.length} 页</span>
                </div>
              ))}
            </div>
          </>
        )}

        {scope === 'all' && (
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8, lineHeight: 1.7 }}>
            打包全部 {chapters.length} 话 / {pageCount} 页为一个文件。想只下某一话或某几话，
            点上面的「单话」「多话」即可。
          </div>
        )}
      </div>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>导出格式</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {FORMATS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`chip ${format === f.key ? 'active' : ''}`}
              style={{ justifyContent: 'flex-start', padding: '10px 12px', height: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
              onClick={() => setFormat(f.key)}
            >
              <span style={{ fontWeight: 700, color: 'var(--text)' }}>
                {f.label} <span style={{ color: 'var(--muted)', fontWeight: 500 }}>{f.ext}</span>
              </span>
              <span style={{ color: 'var(--muted)', whiteSpace: 'normal', textAlign: 'left' }}>{f.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function formatSize(bytes: number) {
  return formatBytes(bytes);
}
