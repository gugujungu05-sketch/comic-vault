import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import type { ComicSummary } from '../types';

export function ComicCard({
  comic,
  index,
  onToggleFavorite,
  onShare,
}: {
  comic: ComicSummary;
  index: number;
  onToggleFavorite: (id: string, next: boolean) => void;
  onShare: (comic: ComicSummary) => void;
}) {
  const progressPct =
    comic.progress && comic.pageCount ? Math.round(((comic.progress.pageIndex + 1) / comic.pageCount) * 100) : 0;

  return (
    <div className="comic-card" style={{ animationDelay: `${Math.min(index, 20) * 30}ms` }}>
      <Link to={`/comic/${comic.id}`} style={{ display: 'block' }}>
        <div className="cover">
          {comic.coverUrl ? (
            <img src={comic.coverUrl} alt={comic.title} loading="lazy" />
          ) : (
            <div className="cover-empty">
              <Icon name="book" size={30} />
            </div>
          )}
          <div className="cover-badge">
            <span className="badge">{comic.chapterCount} 话</span>
            {comic.share?.enabled && <span className="badge accent">分享中</span>}
            {comic.status === 'completed' && <span className="badge ok">完结</span>}
          </div>
          <button
            className={`card-fav ${comic.favorite ? 'on' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              onToggleFavorite(comic.id, !comic.favorite);
            }}
            aria-label="收藏"
          >
            <Icon name="star" size={14} fill={comic.favorite ? 'currentColor' : 'none'} />
          </button>
        </div>
        <div className="card-body">
          <div className="card-title">{comic.title}</div>
          <div className="card-meta">
            <span>{comic.pageCount} 页</span>
            {comic.author && <span>{comic.author}</span>}
            {comic.direction === 'rtl' && <span>日漫顺序</span>}
          </div>
          {progressPct > 0 && (
            <div className="progress-mini" title={`已读 ${progressPct}%`}>
              <i style={{ width: `${Math.min(100, progressPct)}%` }} />
            </div>
          )}
        </div>
      </Link>
      <div style={{ position: 'absolute', right: 8, bottom: 10, display: 'flex', gap: 6 }}>
        <Link className="btn sm" to={`/read/${comic.id}`} title="开始阅读">
          <Icon name="play" size={14} />
        </Link>
        <button
          className="btn sm"
          onClick={() => onShare(comic)}
          title="分享"
        >
          <Icon name="share" size={14} />
        </button>
      </div>
    </div>
  );
}
