import { useEffect, useState } from 'react';
import type { User } from '../types';
import { absoluteUrl } from '../lib/api';

type AvatarUser = { name: string; avatar?: string | null };

export function Avatar({
  user,
  size = 'sm',
  className = '',
}: {
  user: AvatarUser | User | null;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}) {
  // 兜底：即便某个调用点拿到的是未经请求层处理的相对地址，这里也补全成可访问地址。
  // blob:/data: 是上传时的本地即时预览，absoluteUrl 会原样返回。
  const src = user?.avatar ? absoluteUrl(user.avatar) : '';
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);

  if (src && !failed) {
    return (
      <img
        className={`avatar ${size} ${className}`}
        src={src}
        alt={user?.name || ''}
        decoding="async"
        onError={() => setFailed(true)}
      />
    );
  }
  // 图片加载失败时回退字母头像，而不是把整个 <img> 隐藏掉（表现为「头像不显示」）
  return <span className={`avatar ${size} ${className}`}>{user ? user.name.slice(0, 1).toUpperCase() : '?'}</span>;
}
