import { EMOJI_SPLIT_RE, EMOJI_MATCH_RE, plazaMediaUrl } from '../lib/emojis';

/** 渲染帖子/评论正文：普通文字 + 内嵌自定义表情包图片。inline 用于评论里跟在用户名后 */
export function RichText({
  text, className, inline = false,
}: { text: string; className?: string; inline?: boolean }) {
  if (!text) return null;
  const parts = text.split(EMOJI_SPLIT_RE);
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag className={className}>
      {parts.map((part, i) => {
        const m = part.match(EMOJI_MATCH_RE);
        if (m) {
          return (
            <img
              key={i}
              className="inline-emoji"
              src={plazaMediaUrl(m[1])}
              alt="表情包"
              loading="lazy"
            />
          );
        }
        return part;
      })}
    </Tag>
  );
}
