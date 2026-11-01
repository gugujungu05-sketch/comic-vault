import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { QrCode } from './QrCode';
import { api } from '../lib/api';
import type { Chapter, ComicSummary, ShareLog } from '../types';
import { copyText, formatDate, withShareCode } from '../lib/util';
import { useErrorToast, useToast } from './Toasts';

export function ShareDialog({
  comic,
  chapters = [],
  onClose,
  onChanged,
}: {
  comic: ComicSummary;
  chapters?: Chapter[];
  onClose: () => void;
  onChanged: (share: ComicSummary['share']) => void;
}) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const [enabled, setEnabled] = useState(comic.share?.enabled ?? false);
  const [allowDownload, setAllowDownload] = useState(comic.share?.allowDownload ?? true);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [expires, setExpires] = useState('0');
  const [saving, setSaving] = useState(false);
  const [share, setShare] = useState(comic.share);
  const [tab, setTab] = useState<'link' | 'chapters' | 'logs'>('link');
  const [scope, setScope] = useState<'all' | 'part'>(
    comic.share?.chapterIds?.length ? 'part' : 'all',
  );
  const [selected, setSelected] = useState<string[]>(() =>
    comic.share?.chapterIds?.length ? comic.share.chapterIds : [],
  );
  const [logs, setLogs] = useState<ShareLog[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);

  useEffect(() => {
    if (comic.share?.expiresAt) {
      const days = Math.ceil((comic.share.expiresAt - Date.now()) / 86400000);
      setExpires(days > 0 ? String(Math.min(days, 365)) : '0');
    }
  }, [comic.share]);

  const link = share?.token ? withShareCode(`${window.location.origin}/s/${share.token}`) : '';

  async function loadLogs() {
    try {
      const res = await api.shareLogs(comic.id);
      setLogs(res.logs);
      setLogsLoaded(true);
    } catch (err) {
      errorToast(err, '读取访问记录失败');
    }
  }

  useEffect(() => {
    if (tab === 'logs' && !logsLoaded) loadLogs();
  }, [tab, logsLoaded]);

  async function save(next?: Partial<{ enabled: boolean }>, opts?: { close?: boolean }) {
    setSaving(true);
    try {
      const updated = await api.setShare(comic.id, {
        enabled: next?.enabled ?? enabled,
        allowDownload,
        password: clearPassword ? '' : password || undefined,
        expiresInDays: Number(expires),
        chapterIds: scope === 'all' ? [] : selected,
      });
      setShare(updated);
      onChanged(updated);
      setPassword('');
      setClearPassword(false);
      setLogsLoaded(false);
      toast('分享设置已保存');
      if (opts?.close) onClose();
    } catch (err) {
      errorToast(err, '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    if (!link) return;
    const ok = await copyText(link);
    toast(ok ? '链接已复制' : '复制失败，请手动选择复制', ok ? 'ok' : 'err');
  }

  async function revoke() {
    if (!confirm('吊销后旧链接将立即失效，并生成一条新链接。继续？')) return;
    try {
      const updated = await api.rotateShare(comic.id);
      setShare(updated);
      onChanged(updated);
      setLogsLoaded(false);
      toast('已吊销旧链接并生成新链接');
    } catch (err) {
      errorToast(err, '吊销失败');
    }
  }

  async function clearLogs() {
    try {
      await api.clearShareLogs(comic.id);
      setLogs([]);
      toast('访问记录已清空');
    } catch (err) {
      errorToast(err, '清空失败');
    }
  }

  function downloadQr() {
    const img = document.getElementById('cv-share-qr') as HTMLImageElement | null;
    if (!img?.src) return;
    const a = document.createElement('a');
    a.href = img.src;
    a.download = `${comic.title}-分享二维码.png`;
    a.click();
  }

  const selectedCount = scope === 'all' ? chapters.length : selected.length;
  const selectedPages =
    scope === 'all'
      ? chapters.reduce((n, c) => n + c.pages.length, 0)
      : chapters.filter((c) => selected.includes(c.id)).reduce((n, c) => n + c.pages.length, 0);

  return (
    <Modal
      title="分享漫画"
      icon={<Icon name="share" />}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
          {share?.token && (
            <button className="btn danger ghost" onClick={revoke}>
              <Icon name="refresh" size={14} /> 吊销旧链接
            </button>
          )}
          <button className="btn primary" onClick={() => save(undefined, { close: true })} disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </>
      }
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 700 }}>开启分享链接</div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            任何人打开链接都能在线阅读，无需登录
          </div>
        </div>
        <button
          className={`switch ${enabled ? 'on' : ''}`}
          onClick={() => {
            const v = !enabled;
            setEnabled(v);
            save({ enabled: v });
          }}
          aria-label="开启分享"
        >
          <span className="knob" />
        </button>
      </div>

      <div className="row" style={{ gap: 6, marginTop: 4 }}>
        {(
          (chapters.length
            ? [
                ['link', '链接与二维码'],
                ['chapters', '分享范围'],
                ['logs', '访问记录'],
              ]
            : [
                ['link', '链接与二维码'],
                ['logs', '访问记录'],
              ]) as [typeof tab, string][]
        ).map(([k, label]) => (
          <button key={k} className={`chip ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)} type="button">
            {label}
          </button>
        ))}
      </div>

      {tab === 'link' && (
        <>
          {share?.token ? (
            <>
              <div className="share-box">
                <Icon name="link" size={16} />
                <span className="url">{link}</span>
                <button className="btn sm" onClick={copy}>
                  <Icon name="copy" size={14} /> 复制
                </button>
                <a className="btn sm" href={link} target="_blank" rel="noreferrer">
                  <Icon name="eye" size={14} /> 打开
                </a>
              </div>
              {!enabled && (
                <div style={{ color: 'var(--warn)', fontSize: 12 }}>当前分享已关闭，链接暂时无法访问。</div>
              )}

              <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
                <div>
                  <QrCode text={link} size={148} id="cv-share-qr" />
                  <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={downloadQr}>
                    <Icon name="download" size={13} /> 保存二维码
                  </button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.9 }}>
                  <div>
                    已被访问 <b style={{ color: 'var(--text)' }}>{share.views || 0}</b> 次
                  </div>
                  <div>
                    {share.expiresAt
                      ? `有效期至 ${new Date(share.expiresAt).toLocaleString('zh-CN')}`
                      : '长期有效'}
                  </div>
                  <div>{share.hasPassword ? '需要访问密码' : '无访问密码'}</div>
                  <div>
                    分享范围：
                    {selectedCount === chapters.length || !chapters.length
                      ? '整本'
                      : `${selectedCount} / ${chapters.length} 话`}
                    （{selectedPages} 页）
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              还没有分享链接，打开上方开关即可生成。
            </div>
          )}

          <div className="grid-2">
            <div className="field">
              <label>有效期</label>
              <select className="select" value={expires} onChange={(e) => setExpires(e.target.value)}>
                <option value="0">长期有效</option>
                <option value="1">1 天</option>
                <option value="7">7 天</option>
                <option value="30">30 天</option>
                <option value="90">90 天</option>
              </select>
            </div>
            <div className="field">
              <label>访问密码（可选）</label>
              <input
                className="input"
                type="text"
                placeholder={share?.hasPassword ? '已设置，留空表示不变' : '留空表示无需密码'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setClearPassword(false);
                }}
              />
            </div>
          </div>

          {share?.hasPassword && (
            <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => { setClearPassword(true); setPassword(''); }}>
              清除已设置的密码
            </button>
          )}

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700 }}>允许访客下载</div>
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                关闭后访客只能在线阅读，无法导出 CBZ / ZIP / PDF / EPUB
              </div>
            </div>
            <button className={`switch ${allowDownload ? 'on' : ''}`} onClick={() => setAllowDownload(!allowDownload)} aria-label="允许下载">
              <span className="knob" />
            </button>
          </div>
        </>
      )}

      {tab === 'chapters' && (
        <>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            默认分享整本。也可以只挑选几话生成「试读链接」，访客只能看到被选中的章节。
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              className={`chip ${scope === 'all' ? 'active' : ''}`}
              onClick={() => setScope('all')}
              type="button"
            >
              整本（{chapters.length} 话）
            </button>
            <button
              className={`chip ${scope === 'part' ? 'active' : ''}`}
              onClick={() => {
                setScope('part');
                if (!selected.length) setSelected(chapters.slice(0, 1).map((c) => c.id));
              }}
              type="button"
            >
              指定章节
            </button>
            {scope === 'part' && (
              <>
                <button className="btn sm ghost" onClick={() => setSelected(chapters.map((c) => c.id))}>
                  全选
                </button>
                <button className="btn sm ghost" onClick={() => setSelected([])}>
                  清空
                </button>
              </>
            )}
          </div>

          {scope === 'part' && (
            <div className="file-list">
              {chapters.map((c) => (
                <div className="li" key={c.id}>
                  <button
                    className={`chip ${selected.includes(c.id) ? 'active' : ''}`}
                    onClick={() =>
                      setSelected((prev) =>
                        prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                      )
                    }
                    type="button"
                  >
                    <Icon name={selected.includes(c.id) ? 'check' : 'plus'} size={12} />
                  </button>
                  <span className="grow">{c.title}</span>
                  <span style={{ color: 'var(--muted)' }}>{c.pages.length} 页</span>
                </div>
              ))}
            </div>
          )}

          <button className="btn primary" onClick={() => save()} disabled={saving}>
            {saving ? '保存中…' : `保存分享范围（${selectedCount} 话）`}
          </button>
        </>
      )}

      {tab === 'logs' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              最近 200 条访问 / 下载记录（含时间、来源 IP、设备）
            </span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm ghost" onClick={loadLogs}>
                <Icon name="refresh" size={13} /> 刷新
              </button>
              <button className="btn sm ghost" onClick={clearLogs}>
                <Icon name="trash" size={13} /> 清空
              </button>
            </div>
          </div>
          {!logs.length ? (
            <div className="empty" style={{ padding: 18, color: 'var(--muted)', fontSize: 13 }}>
              暂无访问记录
            </div>
          ) : (
            <div className="file-list">
              {logs.map((l, i) => (
                <div className="li" key={`${l.ts}-${i}`}>
                  <span className={`chip ${l.event.startsWith('download') ? 'active' : ''}`}>
                    {l.event.startsWith('download') ? `下载 ${l.event.split(':')[1]?.toUpperCase() || ''}` : '阅读'}
                  </span>
                  <span className="grow" style={{ fontSize: 12 }}>{formatDate(l.ts)}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{l.ip || '未知来源'}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
