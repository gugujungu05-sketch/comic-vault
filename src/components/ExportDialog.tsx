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

export function ExportDialog({
  comicId,
  comicTitle,
  chapters,
  shareToken,
  sharePassword,
  initialSelected,
  onClose,
}: {
  comicId: string;
  comicTitle: string;
  chapters: Chapter[];
  shareToken?: string | null;
  sharePassword?: string;
  initialSelected?: string[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [format, setFormat] = useState('cbz');
  const [selected, setSelected] = useState<string[]>(initialSelected ?? []);
  const [busy, setBusy] = useState(false);

  const all = selected.length === 0;
  const ids = all ? chapters.map((c) => c.id) : selected;
  const pageCount = chapters
    .filter((c) => ids.includes(c.id))
    .reduce((n, c) => n + c.pages.length, 0);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function doExport(fmt: string) {
    const url = shareToken
      ? shareExportUrl(shareToken, fmt, all ? undefined : ids, sharePassword)
      : exportUrl(comicId, fmt, all ? undefined : ids);
    setBusy(true);
    downloadUrl(url);
    toast(`已开始下载 ${comicTitle}.${fmt}`);
    setTimeout(() => setBusy(false), 1200);
  }

  return (
    <Modal
      title="保存到本地"
      icon={<Icon name="download" />}
      onClose={onClose}
      width={640}
      footer={
        <button className="btn primary" onClick={() => doExport(format)} disabled={busy || !pageCount}>
          <Icon name="download" size={16} /> 下载 {format.toUpperCase()}
        </button>
      }
    >
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

      <div>
        <div className="row" style={{ marginBottom: 8 }}>
          <span style={{ fontWeight: 700 }}>范围</span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {all ? `整本（${chapters.length} 话 / ${pageCount} 页）` : `已选 ${ids.length} 话 / ${pageCount} 页`}
          </span>
          <button
            className="btn sm ghost"
            style={{ marginLeft: 'auto' }}
            onClick={() => setSelected(all ? chapters.map((c) => c.id) : [])}
          >
            {all ? '手动选择' : '选择全部'}
          </button>
        </div>
        {!all && (
          <div className="file-list">
            {chapters.map((c) => (
              <div className="li" key={c.id} style={{ cursor: 'pointer' }} onClick={() => toggle(c.id)}>
                <input type="checkbox" checked={selected.includes(c.id)} readOnly />
                <span className="grow">{c.title}</span>
                <span style={{ color: 'var(--muted)' }}>{c.pages.length} 页</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function formatSize(bytes: number) {
  return formatBytes(bytes);
}
