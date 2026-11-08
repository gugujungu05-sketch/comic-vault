import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';

/**
 * 圆形头像裁剪：拖动取景 + 滑杆缩放，输出 320×320 压缩 JPEG Blob。
 * 与桌面端裁剪体验一致；上传前先裁剪，避免头像偏斜或过大。
 */
export function AvatarCrop({
  src, onClose, onDone,
}: {
  src: string;
  onClose: () => void;
  onDone: (blob: Blob) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(100);
  const off = useRef({ x: 0, y: 0 });
  const drag = useRef<{ on: boolean; x: number; y: number }>({ on: false, x: 0, y: 0 });

  useEffect(() => {
    const img = new Image();
    img.onload = () => { imgRef.current = img; draw(); };
    img.src = src;
  }, [src]);

  function draw() {
    const cv = canvasRef.current;
    const img = imgRef.current;
    if (!cv || !img) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const s = scale / 100;
    const fit = Math.max(320 / img.width, 320 / img.height);
    const w = img.width * fit * s;
    const h = img.height * fit * s;
    const cx = 160 + off.current.x;
    const cy = 160 + off.current.y;
    ctx.clearRect(0, 0, 320, 320);
    // 先铺满整张画布：输出改为 JPEG 后圆外区域不会变成黑块
    ctx.fillStyle = '#10151c';
    ctx.fillRect(0, 0, 320, 320);
    ctx.save();
    ctx.beginPath();
    ctx.arc(160, 160, 160, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    ctx.restore();
  }

  useEffect(() => { draw(); }, [scale]);

  return (
    <Modal title="裁剪头像" icon={<Icon name="user" />} onClose={onClose} width={420}
      footer={<>
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={() => {
          const cv = canvasRef.current;
          if (!cv) return;
          // 输出压缩 JPEG：320×320 通常 20~40KB，比 PNG 小一个数量级，
          // 经隧道上传与后续加载都明显更快（头像不需要透明通道）。
          cv.toBlob((b) => { if (b) onDone(b); }, 'image/jpeg', 0.9);
        }}>使用这张</button>
      </>}>
      <div style={{ display: 'grid', placeItems: 'center' }}>
        <canvas
          ref={canvasRef} width={320} height={320}
          style={{
            borderRadius: '50%', maxWidth: '100%', touchAction: 'none', cursor: 'grab',
            boxShadow: '0 0 0 1px var(--line), 0 8px 28px rgba(0,0,0,.45)',
          }}
          onPointerDown={(e) => {
            drag.current = { on: true, x: e.clientX, y: e.clientY };
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current.on) return;
            off.current.x = Math.max(-320, Math.min(320, off.current.x + e.clientX - drag.current.x));
            off.current.y = Math.max(-320, Math.min(320, off.current.y + e.clientY - drag.current.y));
            drag.current.x = e.clientX;
            drag.current.y = e.clientY;
            draw();
          }}
          onPointerUp={() => { drag.current.on = false; }}
        />
        <p className="muted sm-text" style={{ margin: '8px 0 0' }}>在图上拖动调整位置，滑杆缩放</p>
        <input
          type="range" min={30} max={300} value={scale} style={{ width: '100%', marginTop: 8 }}
          onChange={(e) => setScale(Number(e.target.value))}
        />
      </div>
    </Modal>
  );
}
