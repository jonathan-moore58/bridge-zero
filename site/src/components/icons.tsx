// Line icons on a 24 px grid, drawn for this page.

import type { JSX } from "preact";

type P = JSX.SVGAttributes<SVGSVGElement>;

function Svg(props: P & { children: JSX.Element | JSX.Element[] }) {
  const { children, ...rest } = props;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const Check = (p: P) => (
  <Svg {...p}>
    <path d="M5 12.5l4.2 4.2L19 7.2" />
  </Svg>
);

export const Cross = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
);

export const ArrowRight = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 12h15M13.5 6l6 6-6 6" />
  </Svg>
);

export const ArrowDown = (p: P) => (
  <Svg {...p}>
    <path d="M12 4.5v15M6 13.5l6 6 6-6" />
  </Svg>
);

export const Chevron = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 9.5l5.5 5.5 5.5-5.5" />
  </Svg>
);

export const Copy = (p: P) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.4" />
    <path d="M15.5 8.5V6.9A2.4 2.4 0 0013.1 4.5H6.9A2.4 2.4 0 004.5 6.9v6.2a2.4 2.4 0 002.4 2.4h1.6" />
  </Svg>
);

export const External = (p: P) => (
  <Svg {...p}>
    <path d="M13.5 4.5h6v6M19.5 4.5l-9 9" />
    <path d="M17.5 13.5v4.2a1.8 1.8 0 01-1.8 1.8H6.3a1.8 1.8 0 01-1.8-1.8V8.3a1.8 1.8 0 011.8-1.8h4.2" />
  </Svg>
);

export const Play = (p: P) => (
  <Svg {...p}>
    <path d="M8 5.8v12.4a.8.8 0 001.2.7l10-6.2a.8.8 0 000-1.4l-10-6.2A.8.8 0 008 5.8z" fill="currentColor" stroke="none" />
  </Svg>
);

export const Lock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.4" />
    <path d="M8.2 10.5V8a3.8 3.8 0 017.6 0v2.5" />
    <path d="M12 14.2v2.2" />
  </Svg>
);

export const Signature = (p: P) => (
  <Svg {...p}>
    <path d="M4 19.5c2.5 0 3.4-1.6 4.4-3.6.8-1.6 1.6-3.2 3.1-3.2 2.1 0 .6 4 2.6 4 1.3 0 1.9-1.6 3.2-1.6 1 0 1.4.9 2.7.9" />
    <path d="M15.6 4.6l3.8 3.8M8.4 11.8l7.2-7.2" />
  </Svg>
);

export const HashSign = (p: P) => (
  <Svg {...p}>
    <path d="M5 9h14.5M4.5 15H19M10.2 4.5L8.4 19.5M15.6 4.5l-1.8 15" />
  </Svg>
);

export const Tree = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="5.5" r="2.2" />
    <circle cx="6" cy="18.5" r="2.2" />
    <circle cx="12" cy="18.5" r="2.2" />
    <circle cx="18" cy="18.5" r="2.2" />
    <path d="M12 7.7v8.6M10.7 7.3L7 16.4M13.3 7.3l3.7 9.1" />
  </Svg>
);

export const Coins = (p: P) => (
  <Svg {...p}>
    <ellipse cx="12" cy="6.5" rx="6.5" ry="2.6" />
    <path d="M5.5 6.5v5.5c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6V6.5" />
    <path d="M5.5 12v5.5c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6V12" />
  </Svg>
);

export const User = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M5 19.5c.9-3.4 3.7-5.2 7-5.2s6.1 1.8 7 5.2" />
  </Svg>
);

export const Replay = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 12a7.5 7.5 0 0112.9-5.2L19.5 9" />
    <path d="M19.5 4.5V9H15" />
    <path d="M19.5 12a7.5 7.5 0 01-12.9 5.2L4.5 15" />
    <path d="M4.5 19.5V15H9" />
  </Svg>
);

export const Shield = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.8l7 2.6v5.2c0 4.4-2.9 7.6-7 8.8-4.1-1.2-7-4.4-7-8.8V6.4z" />
    <path d="M8.8 12l2.2 2.2 4.2-4.4" />
  </Svg>
);

export const Key = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="15.5" r="3.8" />
    <path d="M10.8 12.8l8.2-8.3M16.2 7.3l2.4 2.4M14 9.5l1.8 1.8" />
  </Svg>
);

export const Users = (p: P) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="3.1" />
    <path d="M3.5 19c.7-3 2.8-4.6 5.5-4.6s4.8 1.6 5.5 4.6" />
    <circle cx="16.6" cy="8" r="2.5" />
    <path d="M15.8 13.2c2.4-.2 4.2 1.2 4.8 4" />
  </Svg>
);

export const Flame = (p: P) => (
  <Svg {...p}>
    <path d="M12 20.5c-3.6 0-6-2.4-6-5.6 0-3.6 3-5.4 3.6-8.9 2.4 1.3 3.4 3.4 3.3 5.3 1-.6 1.6-1.6 1.8-2.8 1.9 1.6 3.3 3.9 3.3 6.4 0 3.2-2.4 5.6-6 5.6z" />
  </Svg>
);

export const Clock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.6V12l3 2" />
  </Svg>
);

export const Menu = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 8h15M4.5 16h15" />
  </Svg>
);

export const Doc = (p: P) => (
  <Svg {...p}>
    <path d="M7 3.8h6.6l4.6 4.6v10.4a1.8 1.8 0 01-1.8 1.8H7a1.8 1.8 0 01-1.8-1.8V5.6A1.8 1.8 0 017 3.8z" />
    <path d="M13.4 3.8v4.8h4.8M8.8 13h6.4M8.8 16.4h4.4" />
  </Svg>
);

export const Terminal = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.6" />
    <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" />
  </Svg>
);

export const Spark = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.6 2.6M15.4 15.4L18 18M6 18l2.6-2.6M15.4 8.6L18 6" />
  </Svg>
);

export const Cpu = (p: P) => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" />
    <path d="M10 12l1.4 1.4L14.2 10.6" />
  </Svg>
);

export const GitHub = (p: P) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" {...p}>
    <path
      fill="currentColor"
      d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
    />
  </svg>
);
