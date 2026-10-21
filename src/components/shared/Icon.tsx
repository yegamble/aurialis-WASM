import type { SVGProps } from "react";

export type IconName =
  | "album"
  | "arrow-down-to-line"
  | "arrow-left"
  | "arrow-right"
  | "audio-lines"
  | "check"
  | "chevron-down"
  | "circle-alert"
  | "clock"
  | "disc"
  | "file-audio"
  | "gauge"
  | "headphones"
  | "library"
  | "menu"
  | "more-horizontal"
  | "skip-back"
  | "skip-forward"
  | "forward-10"
  | "repeat"
  | "volume"
  | "pause"
  | "play"
  | "plus"
  | "refresh-cw"
  | "rotate-ccw"
  | "scissors"
  | "search"
  | "settings"
  | "sliders-horizontal"
  | "sparkles"
  | "trash"
  | "upload"
  | "wand-sparkles"
  | "x";

type IconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: IconName;
  title?: string;
};

export function Icon({ name, title, className = "", ...props }: IconProps) {
  const ariaHidden = title === undefined ? true : undefined;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={ariaHidden}
      role={title !== undefined ? "img" : undefined}
      {...props}
    >
      {title !== undefined ? <title>{title}</title> : null}
      {renderPaths(name)}
    </svg>
  );
}

function renderPaths(name: IconName) {
  switch (name) {
    case "skip-back":
      return <><path d="M5 4v16" /><path d="m19 4-11 8 11 8Z" /></>;
    case "skip-forward":
      return <><path d="M19 4v16" /><path d="m5 4 11 8-11 8Z" /></>;
    case "forward-10":
      return <><path d="M20 4v6h-6" /><path d="M20 10a8 8 0 1 0-1 8" /><text x="11" y="15" textAnchor="middle" fontSize="7" fontWeight="600" stroke="none" fill="currentColor">10s</text></>;
    case "repeat":
      return <><path d="m17 2 4 4-4 4" /><path d="M3 11V8a2 2 0 0 1 2-2h16" /><path d="m7 22-4-4 4-4" /><path d="M21 13v3a2 2 0 0 1-2 2H3" /></>;
    case "volume":
      return <><path d="m11 5-5 4H3v6h3l5 4Z" /><path d="M15 8a6 6 0 0 1 0 8" /><path d="M18 5a10 10 0 0 1 0 14" /></>;
    case "album":
      return (
        <>
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
          <polyline points="11 3 11 11 14 8 17 11 17 3" />
        </>
      );
    case "arrow-down-to-line":
      return (
        <>
          <path d="M12 17V3" />
          <path d="m6 11 6 6 6-6" />
          <path d="M19 21H5" />
        </>
      );
    case "arrow-left":
      return (
        <>
          <path d="m12 19-7-7 7-7" />
          <path d="M19 12H5" />
        </>
      );
    case "arrow-right":
      return (
        <>
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </>
      );
    case "audio-lines":
      return (
        <>
          <path d="M2 10v3" />
          <path d="M6 6v11" />
          <path d="M10 3v18" />
          <path d="M14 8v7" />
          <path d="M18 5v13" />
          <path d="M22 10v3" />
        </>
      );
    case "check":
      return <path d="M20 6 9 17l-5-5" />;
    case "chevron-down":
      return <path d="m6 9 6 6 6-6" />;
    case "circle-alert":
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" x2="12" y1="8" y2="12" />
          <line x1="12" x2="12.01" y1="16" y2="16" />
        </>
      );
    case "clock":
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </>
      );
    case "disc":
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M6 12c0-1.7.7-3.2 1.8-4.2" />
          <circle cx="12" cy="12" r="2" />
          <path d="M18 12c0 1.7-.7 3.2-1.8 4.2" />
        </>
      );
    case "file-audio":
      return (
        <>
          <path d="M17.5 22h.5a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <path d="M2 19a2 2 0 1 1 4 0v1a2 2 0 1 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 1 1-4 0v-1a2 2 0 1 1 4 0" />
        </>
      );
    case "gauge":
      return (
        <>
          <path d="m12 14 4-4" />
          <path d="M3.34 19a10 10 0 1 1 17.32 0" />
        </>
      );
    case "headphones":
      return (
        <>
          <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
        </>
      );
    case "library":
      return (
        <>
          <path d="m16 6 4 14" />
          <path d="M12 6v14" />
          <path d="M8 8v12" />
          <path d="M4 4v16" />
        </>
      );
    case "menu":
      return (
        <>
          <line x1="4" x2="20" y1="12" y2="12" />
          <line x1="4" x2="20" y1="6" y2="6" />
          <line x1="4" x2="20" y1="18" y2="18" />
        </>
      );
    case "more-horizontal":
      return (
        <>
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
          <circle cx="5" cy="12" r="1" />
        </>
      );
    case "pause":
      return (
        <>
          <rect x="14" y="4" width="4" height="16" rx="1" />
          <rect x="6" y="4" width="4" height="16" rx="1" />
        </>
      );
    case "play":
      return <polygon points="6 3 20 12 6 21 6 3" />;
    case "plus":
      return (
        <>
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </>
      );
    case "refresh-cw":
      return (
        <>
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
        </>
      );
    case "rotate-ccw":
      return (
        <>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </>
      );
    case "scissors":
      return (
        <>
          <circle cx="6" cy="6" r="3" />
          <path d="M8.12 8.12 12 12" />
          <path d="M20 4 8.12 15.88" />
          <circle cx="6" cy="18" r="3" />
          <path d="M14.8 14.8 20 20" />
        </>
      );
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </>
      );
    case "settings":
      return (
        <>
          <path d="M20 7h-9" />
          <path d="M14 17H5" />
          <circle cx="17" cy="17" r="3" />
          <circle cx="7" cy="7" r="3" />
        </>
      );
    case "sliders-horizontal":
      return (
        <>
          <line x1="21" x2="14" y1="4" y2="4" />
          <line x1="10" x2="3" y1="4" y2="4" />
          <line x1="21" x2="12" y1="12" y2="12" />
          <line x1="8" x2="3" y1="12" y2="12" />
          <line x1="21" x2="16" y1="20" y2="20" />
          <line x1="12" x2="3" y1="20" y2="20" />
          <line x1="14" x2="14" y1="2" y2="6" />
          <line x1="8" x2="8" y1="10" y2="14" />
          <line x1="16" x2="16" y1="18" y2="22" />
        </>
      );
    case "sparkles":
      return (
        <>
          <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
          <path d="M20 3v4" />
          <path d="M22 5h-4" />
        </>
      );
    case "trash":
      return (
        <>
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          <line x1="10" x2="10" y1="11" y2="17" />
          <line x1="14" x2="14" y1="11" y2="17" />
        </>
      );
    case "upload":
      return (
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" x2="12" y1="3" y2="15" />
        </>
      );
    case "wand-sparkles":
      return (
        <>
          <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" />
          <path d="m14 7 3 3" />
          <path d="M5 6v4" />
          <path d="M19 14v4" />
          <path d="M10 2v2" />
          <path d="M7 8H3" />
          <path d="M21 16h-4" />
          <path d="M11 3H9" />
        </>
      );
    case "x":
      return (
        <>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </>
      );
  }
}
