import { useEffect, useRef, useState } from 'react';

/**
 * 封面图：加载失败（网络封锁 / 防盗链 403 / 代理 502）时不再显示破图小图标，
 * 而是显示带书名首字的渐变占位封面。src 变化时自动重置错误态。
 */
export default function CoverImage({
  src,
  title,
  className,
  style,
  onError,
}: {
  src?: string;
  title: string;
  className?: string;
  style?: React.CSSProperties;
  /** 图片加载失败时回调（可用于重新拉取源站封面后重试），仅调用一次由调用方控制 */
  onError?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const errRef = useRef(false);
  useEffect(() => { setFailed(false); errRef.current = false; }, [src]);

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
      onError={() => {
        setFailed(true);
        // 通知调用方尝试刷新封面（如书架临时签名 URL 过期）；只回调一次避免死循环
        if (onError && !errRef.current) { errRef.current = true; onError(); }
      }}
    />
  );
}
