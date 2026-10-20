// The marks: Bridge Zero's own (a zero with a bridge through it), Portaldot's, and Ethereum's.

import { useId } from "preact/hooks";
import portaldotPng from "../assets/portaldot.png";

export function ZeroMark({ size = 28, title }: { size?: number; title?: string }) {
  const id = `zm${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? "img" : undefined} aria-hidden={title ? undefined : "true"} aria-label={title}>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="3.4" x2="28.6" y1="16" y2="16">
          <stop offset="0" stop-color="#b197ff" />
          <stop offset="0.52" stop-color="#7c6bff" />
          <stop offset="1" stop-color="#6aa2ff" />
        </linearGradient>
      </defs>
      <ellipse cx="16" cy="16" rx="8.3" ry="10.8" fill="none" stroke="#f3f1fa" stroke-width="2.5" />
      <path d="M3.4 16h25.2" stroke={`url(#${id})`} stroke-width="2.5" stroke-linecap="round" />
      <circle cx="3.4" cy="16" r="2.3" fill="#b197ff" />
      <circle cx="28.6" cy="16" r="2.3" fill="#6aa2ff" />
    </svg>
  );
}

export function PortaldotMark({ size = 20, label }: { size?: number; label?: string }) {
  return <img src={portaldotPng} width={size} height={size} alt={label ?? ""} decoding="async" draggable={false} class="mark mark--pdot" />;
}

/** The Ethereum octahedron in a round chip, drawn from the standard glyph's six facets. */
export function EthereumMark({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" class="mark mark--eth" role={label ? "img" : undefined} aria-hidden={label ? undefined : "true"} aria-label={label}>
      <circle cx="32" cy="32" r="31" fill="#1c1928" stroke="#2f2a42" stroke-width="2" />
      <g transform="translate(20.5 13.3) scale(0.0898)">
        <path fill="#c9d1ff" d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z" />
        <path fill="#ffffff" d="M127.962 0L0 212.32l127.962 75.639V154.158z" />
        <path fill="#aab6ff" d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.6L256 236.587z" />
        <path fill="#e6eaff" d="M127.962 416.905v-104.72L0 236.585z" />
        <path fill="#8a99f0" d="M127.961 287.958l127.96-75.637-127.96-58.162z" />
        <path fill="#bcc6ff" d="M0 212.32l127.96 75.638v-133.8z" />
      </g>
    </svg>
  );
}
