import type { SVGProps } from 'react';

export type IconName =
  | 'activity' | 'archive' | 'arrow-right' | 'bot' | 'chevron-down' | 'chevron-left'
  | 'chevron-right' | 'circle-gauge' | 'clipboard' | 'code' | 'copy' | 'edit'
  | 'eye' | 'git-branch' | 'home' | 'menu' | 'message' | 'moon' | 'more' | 'network'
  | 'paperclip' | 'panel-left' | 'play' | 'plus' | 'refresh' | 'search'
  | 'settings' | 'shield' | 'sparkles' | 'stop' | 'sun' | 'trash' | 'x';

const paths: Record<IconName, JSX.Element> = {
  activity: <path d="M3 12h3l2-7 3 10 2-6h4" />,
  archive: <path d="M3 5h14M4 5v11h12V5M7 9h6M2 3h16v2H2z" />,
  'arrow-right': <path d="M4 12h12m-5-5 5 5-5 5" />,
  bot: <><rect x="4" y="5" width="12" height="10" rx="2" /><path d="M8 5V3h4v2M8 10h.01M12 10h.01M8 13h4" /></>,
  'chevron-down': <path d="m5 8 4 4 4-4" />,
  'chevron-left': <path d="m12 5-4 4 4 4" />,
  'chevron-right': <path d="m8 5 4 4-4 4" />,
  'circle-gauge': <><path d="M4 15a8 8 0 1 1 12 0" /><path d="m9 10 3-3" /><circle cx="9" cy="10" r="1" /></>,
  clipboard: <><rect x="5" y="4" width="10" height="13" rx="1.5" /><path d="M8 4V2h4v2M8 9h4M8 12h4" /></>,
  code: <><path d="m8 5-4 4 4 4M12 5l4 4-4 4" /><path d="m11 3-2 14" /></>,
  copy: <><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M13 7V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3" /></>,
  edit: <><path d="m4 14 .7-3.2L12.8 2.7a1.7 1.7 0 0 1 2.4 2.4L7.1 13.2 4 14Z" /><path d="m11.5 4 2.5 2.5" /></>,
  eye: <><path d="M2 9s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" /><circle cx="9" cy="9" r="2" /></>,
  'git-branch': <><circle cx="6" cy="4" r="2" /><circle cx="14" cy="14" r="2" /><circle cx="14" cy="4" r="2" /><path d="M6 6v3a5 5 0 0 0 5 5h1M6 6v1a5 5 0 0 0 5 5" /></>,
  home: <><path d="m3 9 6-5 6 5v6H3z" /><path d="M7 15v-4h4v4" /></>,
  menu: <path d="M3 5h12M3 9h12M3 13h12" />,
  message: <path d="M3 4h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-4 3V5a1 1 0 0 1 1-1Z" />,
  moon: <path d="M14 13a6 6 0 0 1-7-7 6 6 0 1 0 7 7Z" />,
  more: <><circle cx="5" cy="9" r="1" fill="currentColor" stroke="none" /><circle cx="9" cy="9" r="1" fill="currentColor" stroke="none" /><circle cx="13" cy="9" r="1" fill="currentColor" stroke="none" /></>,
  network: <><circle cx="4" cy="5" r="2" /><circle cx="14" cy="4" r="2" /><circle cx="9" cy="14" r="2" /><path d="m5.7 6.1 2 6M12.3 5.5l-2 6.7M6 5h6" /></>,
  paperclip: <path d="m13 6-5.5 5.5a3 3 0 0 1-4.2-4.2l5.5-5.5a2 2 0 0 1 2.8 2.8L6.1 10.1a1 1 0 0 1-1.4-1.4l5-5" />,
  'panel-left': <><rect x="3" y="3" width="14" height="12" rx="1.5" /><path d="M7 3v12M11 8l-2 2 2 2" /></>,
  play: <path d="m7 4 8 5-8 5V4Z" />,
  plus: <path d="M9 3v12M3 9h12" />,
  refresh: <path d="M14 6V3l-2 2a6 6 0 1 0 1.5 6" />,
  search: <><circle cx="8" cy="8" r="5" /><path d="m12 12 4 4" /></>,
  settings: <><circle cx="9" cy="9" r="2.5" /><path d="M9 2v2M9 14v2M2 9h2M14 9h2M4 4l1.5 1.5M12.5 12.5 14 14M14 4l-1.5 1.5M5.5 12.5 4 14" /></>,
  shield: <><path d="m9 2 6 2v4c0 4-2.5 6.5-6 8-3.5-1.5-6-4-6-8V4l6-2Z" /><path d="m6 9 2 2 4-4" /></>,
  sparkles: <><path d="m9 2 1 4 4 1-4 1-1 4-1-4-4-1 4-1 1-4ZM15 11l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2Z" /></>,
  stop: <rect x="5" y="5" width="8" height="8" rx="1" />,
  sun: <><circle cx="9" cy="9" r="3" /><path d="M9 2v2M9 14v2M2 9h2M14 9h2M4 4l1.5 1.5M12.5 12.5 14 14M14 4l-1.5 1.5M5.5 12.5 4 14" /></>,
  trash: <><path d="M4 5h10M8 2h2l1 3H7l1-3ZM6 7v7M9 7v7M12 7v7M5 15h8" /></>,
  x: <path d="m5 5 8 8M13 5l-8 8" />,
};

export function Icon({ name, size = 18, strokeWidth = 1.7, ...props }: { name: IconName; size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
