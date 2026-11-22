import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { importTaskStore } from '../lib/importTask';
import { Icon } from './Icon';

/** 全局导入任务栏：导入过程中/完成后悬浮显示，返回任何页面都能看到进度与结果。 */
export function ImportTaskBar() {
  const task = useSyncExternalStore(importTaskStore.subscribe, importTaskStore.getSnapshot);
  const navigate = useNavigate();
  if (!task.active && !task.finished) return null;

  const pct = task.total > 0 ? Math.min(100, Math.round((task.done / task.total) * 100)) : 0;

  return (
    <div className={`import-taskbar ${task.finished ? 'done' : ''}`} role="status" aria-live="polite">
      <button
        className="itb-main"
        onClick={() => navigate('/sources')}
        title="返回在线来源"
      >
        <span className="itb-icon">
          <Icon name={task.finished ? 'check' : 'spinner'} size={16} className={task.finished ? '' : 'spin'} />
        </span>
        <span className="itb-text">
          <span className="itb-title">
            {task.finished
              ? (task.failed > 0
                ? `导入完成：成功 ${task.done} 话，失败 ${task.failed} 话`
                : `导入完成：共 ${task.done} 话`)
              : (task.label || `正在导入 ${task.done}/${task.total}…`)}
          </span>
          {!task.finished && (
            <span className="itb-bar"><span className="itb-bar-fill" style={{ width: `${pct}%` }} /></span>
          )}
        </span>
      </button>
      {!task.finished && (
        <button
          className="itb-action"
          onClick={() => importTaskStore.setPaused(!task.paused)}
          title={task.paused ? '继续导入' : '暂停导入'}
        >
          {task.paused ? '▶ 继续' : '⏸ 暂停'}
        </button>
      )}
      {task.finished && task.comicId && (
        <button className="itb-action" onClick={() => { navigate(`/comic/${task.comicId}`); importTaskStore.clear(); }}>
          查看
        </button>
      )}
      {task.finished && (
        <button className="itb-close" onClick={() => importTaskStore.clear()} title="关闭" aria-label="关闭">
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
