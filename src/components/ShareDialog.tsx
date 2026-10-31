import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { api } from '../lib/api';
import type { ComicSummary } from '../types';
import { copyText } from '../lib/util';
import { useErrorToast, useToast } from './Toasts';

export function ShareDialog({
  comic,
  onClose,
  onChanged,
}: {
  comic: ComicSummary;
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

  useEffect(() => {
    if (comic.share?.expiresAt) {
      const days = Math.ceil((comic.share.expiresAt - Date.now()) / 86400000);
      setExpires(days > 0 ? String(Math.min(days, 365)) : '0');
    }
  }, [comic.share]);

  const link = share?.token ? `${window.location.origin}/s/${share.token}` : '';

  async function save(next?: Partial<{ enabled: boolean }>, opts?: { close?: boolean }) {
    setSaving(true);
    try {
      const updated = await api.setShare(comic.id, {
        enabled: next?.enabled ?? enabled,
        allowDownload,
        password: clearPassword ? '' : password || undefined,
        expiresInDays: Number(expires),
      });
      setShare(updated);
      onChanged(updated);
      setPassword('');
      setClearPassword(false);
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

  return (
    <Modal
      title="分享漫画"
      icon={<Icon name="share" />}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
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

      {share?.token && (
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
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            已被访问 {share.views || 0} 次
            {share.expiresAt ? ` · 有效期至 ${new Date(share.expiresAt).toLocaleString('zh-CN')}` : ' · 长期有效'}
            {share.hasPassword ? ' · 需要访问密码' : ''}
          </div>
        </>
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
    </Modal>
  );
}
