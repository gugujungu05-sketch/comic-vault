import type { User } from '../types';

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
  if (user?.avatar) {
    return (
      <img
        className={`avatar ${size} ${className}`}
        src={user.avatar}
        alt={user.name}
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  return <span className={`avatar ${size} ${className}`}>{user ? user.name.slice(0, 1).toUpperCase() : '?'}</span>;
}
