import { useSyncExternalStore } from 'react';
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

/** 全局导入任务栏：导入过程中/完成后悬浮显示，返回任何页面都能看到进度与结果。 */
export function ImportTaskBar() {
  const task = useSyncExternalStore(importTaskStore.subscribe, importTaskStore.getSnapshot);
  const navigate = useNavigate();
  if (!task.active && !task.finished) return null;

  const ctx = task.ctx;
  const pct = task.total > 0 ? Math.min(100, Math.round((task.done / task.total) * 100)) : 0;
  const hasFail = task.failed > 0;
  const stateCls = task.finished ? (hasFail ? 'warn' : 'done') : task.paused ? 'paused' : 'running';

  return (
    <div className={`import-taskbar itb-${stateCls}`} role="status" aria-live="polite">
      {/* 封面缩略图（整本小说导入无 ctx.cover 时不显示） */}
      {ctx?.cover ? (
        <div className="itb-cover">
          <img src={taskCover(ctx.sourceId, ctx.cover)} alt="" loading="lazy" />
        </div>
      ) : (
        <div className="itb-cover itb-cover-ph">
          <Icon name="download" size={20} />
        </div>
      )}

      {/* 主体信息 */}
      <div className="itb-body">
        <div className="itb-topline">
          <span className="itb-badge">
            <Icon
              name={task.finished ? (hasFail ? 'refresh' : 'check') : task.paused ? 'play' : 'download'}
              size={11}
              className={!task.finished && !task.paused ? 'spin-slow' : ''}
            />
          </span>
          <span className="itb-source">{ctx?.sourceName || '在线来源'}</span>
          {!task.finished && task.paused && <span className="itb-paused-tag">已暂停</span>}
          {task.finished && <span className="itb-state-tag">{hasFail ? '部分失败' : '导入完成'}</span>}
          <button
            className="itb-close"
            onClick={() => importTaskStore.clear()}
            title="关闭"
            aria-label="关闭"
          >
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="itb-title" title={ctx?.title}>{ctx?.title || task.label || '导入任务'}</div>

        <div className="itb-detail">
          {task.label && !task.finished ? task.label : (
            task.finished
              ? (hasFail
                  ? `成功 ${task.done} 话 · 失败 ${task.failed} 话`
                  : `共 ${task.done} 话已全部导入`)
              : ''
          )}
        </div>

        <div className="itb-progress">
          <span className="itb-bar"><span className="itb-bar-fill" style={{ width: `${pct}%` }} /></span>
          <span className="itb-pct">{pct}%</span>
        </div>
      </div>

      {/* 操作区 */}
      <div className="itb-actions">
        {!task.finished ? (
          <button
            className="itb-action"
            onClick={() => importTaskStore.setPaused(!task.paused)}
            title={task.paused ? '继续导入' : '暂停导入'}
          >
            <Icon name={task.paused ? 'play' : 'menu'} size={13} />
            <span>{task.paused ? '继续' : '暂停'}</span>
          </button>
        ) : task.comicId ? (
          <button
            className="itb-action itb-action-primary"
            onClick={() => { navigate(`/comic/${task.comicId}`); importTaskStore.clear(); }}
          >
            <Icon name="book" size={13} />
            <span>查看</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
