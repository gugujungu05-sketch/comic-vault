import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useErrorToast, useToast } from '../components/Toasts';
import { sources as sourcesApi } from '../lib/api';
import type { SourceChapterItem, SourceInfo, SourceSearchItem } from '../lib/api';

export default function SourcesPage() {
  const [list, setList] = useState<SourceInfo[]>([]);
  const [activeId, setActiveId] = useState('');
  const [kw, setKw] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SourceSearchItem[]>([]);
  const [detail, setDetail] = useState<{
    title: string;
    cover: string;
    url: string;
    chapters: SourceChapterItem[];
    checked: Set<number>;
  } | null>(null);
  const [importing, setImporting] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [importedComicId, setImportedComicId] = useState('');
  const [showManage, setShowManage] = useState(false);
  const toast = useToast();
  const errorToast = useErrorToast();

  const active = list.find((s) => s.id === activeId) || null;

  async function load() {
    try {
      const r = await sourcesApi.list();
      setList(r.sources);
      if (!activeId && r.sources.length) setActiveId(r.sources[0].id);
    } catch (err) {
      errorToast(err, '加载书源失败');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doSearch() {
    if (!active || !kw.trim()) return;
    setSearching(true);
    setResults([]);
    try {
      const r = await sourcesApi.search(active.id, kw.trim());
      setResults(r.items);
      if (!r.items.length) toast('没有搜到结果，试试别的关键词或检查书源规则');
    } catch (err) {
      errorToast(err, '搜索失败');
    } finally {
      setSearching(false);
    }
  }

  async function openComic(item: SourceSearchItem) {
    if (!active) return;
    setSearching(true);
    try {
      const r = await sourcesApi.comic(active.id, item.link);
      setDetail({ ...r, url: item.link, checked: new Set(r.chapters.map((_, i) => i)) });
    } catch (err) {
      errorToast(err, '读取章节失败');
    } finally {
      setSearching(false);
    }
  }

  async function importChapters() {
    if (!active || !detail) return;
    const picked = detail.chapters.filter((_, i) => detail.checked.has(i));
    if (!picked.length) return toast('请先勾选要导入的章节');
    setImporting({ done: 0, total: picked.length, failed: 0 });
    let comicId = '';
    let failed = 0;
    for (const ch of picked) {
      try {
        const r = await sourcesApi.importChapter({
          comicId: comicId || undefined,
          sourceId: active.id,
          sourceName: active.name,
          title: detail.title,
          cover: detail.cover,
          comicUrl: detail.url,
          chapterTitle: ch.title,
          chapterUrl: ch.url,
        });
        if (!comicId) {
          comicId = r.comicId;
          setImportedComicId(r.comicId);
        }
      } catch {
        failed++;
      }
      setImporting({ done: (comicId ? picked.indexOf(ch) + 1 : 0), total: picked.length, failed });
    }
    toast(`导入完成：成功 ${picked.length - failed} 话${failed ? `，失败 ${failed} 话` : ''}`);
  }

  return (
    <main className="page">
      <div className="page-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1>在线来源</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            配置书源规则，从漫画站搜索并导入到你的书库（只导入你手动挑选的内容）
          </p>
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          <button className="btn" onClick={() => setShowManage(true)}>
            <Icon name="settings" size={16} /> 书源管理
          </button>
        </div>
      </div>

      {/* 书源选择 */}
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {list.map((s) => (
          <button
            key={s.id}
            className={`btn sm ${s.id === activeId ? 'primary' : ''}`}
            onClick={() => {
              setActiveId(s.id);
              setResults([]);
              setDetail(null);
            }}
          >
            <Icon name="globe" size={14} /> {s.name}
          </button>
        ))}
        {!list.length && <span className="muted">还没有书源，点右上角「书源管理」添加一个</span>}
      </div>

      {/* 搜索 */}
      <div className="row" style={{ gap: 8, marginBottom: 18 }}>
        <input
          className="input"
          style={{ maxWidth: 420 }}
          placeholder="输入漫画名搜索…"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
        />
        <button className="btn primary" onClick={doSearch} disabled={searching || !active}>
          {searching ? <Icon name="spinner" size={16} className="spin" /> : <Icon name="search" size={16} />}
          搜索
        </button>
      </div>

      {/* 搜索结果 */}
      {!!results.length && !detail && (
        <div className="comic-grid">
          {results.map((r, i) => (
            <div key={i} className="comic-card" style={{ cursor: 'pointer' }} onClick={() => openComic(r)}>
              <div className="cover">
                {r.cover ? (
                  <img src={r.cover} alt={r.title} loading="lazy" />
                ) : (
                  <div className="cover-empty">
                    <Icon name="book" size={30} />
                  </div>
                )}
              </div>
              <div className="card-body">
                <div className="card-title">{r.title}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 详情 + 章节 + 导入 */}
      {detail && (
        <div className="panel" style={{ marginTop: 4 }}>
          <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            {detail.cover && (
              <img
                src={detail.cover}
                alt=""
                style={{ width: 120, borderRadius: 10, flex: 'none' }}
              />
            )}
            <div style={{ flex: 1, minWidth: 220 }}>
              <h2 style={{ margin: '0 0 8px' }}>{detail.title}</h2>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn sm" onClick={() => setDetail(null)}>
                  ← 返回搜索
                </button>
                <button
                  className="btn sm"
                  onClick={() =>
                    setDetail((d) =>
                      d ? { ...d, checked: new Set(d.chapters.map((_, i) => i)) } : d,
                    )
                  }
                >
                  全选
                </button>
                <button className="btn sm" onClick={() => setDetail((d) => (d ? { ...d, checked: new Set() } : d))}>
                  清空
                </button>
                <span className="muted">已选 {detail.checked.size} / {detail.chapters.length} 话</span>
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className="btn primary"
                  onClick={importChapters}
                  disabled={!!importing || !detail.checked.size}
                >
                  <Icon name="download" size={16} />
                  {importing ? `导入中 ${importing.done}/${importing.total}…` : '导入选中章节到书库'}
                </button>
                {importedComicId && (
                  <Link className="btn" to={`/comic/${importedComicId}`}>
                    查看已导入的漫画
                  </Link>
                )}
              </div>
              {importing && (
                <div className="progress-mini" style={{ marginTop: 10, maxWidth: 420 }}>
                  <i style={{ width: `${Math.round((importing.done / importing.total) * 100)}%` }} />
                </div>
              )}
            </div>
          </div>

          <div
            className="chapter-list"
            style={{ marginTop: 16, maxHeight: 380, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}
          >
            {detail.chapters.map((ch, i) => (
              <label
                key={i}
                className="chapter-item"
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}
              >
                <input
                  type="checkbox"
                  checked={detail.checked.has(i)}
                  onChange={() =>
                    setDetail((d) => {
                      if (!d) return d;
                      const next = new Set(d.checked);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return { ...d, checked: next };
                    })
                  }
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.title}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {!results.length && !detail && !searching && (
        <div className="empty">
          <h3>从漫画站搬漫画</h3>
          <p>选一个书源 → 搜索漫画 → 勾选章节 → 一键导入到书库，之后就能离线阅读。</p>
        </div>
      )}

      {showManage && (
        <SourceManager
          list={list}
          onClose={() => setShowManage(false)}
          onChanged={() => {
            setList([]);
            setActiveId('');
            load();
          }}
        />
      )}
    </main>
  );
}

/* ------------------------------ 书源管理弹窗 ------------------------------ */
function SourceManager({
  list,
  onClose,
  onChanged,
}: {
  list: SourceInfo[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [rulesText, setRulesText] = useState(
    JSON.stringify(
      {
        search: { url: '/search?q={kw}', item: '.item', title: '.title@text', link: 'a@href', cover: 'img@src|data-src' },
        comic: { title: 'h1@text', cover: '.cover img@src|data-src', chapterItem: '.chapter a', chapterTitle: '@text', chapterLink: '@href' },
        chapter: { image: '.content img@src|data-src|data-original', nextPage: 'a:contains("下一页")@href' },
      },
      null,
      2,
    ),
  );
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const errorToast = useErrorToast();

  async function save() {
    let rules: Record<string, Record<string, string>>;
    try {
      rules = JSON.parse(rulesText);
    } catch {
      return toast('规则不是合法 JSON', 'err');
    }
    setBusy(true);
    try {
      await sourcesApi.save({ name, baseUrl, rules });
      toast('书源已保存');
      setName('');
      setBaseUrl('');
      onChanged();
    } catch (err) {
      errorToast(err, '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="书源管理" icon={<Icon name="globe" />} onClose={onClose} width={640}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>关闭</button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim() || !baseUrl.trim()}>
            保存书源
          </button>
        </>
      }>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        每个书源就是一份解析规则（选择器写法：<code>.thumb img@data-src</code> 取属性，<code>@text</code> 取文本，<code>|</code> 列多个兜底）。
        抓取仅用于把你手动挑选的漫画下载进自己的书库。
      </p>
      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>书源名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：某漫画站" />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>站点地址</label>
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com" />
        </div>
      </div>
      <div className="field">
        <label>解析规则（JSON）</label>
        <textarea className="input" rows={12} value={rulesText} onChange={(e) => setRulesText(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} />
      </div>
      {!!list.filter((s) => !s.builtin).length && (
        <div className="field">
          <label>自定义书源</label>
          {list
            .filter((s) => !s.builtin)
            .map((s) => (
              <div key={s.id} className="row" style={{ gap: 8, marginBottom: 6 }}>
                <span style={{ flex: 1 }}>{s.name} <span className="muted">（{s.baseUrl}）</span></span>
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      await sourcesApi.remove(s.id);
                      toast('已删除');
                      onChanged();
                    } catch (err) {
                      errorToast(err, '删除失败');
                    }
                  }}
                >
                  删除
                </button>
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}
