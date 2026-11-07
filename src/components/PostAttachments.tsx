import { withCredential, formatBytes } from '../lib/util';
import { Icon } from './Icon';
import type { PlazaAttachment } from '../types';

/** 帖子附件展示：图片九宫格 / 视频 / 音频 / 文件下载卡片 */
export function PostAttachments({ attachments }: { attachments: PlazaAttachment[] }) {
  if (!attachments?.length) return null;
  const images = attachments.filter((a) => a.kind === 'image');
  const videos = attachments.filter((a) => a.kind === 'video');
  const audios = attachments.filter((a) => a.kind === 'audio');
  const files = attachments.filter((a) => a.kind === 'file');

  return (
    <div className="post-attachments">
      {images.length > 0 && (
        <div className={`post-image-grid count-${Math.min(images.length, 4)}`}>
          {images.map((a) => (
            <a key={a.id} href={a.url} target="_blank" rel="noreferrer" title={a.name}>
              <img src={a.url} alt={a.name} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {videos.map((a) => (
        <video key={a.id} className="post-media" controls preload="metadata" src={a.url}>
          您的浏览器不支持视频播放
        </video>
      ))}
      {audios.map((a) => (
        <div className="post-audio" key={a.id}>
          <span className="post-audio-name"><Icon name="play" size={13} /> {a.name}</span>
          <audio controls preload="metadata" src={a.url} />
        </div>
      ))}
      {files.map((a) => (
        <a
          key={a.id}
          className="post-file"
          href={withCredential(`${a.url}${a.url.includes('?') ? '&' : '?'}name=${encodeURIComponent(a.name)}`)}
          download={a.name}
        >
          <Icon name="file" size={18} />
          <span className="post-file-name">{a.name}</span>
          <span className="post-file-size">{formatBytes(a.size)}</span>
          <Icon name="download" size={15} />
        </a>
      ))}
    </div>
  );
}
