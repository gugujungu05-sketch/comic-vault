import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** 生成分享链接二维码（本地生成，不依赖任何外部服务） */
export function QrCode({ text, size = 168, id }: { text: string; size?: number; id?: string }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(text, {
      width: size * 2,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f1115', light: '#ffffff' },
    })
      .then((data) => {
        if (alive) setUrl(data);
      })
      .catch((err) => {
        if (alive) setError(String(err?.message || err));
      });
    return () => {
      alive = false;
    };
  }, [text, size]);

  if (error) return <div style={{ fontSize: 12, color: 'var(--danger)' }}>二维码生成失败：{error}</div>;
  if (!url) {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: 'grid',
          placeItems: 'center',
          background: '#fff',
          borderRadius: 8,
          color: '#888',
          fontSize: 12,
        }}
      >
        生成中…
      </div>
    );
  }

  return (
    <img
      id={id}
      src={url}
      alt="分享二维码"
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: 8, background: '#fff', padding: 4 }}
    />
  );
}
