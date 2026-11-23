import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { importTaskStore } from '../lib/importTask';
import { mediaUrl } from '../lib/api';
import { Icon } from './Icon';

/** 把在线来源封面转换成可访问的绝对地址（走图片代理，带源 id）。 */
function taskCover(sid: string | undefined, cover: string | undefined): string {
  if (!cover) return '';
  const key = String(sid || '').replace(/^js:/, '');
  if (!key) return mediaUrl(cover);
  return mediaUrl(`/api/online/img?sid=${encodeURIComponent(key)}&u=${encodeURIComponent(cover)}`);
}

/**
 * 浏览器式「下载」导航按钮：类似 Chrome 右上角下载键。
 * 平时只在顶栏显示一个图标，进行中显示进度角标、完成后显示完成角标；
 * 点击才弹出任务面板，不常驻悬浮、不遮挡内容。
 */
export function DownloadButton() {
  const task = useSyncExternalStore(importTaskStore.subscribe, importTaskStore.getSnapshot);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点击面板外部关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const hasTask = task.active || task.finished;
  const ctx = task.ctx;
  const pct = task.total > 0 ? Math.min(100, Math.round((task.done / task.total) * 100)) : 0;
  const hasFail = task.failed > 0;
  const stateCls = task.finished ? (hasFail ? 'warn' : 'done') : task.paused ? 'paused' : 'running';

  function viewComic() {
    if (task.comicId) navigate(`/comic/${task.comicId}`);
    importTaskStore.clear();
    setOpen(false);
  }

  return (
    <div className="dl-wrap" ref={wrapRef}>
      <button
        className={`dl-btn ${hasTask ? `dl-${stateCls}` : ''}`}
        onClick={() => setOpen(!open)}
        title={hasTask ? (task.finished ? '导入任务已完成' : '查看导入进度') : '导入任务'}
        aria-label="导入任务"
      >
        <Icon name="download" size={18} className={task.active && !task.paused ? 'dl-spin' : ''} />
        {task.active && !task.finished && (
          <span className="dl-badge dl-badge-run">{task.paused ? '⏸' : `${pct}%`}</span>
        )}
        {task.finished && (
          <span className={`dl-badge ${hasFail ? 'dl-badge-warn' : 'dl-badge-done'}`}>
            {hasFail ? task.failed : <Icon name="check" size={10} />}
          </span>
        )}
      </button>

      {open && (
        <div className="dl-panel">
          <div className="dl-panel-head">
            <span className="dl-panel-title"><Icon name="download" size={15} /> 导入任务</span>
            {hasTask && (
              <button className="dl-panel-clear" onClick={() => importTaskStore.clear()} title="清除记录">
                <Icon name="close" size={13} />
              </button>
            )}
          </div>

          {!hasTask ? (
            <div className="dl-empty">
              <Icon name="download" size={26} />
              <span>暂无导入任务</span>
              <small>在线来源导入漫画 / 小说时，进度会显示在这里</small>
            </div>
          ) : (
            <div className={`dl-task itb-${stateCls}`}>
              <div className="dl-task-top">
                {ctx?.cover ? (
                  <div className="dl-cover"><img src={taskCover(ctx.sourceId, ctx.cover)} alt="" /></div>
                ) : (
                  <div className="dl-cover dl-cover-ph"><Icon name="download" size={18} /></div>
                )}
                <div className="dl-task-info">
                  <div className="dl-task-title" title={ctx?.title}>{ctx?.title || '导入任务'}</div>
                  <div className="dl-task-source">
                    <span className="dl-source-tag">{ctx?.sourceName || '在线来源'}</span>
                    {!task.finished && task.paused && <span className="dl-state-tag dl-paused">已暂停</span>}
                    {task.finished && (
                      <span className={`dl-state-tag ${hasFail ? 'dl-warn' : 'dl-done'}`}>
                        {hasFail ? '部分失败' : '已完成'}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="dl-task-detail">
                {task.label || (task.finished
                  ? (hasFail ? `成功 ${task.done} 话 · 失败 ${task.failed} 话` : `共 ${task.done} 话已全部导入`)
                  : '')}
              </div>

              <div className="dl-progress">
                <span className="dl-bar"><span className="dl-bar-fill" style={{ width: `${pct}%` }} /></span>
                <span className="dl-pct">{pct}%</span>
              </div>
              <div className="dl-stats">
                <span>已完成 <b>{task.done}</b> / {task.total} 话</span>
                {hasFail && <span className="dl-fail">失败 {task.failed}</span>}
              </div>

              <div className="dl-actions">
                {!task.finished ? (
                  <button className="dl-act" onClick={() => importTaskStore.setPaused(!task.paused)}>
                    <Icon name={task.paused ? 'play' : 'menu'} size={13} />
                    {task.paused ? '继续' : '暂停'}
                  </button>
                ) : task.comicId ? (
                  <button className="dl-act dl-act-primary" onClick={viewComic}>
                    <Icon name="book" size={13} /> 查看
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
