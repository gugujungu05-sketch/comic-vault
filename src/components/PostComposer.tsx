import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { social } from '../lib/api';
import { useErrorToast, useToast } from './Toasts';
import { Icon } from './Icon';
import { EmojiPicker, EmojiSuggestions } from './EmojiKit';
import { formatBytes } from '../lib/util';
import type { ComicSummary, PlazaAttachment, PlazaBoard, Sticker, User } from '../types';

const ACCEPT = 'image/*,video/*,audio/*,.pdf,.zip,.cbz,.rar,.7z,.epub,.txt,.json';

export function PostComposer({
  user, boards, activeBoard, stickers, reloadStickers,
  autoSearch, onAutoSearchChange, onPublished,
}: {
  user: User | null;
  boards: PlazaBoard[];
  activeBoard: string;
  stickers: Sticker[];
  reloadStickers: () => Promise<void>;
  autoSearch: boolean;
  onAutoSearchChange: (v: boolean) => void;
  onPublished: () => Promise<void> | void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [content, setContent] = useState('');
  const [board, setBoard] = useState(activeBoard !== 'all' ? activeBoard : 'chat');
  const [comicId, setComicId] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [mine, setMine] = useState<ComicSummary[]>([]);
  const [attachments, setAttachments] = useState<PlazaAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [visibility, setVisibility] = useState<'public' | 'password'>('public');
  const [postPass, setPostPass] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeBoard !== 'all') setBoard(activeBoard);
  }, [activeBoard]);

  useEffect(() => {
    if (!user) return;
    fetch('/api/comics').then((r) => r.json()).then((d) => setMine(d.comics || [])).catch(() => {});
  }, [user?.id]);

  function requireLogin(): boolean {
    if (!user) {
      errorToast(new Error('登录后才能参与讨论'));
      navigate('/');
      return false;
    }
    return true;
  }

  /** 表情插入：把触发词从正文末尾移除，再追加表情内容 */
  function insertText(insert: string, term: string) {
    setContent((c) => {
      const base = term && c.endsWith(term) ? c.slice(0, -term.length) : c;
      return base + insert;
    });
  }

  async function upload(files: File[]) {
    if (!requireLogin() || !files.length) return;
    setUploading(true);
    try {
      const r = await social.uploadPlaza(files.map((f) => ({ blob: f, name: f.name })));
      setAttachments((prev) => [...prev, ...r.attachments].slice(0, 12));
      if (r.rejected?.length) toast(`已跳过 ${r.rejected.length} 个不支持的文件`);
    } catch (err) {
      errorToast(err, '上传附件失败');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function moveAtt(index: number, delta: number) {
    setAttachments((prev) => {
      const next = [...prev];
      const j = index + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }

  async function publish() {
    if (!requireLogin()) return;
    if (!content.trim() && !comicId && !attachments.length) {
      errorToast(new Error('写点什么，或添加图片 / 文件后再发吧'));
      return;
    }
    if (visibility === 'password' && !postPass.trim()) {
      errorToast(new Error('选择「密码可见」后请设置一个密码'));
      return;
    }
    setBusy(true);
    try {
      await social.createPost({
        content: content.trim(),
        comicId: comicId || undefined,
        shareUrl: shareUrl.trim() || undefined,
        board,
        attachments,
        visibility,
        password: visibility === 'password' ? postPass.trim() : undefined,
      });
      setContent('');
      setComicId('');
      setShareUrl('');
      setAttachments([]);
      setShowEmoji(false);
      setPostPass('');
      setVisibility('public');
      toast(visibility === 'password' ? '已发布（凭密码可见）' : '已发布到广场');
      await onPublished();
    } catch (err) {
      errorToast(err, '发布失败');
    } finally {
      setBusy(false);
    }
  }

  const selectableBoards = boards.filter((b) => b.id !== 'all');

  return (
    <div
      className={`post-composer ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        upload(Array.from(e.dataTransfer.files || []));
      }}
    >
      <div className="composer-top">
        <select
          className="select board-select"
          value={board}
          onChange={(e) => setBoard(e.target.value)}
          title="选择发帖分区"
        >
          {(selectableBoards.length ? selectableBoards : [{ id: 'chat', name: '综合讨论', icon: '💬', desc: '', count: 0 }])
            .map((b) => <option key={b.id} value={b.id}>{b.icon} {b.name}</option>)}
        </select>
        <span className="composer-hint">选择分区 · 可发图片 / 视频 / 文件 / 表情包</span>
      </div>

      <textarea
        className="input composer-text"
        rows={3}
        placeholder={user ? '今天想聊点什么？打字会自动推荐表情包…' : '登录后即可发帖讨论'}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onFocus={() => { if (!user) navigate('/'); }}
      />

      <EmojiSuggestions
        text={content}
        enabled={autoSearch}
        stickers={stickers}
        onPick={insertText}
        onDisable={() => onAutoSearchChange(false)}
      />

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a, i) => (
            <div className="composer-att" key={a.id}>
              {a.kind === 'image' ? <img src={a.url} alt={a.name} /> : (
                <span className="composer-att-icon"><Icon name={a.kind === 'video' ? 'play' : 'file'} size={20} /></span>
              )}
              <span className="composer-att-name" title={a.name}>{a.name}</span>
              <span className="composer-att-size">{formatBytes(a.size)}</span>
              <div className="composer-att-ops">
                <button type="button" title="前移" onClick={() => moveAtt(i, -1)} disabled={i === 0}>←</button>
                <button type="button" title="后移" onClick={() => moveAtt(i, 1)} disabled={i === attachments.length - 1}>→</button>
                <button type="button" title="移除" onClick={() => setAttachments((p) => p.filter((x) => x.id !== a.id))}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="composer-tools">
        <button className="btn sm ghost" onClick={() => fileRef.current?.click()} disabled={uploading}>
          <Icon name="image" size={15} /> {uploading ? '上传中…' : '图片 / 视频 / 文件'}
        </button>
        <button className="btn sm ghost" onClick={() => setShowEmoji((v) => !v)}>
          😀 表情包
        </button>
        <button
          className={`chip sm ${autoSearch ? 'active' : ''}`}
          onClick={() => onAutoSearchChange(!autoSearch)}
          title="打字时自动搜索并推荐表情包"
        >
          自动搜表情 {autoSearch ? '开' : '关'}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => upload(Array.from(e.target.files || []))}
        />
      </div>

      {showEmoji && (
        <div className="emoji-panel-wrap">
          <EmojiPicker
            user={user}
            stickers={stickers}
            reload={reloadStickers}
            autoSearch={autoSearch}
            onAutoSearchChange={onAutoSearchChange}
            onPick={insertText}
            onClose={() => setShowEmoji(false)}
          />
        </div>
      )}

      <div className="row wrap composer-bottom">
        {user && mine.length > 0 && (
          <select className="select" style={{ maxWidth: 220 }} value={comicId} onChange={(e) => setComicId(e.target.value)}>
            <option value="">不附带漫画</option>
            {mine.map((c) => <option key={c.id} value={c.id}>📚 {c.title}</option>)}
          </select>
        )}
        <input
          className="input"
          style={{ flex: 1, minWidth: 180 }}
          placeholder="或粘贴一个分享链接（可选）"
          value={shareUrl}
          onChange={(e) => setShareUrl(e.target.value)}
        />
        <select
          className="select"
          style={{ maxWidth: 130 }}
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as 'public' | 'password')}
          title="谁可以看到这条帖子"
        >
          <option value="public">🔓 所有人可见</option>
          <option value="password">🔒 密码可见</option>
        </select>
        {visibility === 'password' && (
          <input
            className="input"
            style={{ maxWidth: 150 }}
            type="password"
            placeholder="可见密码"
            value={postPass}
            onChange={(e) => setPostPass(e.target.value)}
          />
        )}
        <button className="btn primary" onClick={publish} disabled={busy || uploading}>
          <Icon name="message" size={15} /> {busy ? '发布中…' : '发布'}
        </button>
      </div>
    </div>
  );
}
