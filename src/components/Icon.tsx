import type { SVGProps } from 'react';

type IconName =
  | 'book'
  | 'plus'
  | 'upload'
  | 'download'
  | 'share'
  | 'settings'
  | 'search'
  | 'play'
  | 'trash'
  | 'edit'
  | 'close'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'folder'
  | 'image'
  | 'file'
  | 'lock'
  | 'star'
  | 'grid'
  | 'list'
  | 'check'
  | 'copy'
  | 'link'
  | 'zoom'
  | 'fullscreen'
  | 'menu'
  | 'spinner'
  | 'eye'
  | 'refresh'
  | 'tag';

const paths: Record<IconName, string> = {
  book: 'M4 5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V5Zm4 0v14',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  download: 'M12 4v12m0 0-4-4m4 4 4-4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 15V3m0 0-4 4m4-4 4 4',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a8 8 0 0 0-2.2-1.3L15 3H9l-.4 2.5a8 8 0 0 0-2.2 1.3l-2.3-1-2 3.4 2 1.5a8 8 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-1a8 8 0 0 0 2.2 1.3L9 21h6l.4-2.5a8 8 0 0 0 2.2-1.3l2.3 1 2-3.4-2-1.5c.07-.43.1-.86.1-1.3Z',
  search: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5',
  play: 'M7 4l12 8-12 8V4Z',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13',
  edit: 'M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Z',
  close: 'M6 6l12 12M18 6 6 18',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  image: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm4 11 3-4 3 4 2-2 3 3',
  file: 'M14 3v5h5M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z',
  lock: 'M6 11h12v9H6v-9Zm3 0V8a3 3 0 0 1 6 0v3',
  star: 'M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8L6.7 20l1-6L3.4 9.9 9.4 9 12 3.5Z',
  grid: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
  list: 'M4 6h16M4 12h16M4 18h16',
  check: 'M5 13l4 4L19 7',
  copy: 'M9 9V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4M5 9h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1m-2 7a5 5 0 0 1-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  zoom: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5M8 10h4m-2-2v4',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5m11-5v5h-5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  spinner: 'M12 3a9 9 0 1 0 9 9',
  eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  tag: 'M4 4h9l7 7-9 9-7-7V4Zm4 4h.01',
};

export function Icon({
  name,
  size = 18,
  className,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}
