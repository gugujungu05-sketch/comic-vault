import { useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { api } from '../lib/api';
import type { Chapter, Page } from '../types';
import { useErrorToast, useToast } from './Toasts';

type Scope = 'page' | 'chapter' | 'comic';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 页面编辑器：旋转 / 裁剪。
 * 裁剪框用鼠标在预览图上拖拽绘制，坐标以百分比存储，服务端再换算成像素。
 */
export function PageEditor({
  comicId,
  chapter,
  page,
  direction = 'ltr',
  onClose,
  onDone,
}: {
  comicId: string;
  chapter: Chapter;
  page: Page;
  direction?: 'ltr' | 'rtl';
  onClose: () => void;
  onDone: (chapter: Chapter) => void;
}) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const [rotate, setRotate] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [scope, setScope] = useState<Scope>('page');
  const [busy, setBusy] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  function toPercent(e: React.MouseEvent) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100)),
    };
  }

  function onDown(e: React.MouseEvent) {
    e.preventDefault();
    const p = toPercent(e);
    dragStart.current = p;
    setBox({ x: p.x, y: p.y, w: 0, h: 0 });
  }

  function onMove(e: React.MouseEvent) {
    if (!dragStart.current) return;
    const p = toPercent(e);
    const x = Math.min(dragStart.current.x, p.x);
    const y = Math.min(dragStart.current.y, p.y);
    setBox({
      x,
      y,
      w: Math.abs(p.x - dragStart.current.x),
      h: Math.abs(p.y - dragStart.current.y),
    });
  }

  function onUp() {
    dragStart.current = null;
    setBox((b) => (b && (b.w < 3 || b.h < 3) ? null : b));
  }

  async function apply() {
    if (!rotate && !box) {
      toast('没有需要应用的修改');
      return;
    }
    setBusy(true);
    try {
      const res = await api.editPage(comicId, chapter.id, page.id, {
        rotate,
        crop: box,
        scope,
      });
      const label = scope === 'page' ? '本页' : scope === 'chapter' ? '本章所有页' : '整本所有页';
      toast(`已应用到${label}（${res.updated} 页）`);
      onDone(res.chapter);
    } catch (err) {
      errorToast(err, '处理失败');
    } finally {
      setBusy(false);
    }
  }

  const scopeHint =
    scope === 'page'
      ? '只处理当前这一页'
      : scope === 'chapter'
        ? `把同样的旋转/裁剪应用到本章 ${chapter.pages.length} 页`
        : '把同样的旋转/裁剪应用到整本所有页';

  return (
    <Modal
      title="编辑页面"
      icon={<Icon name="edit" />}
      onClose={onClose}
      width={760}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={apply} disabled={busy}>
            {busy ? '处理中…' : '应用修改'}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>旋转</span>
        <button className="btn sm" onClick={() => setRotate((r) => (r - 90 + 360) % 360)}>
          <Icon name="refresh" size={14} /> 左转 90°
        </button>
        <button className="btn sm" onClick={() => setRotate((r) => (r + 90) % 360)}>
          <Icon name="refresh" size={14} style={{ transform: 'scaleX(-1)' }} /> 右转 90°
        </button>
        <button className="btn sm" onClick={() => setRotate((r) => (r + 180) % 360)}>
          180°
        </button>
        {rotate !== 0 && (
          <button className="btn sm ghost" onClick={() => setRotate(0)}>
            复位（{rotate}°）
          </button>
        )}

        <span style={{ fontWeight: 700, fontSize: 13, marginLeft: 8 }}>作用范围</span>
        <select className="select" style={{ width: 150 }} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          <option value="page">仅本页</option>
          <option value="chapter">本章全部</option>
          <option value="comic">整本全部</option>
        </select>
      </div>

      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{scopeHint}</div>

      <div
        ref={stageRef}
        className="crop-stage"
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
      >
        <img
          src={page.url}
          alt="待编辑页面"
          draggable={false}
          style={{ transform: `rotate(${rotate}deg)`, transition: 'transform .18s ease' }}
        />
        {box && (
          <div
            className="crop-box"
            style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }}
          />
        )}
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          在图上按住鼠标拖动即可框选要保留的区域（可用来切掉扫描白边）
        </span>
        {box && (
          <>
            <span className="chip">
              裁剪 {Math.round(box.w)}% × {Math.round(box.h)}%
            </span>
            <button className="btn sm ghost" onClick={() => setBox(null)}>
              <Icon name="close" size={13} /> 取消裁剪
            </button>
          </>
        )}
        <button
          className="btn sm ghost"
          onClick={() =>
            setBox({
              x: direction === 'rtl' ? 0 : 0,
              y: 0,
              w: 50,
              h: 100,
            })
          }
        >
          取左半页
        </button>
        <button className="btn sm ghost" onClick={() => setBox({ x: 50, y: 0, w: 50, h: 100 })}>
          取右半页
        </button>
      </div>
    </Modal>
  );
}
