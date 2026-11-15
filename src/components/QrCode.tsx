import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** 生成分享链接二维码（本地生成，不依赖任何外部服务） */
export function QrCode({ text, size = 168, id }: { text: string; size?: number; id?: string }) {  const [url, setUrl] = useState('');
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

/** 导出参数：尺寸 × 格式（有的平台限制图片大小，需要小一点的 JPG） */
export type QrExportSize = 256 | 512 | 1024;
export type QrExportFormat = 'png' | 'jpg-high' | 'jpg-small';

export const QR_EXPORT_SIZES: { value: QrExportSize; label: string }[] = [
  { value: 512, label: '标准 512px' },
  { value: 1024, label: '高清 1024px' },
  { value: 256, label: '轻量 256px' },
];
export const QR_EXPORT_FORMATS: { value: QrExportFormat; label: string }[] = [
  { value: 'png', label: 'PNG 无损' },
  { value: 'jpg-high', label: 'JPG 高清' },
  { value: 'jpg-small', label: 'JPG 轻量' },
];

/** 按导出参数重新生成一张二维码 data URL。
 *  可识别性保证：留 2 模块静区、纠错等级 M（25% 容错）、
 *  JPG 质量不低于 0.82——这样任何档位都能被准确扫描。 */
export async function qrExportDataUrl(
  text: string,
  size: QrExportSize,
  format: QrExportFormat,
): Promise<string> {
  const jpeg = format !== 'png';
  return QRCode.toDataURL(text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#0f1115', light: '#ffffff' },
    type: jpeg ? 'image/jpeg' : 'image/png',
    rendererOpts: { quality: format === 'jpg-small' ? 0.82 : 0.92 },
  });
}
