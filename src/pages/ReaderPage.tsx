import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Comic } from '../types';
import { ReaderView } from '../components/ReaderView';
import { ExportDialog } from '../components/ExportDialog';
import { Icon } from '../components/Icon';
import { useErrorToast } from '../components/Toasts';

export function ReaderPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const errorToast = useErrorToast();
  const [comic, setComic] = useState<Comic | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!id) return;
    api
      .get(id)
      .then(setComic)
      .catch((err) => {
        errorToast(err, '加载失败');
        navigate('/');
      });
  }, [id]);

  if (!comic) {
    return (
      <div className="reader">
        <div className="empty" style={{ margin: 'auto', color: '#aaa' }}>
          <Icon name="spinner" size={26} className="spin" />
        </div>
      </div>
    );
  }

  const startChapter = params.get('chapter') || comic.progress?.chapterId || comic.chapters[0]?.id;
  const startPage = Number(params.get('page') || (startChapter === comic.progress?.chapterId ? comic.progress?.pageIndex ?? 0 : 0));

  return (
    <>
      <ReaderView
        title={comic.title}
        chapters={comic.chapters}
        direction={comic.direction}
        initialChapterId={startChapter}
        initialPageIndex={startPage}
        onProgress={(chapterId, pageIndex) => {
          api.setProgress(comic.id, chapterId, pageIndex).catch(() => {});
        }}
        onExit={() => navigate(`/comic/${comic.id}`)}
        headerExtra={
          <button className="btn sm ghost" onClick={() => setExporting(true)} title="保存到本地">
            <Icon name="download" size={15} />
          </button>
        }
      />
      {exporting && (
        <ExportDialog
          comicId={comic.id}
          comicTitle={comic.title}
          chapters={comic.chapters}
          onClose={() => setExporting(false)}
        />
      )}
    </>
  );
}
