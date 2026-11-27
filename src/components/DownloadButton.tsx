import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { importTaskStore, type ImportTask } from '../lib/importTask';
import { mediaUrl } from '../lib/api';
import { Icon } from './Icon';

/** 把在线来源封面转换成可访问的绝对地址（走图片代理，带源 id）。 */
function taskCover(sid: string | undefined, cover: string | undefined): string {
  if (!cover) return '';
  const key = String(sid || '').replace(/^js:/, '');
  if (!key) return mediaUrl(cover);
  return mediaUrl(`/api/online/img?sid=${encodeURIComponent(key)}&u=${encodeURIComponent(cover)}`);
}

function taskPct(t: ImportTask): number {
  return t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
}

/**
 * 浏览器式「下载」导航按钮：类似 Chrome 右上角下载键。
 * 平时只在顶栏显示一个图标，进行中显示进度角标、完成后显示完成角标；
 * 点击才弹出任务面板，不常驻悬浮、不遮挡内容。
 * 支持多个导入任务同时进行，每个任务独立进度 / 暂停 / 查看。
 */
export function DownloadButton() {
  const tasks = useSyncExternalStore(importTaskStore.subscribe, importTaskStore.getSnapshot);
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

  const running = tasks.filter((t) => t.active && !t.finished);
  const finished = tasks.filter((t) => t.finished);
  const hasTask = tasks.length > 0;
  // 角标：进行中优先显示任务数；否则显示已完成数
  const anyRunning = running.length > 0;
  const anyPaused = running.some((t) => t.paused);

  function viewComic(t: ImportTask) {
    if (t.comicId) navigate(`/comic/${t.comicId}`);
    importTaskStore.clear(t.id);
    setOpen(false);
  }

  return (
    <div className="dl-wrap" ref={wrapRef}>
      <button
        className={`dl-btn ${anyRunning ? 'dl-running' : finished.length ? 'dl-done' : ''}`}
        onClick={() => setOpen(!open)}
        title={anyRunning ? `${running.length} 个导入任务进行中` : finished.length ? '导入任务已完成' : '导入任务'}
        aria-label="导入任务"
      >
        <Icon name="download" size={18} className={anyRunning && !anyPaused ? 'dl-spin' : ''} />
        {anyRunning && (
          <span className="dl-badge dl-badge-run">{anyPaused ? '⏸' : running.length}</span>
        )}
        {!anyRunning && finished.length > 0 && (
          <span className="dl-badge dl-badge-done"><Icon name="check" size={10} /></span>
        )}
      </button>

      {open && (
        <div className="dl-panel">
          <div className="dl-panel-head">
            <span className="dl-panel-title"><Icon name="download" size={15} /> 导入任务{hasTask ? ` · ${tasks.length}` : ''}</span>
            {hasTask && (
              <button className="dl-panel-clear" onClick={() => importTaskStore.clearAll()} title="清除全部记录">
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
            <div className="dl-task-list">
              {tasks.map((t) => {
                const pct = taskPct(t);
                const hasFail = t.failed > 0;
                const ctx = t.ctx;
                const stateCls = t.finished ? (hasFail ? 'warn' : 'done') : t.paused ? 'paused' : 'running';
                return (
                  <div key={t.id} className={`dl-task itb-${stateCls}`}>
                    <div className="dl-task-top">
                      {ctx?.cover ? (
                        <div className="dl-cover"><img src={taskCover(ctx.sourceId, ctx.cover)} alt="" /></div>
                      ) : (
                        <div className="dl-cover dl-cover-ph"><Icon name="download" size={18} /></div>
                      )}
                      <div className="dl-task-info">
                        <div className="dl-task-title" title={ctx?.title}>{ctx?.title || t.label || '导入任务'}</div>
                        <div className="dl-task-source">
                          <span className="dl-source-tag">{ctx?.sourceName || '在线来源'}</span>
                          {!t.finished && t.paused && <span className="dl-state-tag dl-paused">已暂停</span>}
                          {t.finished && (
                            <span className={`dl-state-tag ${hasFail ? 'dl-warn' : 'dl-done'}`}>
                              {hasFail ? `部分失败 ${t.failed}` : '已完成'}
                            </span>
                          )}
                        </div>
                      </div>
                      <button className="dl-panel-clear dl-task-close" onClick={() => importTaskStore.clear(t.id)} title="移除此任务">
                        <Icon name="close" size={12} />
                      </button>
                    </div>

                    <div className="dl-task-detail">
                      {t.label || (t.finished
                        ? (hasFail ? `成功 ${t.done} 话 · 失败 ${t.failed} 话` : `共 ${t.done} 话已全部导入`)
                        : '')}
                    </div>

                    <div className="dl-progress">
                      <span className="dl-bar"><span className="dl-bar-fill" style={{ width: `${pct}%` }} /></span>
                      <span className="dl-pct">{pct}%</span>
                    </div>
                    <div className="dl-stats">
                      <span>已完成 <b>{t.done}</b> / {t.total} 话</span>
                      {hasFail && <span className="dl-fail">失败 {t.failed}</span>}
                    </div>

                    <div className="dl-actions">
                      {!t.finished ? (
                        <button className="dl-act" onClick={() => importTaskStore.setPaused(t.id, !t.paused)}>
                          <Icon name={t.paused ? 'play' : 'menu'} size={13} />
                          {t.paused ? '继续' : '暂停'}
                        </button>
                      ) : t.comicId ? (
                        <button className="dl-act dl-act-primary" onClick={() => viewComic(t)}>
                          <Icon name="book" size={13} /> 查看
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
