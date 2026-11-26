import { useEffect, useState } from 'react';

/**
 * 封面图：加载失败（网络封锁 / 防盗链 403 / 代理 502）时不再显示破图小图标，
 * 而是显示带书名首字的渐变占位封面。src 变化时自动重置错误态。
 */
export default function CoverImage({
  src,
  title,
  className,
  style,
}: {
  src?: string;
  title: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);

  const label = String(title || '书').trim().slice(0, 1) || '书';
  // 依据书名生成稳定色相，让不同书占位封面颜色各异
  let hash = 0;
  for (let i = 0; i < String(title).length; i++) hash = (hash * 31 + String(title).charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;

  if (!src || failed) {
    return (
      <div
        className={`cover-empty cover-fallback${className ? ` ${className}` : ''}`}
        style={{
          background: `linear-gradient(145deg, hsl(${hue} 42% 34%), hsl(${(hue + 40) % 360} 45% 20%))`,
          ...style,
        }}
        title={title}
      >
        <span className="cover-fallback-char">{label}</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={title}
      loading="lazy"
      className={className}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}
