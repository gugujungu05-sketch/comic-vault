import { useCallback, useEffect, useMemo, useState } from 'react';
import { social } from '../lib/api';
import { emojiMark, filterEmojis, plazaMediaUrl, searchEmojis } from '../lib/emojis';
import { useErrorToast, useToast } from './Toasts';
import type { Sticker, User } from '../types';

/** 「打字自动搜索表情包」开关，偏好保存在本机，可随时关闭 */
export function useEmojiPreference() {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cv-emoji-auto') !== 'off';
    } catch {
      return true;
    }
  });
  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    try {
      localStorage.setItem('cv-emoji-auto', v ? 'on' : 'off');
    } catch {
      /* 隐私模式忽略 */
    }
  }, []);
  return { enabled, setEnabled };
}

/** 自定义表情包列表，广场页统一加载一次，供输入框、候选条和面板共用 */
export function useStickers() {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const reload = useCallback(async () => {
    try {
      const r = await social.emojis();
      setStickers(r.emojis);
    } catch {
      /* 未加载成功时保持空列表，不影响发帖 */
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { stickers, reload };
}

export interface EmojiPick {
  insert: string;
  /** 触发词，插入时从正文末尾移除 */
  term: string;
}

/** 打字时自动出现在输入框下方的表情候选条 */
export function EmojiSuggestions({
  text, enabled, stickers, onPick, onDisable,
}: {
  text: string;
  enabled: boolean;
  stickers: Sticker[];
  onPick: (insert: string, term: string) => void;
  onDisable: () => void;
}) {
  const list = useMemo(
    () => (enabled ? searchEmojis(text, stickers) : []),
    [text, enabled, stickers],
  );
  if (!enabled || !list.length) return null;
  return (
    <div className="emoji-suggestions">
      <span className="emoji-suggest-label">猜你想发</span>
      {list.map((c) => (
        <button
          key={c.key}
          type="button"
          className="emoji-suggest-item"
          title={`插入「${c.label}」`}
          onClick={() => onPick(c.insert, c.term)}
        >
          {c.image ? <img src={c.image} alt={c.label} /> : <span>{c.char}</span>}
        </button>
      ))}
      <button type="button" className="emoji-suggest-off" onClick={onDisable} title="关闭打字自动搜索表情包">
        关闭自动搜索 ×
      </button>
    </div>
  );
}

function AddEmojiForm({ reload }: { reload: () => Promise<void> }) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file || !name.trim()) {
      errorToast(new Error('请选择一张图片并填写名称'));
      return;
    }
    setBusy(true);
    try {
      const r = await social.uploadPlaza([{ blob: file, name: file.name }]);
      const url = r.attachments[0]?.url;
      if (!url) throw new Error('图片上传失败');
      await social.addEmoji({ name: name.trim(), tags, url });
      setFile(null);
      setName('');
      setTags('');
      toast('表情包已添加');
      await reload();
    } catch (err) {
      errorToast(err, '添加表情包失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="emoji-add">
      <div className="emoji-add-title">添加表情包（图片，GIF 也可以）</div>
      <div className="row wrap" style={{ gap: 8 }}>
        <label className="btn sm ghost emoji-file-btn">
          {file ? file.name : '选择图片'}
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <input
          className="input"
          style={{ flex: 1, minWidth: 110 }}
          placeholder="名称，如：捧腹大笑"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          style={{ flex: 1, minWidth: 110 }}
          placeholder="搜索词，逗号分隔（可选）"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <button className="btn sm primary" onClick={submit} disabled={busy}>
          {busy ? '上传中…' : '添加'}
        </button>
      </div>
      <div className="emoji-add-hint">名称与搜索词会用于「打字自动搜索」；只能删除自己添加的表情包。</div>
    </div>
  );
}

/** 完整表情包面板：内置表情 + 自定义表情包 + 添加 + 自动搜索开关 */
export function EmojiPicker({
  user, stickers, reload, autoSearch, onAutoSearchChange, onPick, onClose,
}: {
  user: User | null;
  stickers: Sticker[];
  reload: () => Promise<void>;
  autoSearch: boolean;
  onAutoSearchChange: (v: boolean) => void;
  onPick: (insert: string, term: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const [tab, setTab] = useState<'builtin' | 'custom' | 'gif'>('builtin');
  const [q, setQ] = useState('');
  const { builtin, custom } = useMemo(() => filterEmojis(q, stickers), [q, stickers]);
  const [gifs, setGifs] = useState<{ id: string; desc: string; url: string; preview: string }[]>([]);
  const [gifBusy, setGifBusy] = useState(false);
  const [savingId, setSavingId] = useState('');

  /* GIF 页：输入关键词即搜（300ms 防抖） */
  useEffect(() => {
    if (tab !== 'gif') return;
    const term = q.trim();
    if (!term) { setGifs([]); return; }
    const t = setTimeout(async () => {
      setGifBusy(true);
      try {
        const r = await social.searchGifs(term);
        setGifs(r.gifs || []);
      } catch { /* 搜索失败保持空 */ }
      finally { setGifBusy(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q, tab]);

  async function pickGif(g: { id: string; url: string; desc: string }) {
    if (!user) { errorToast(new Error('登录后才能把 GIF 收进表情包')); return; }
    setSavingId(g.id);
    try {
      await social.saveGif(g.url, q.trim().slice(0, 20) || 'gif');
      toast('GIF 已收进表情包');
      await reload();
      onPick(emojiMark(String(g.url).split('/').pop() || ''), '');
    } catch (err) {
      errorToast(err, '收藏 GIF 失败');
    } finally {
      setSavingId('');
    }
  }

  async function del(id: string) {
    try {
      await social.deleteEmoji(id);
      toast('已删除表情包');
      await reload();
    } catch (err) {
      errorToast(err, '删除失败');
    }
  }

  return (
    <div className="emoji-panel">
      <div className="emoji-panel-head">
        <b>表情包</b>
        <input
          className="input sm-input"
          placeholder="搜索表情…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="emoji-toggle" title="打字时自动在输入框下方推荐表情">
          <input
            type="checkbox"
            checked={autoSearch}
            onChange={(e) => onAutoSearchChange(e.target.checked)}
          />
          打字自动搜索
        </label>
        <button className="btn sm ghost" onClick={onClose} aria-label="关闭">×</button>
      </div>

      <div className="emoji-tabs">
        <button className={tab === 'builtin' ? 'active' : ''} onClick={() => setTab('builtin')}>
          内置表情
        </button>
        <button className={tab === 'custom' ? 'active' : ''} onClick={() => setTab('custom')}>
          图片表情包 ({stickers.length})
        </button>
        <button className={tab === 'gif' ? 'active' : ''} onClick={() => setTab('gif')}>
          GIF 斗图
        </button>
      </div>

      {tab === 'builtin' ? (
        <div className="emoji-grid">
          {builtin.map((e) => (
            <button
              key={e.char}
              type="button"
              className="emoji-builtin"
              title={e.name}
              onClick={() => onPick(e.char, '')}
            >
              {e.char}
            </button>
          ))}
          {!builtin.length && <div className="emoji-empty">没有匹配的表情</div>}
        </div>
      ) : tab === 'custom' ? (
        <>
          {user ? <AddEmojiForm reload={reload} /> : (
            <div className="emoji-empty">登录后即可添加自己的表情包</div>
          )}
          <div className="emoji-grid">
            {custom.map((s) => (
              <div className="emoji-cell" key={s.id}>
                <button type="button" title={s.name} onClick={() => onPick(emojiMark(s.file), '')}>
                  <img src={plazaMediaUrl(s.file)} alt={s.name} loading="lazy" />
                </button>
                <span className="emoji-cell-name">{s.name}</span>
                {user?.id === s.by && (
                  <button
                    type="button"
                    className="emoji-del"
                    title="删除自己添加的表情包"
                    onClick={() => del(s.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {!custom.length && <div className="emoji-empty">还没有图片表情包，添加一张吧</div>}
          </div>
        </>
      ) : null}
      {tab === 'gif' && (
        <>
          <div className="emoji-add-hint" style={{ padding: '0 10px' }}>
            输入关键词搜索 GIF 斗图表情；点一张即可收进表情包并插入（登录后可用）。
          </div>
          <div className="emoji-grid">
            {gifBusy && <div className="emoji-empty">搜索中…</div>}
            {!gifBusy && !q.trim() && <div className="emoji-empty">输入关键词，如：哈哈、猫、无语</div>}
            {!gifBusy && q.trim() && !gifs.length && <div className="emoji-empty">没有找到相关 GIF</div>}
            {gifs.map((g) => (
              <div className="emoji-cell" key={g.id}>
                <button type="button" title={g.desc} disabled={savingId === g.id} onClick={() => pickGif(g)}>
                  <img src={g.preview} alt={g.desc} loading="lazy" />
                </button>
                <span className="emoji-cell-name">{savingId === g.id ? '收藏中…' : g.desc}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
