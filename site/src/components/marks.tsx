// The marks: Bridge Zero's own (a block on Portaldot and a block on Ethereum joined by one proven
// span, the three strokes making a Z, in an app-icon tile), Portaldot's, and Ethereum's.

import { useId } from "preact/hooks";
import portaldotPng from "../assets/portaldot.png";

/** Bridge Zero's mark in its full tile, light and glow included. Its ids are made unique per copy, as the header and footer both draw it. */
export function ZeroMark({ size = 28, title }: { size?: number; title?: string }) {
  const id = `zm${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const url = (part: string) => `url(#${id}${part})`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-hidden={title ? undefined : "true"} aria-label={title}>
      <defs>
        <radialGradient id={`${id}v`} gradientUnits="userSpaceOnUse" cx="6" cy="4" r="48">
          <stop offset="0" stop-color="#6c27e2" stop-opacity="0.42" />
          <stop offset="1" stop-color="#6c27e2" stop-opacity="0" />
        </radialGradient>
        <radialGradient id={`${id}b`} gradientUnits="userSpaceOnUse" cx="60" cy="62" r="46">
          <stop offset="0" stop-color="#2d68f4" stop-opacity="0.36" />
          <stop offset="1" stop-color="#2d68f4" stop-opacity="0" />
        </radialGradient>
        <linearGradient id={`${id}e`} gradientUnits="userSpaceOnUse" x1="8" y1="4" x2="56" y2="60">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0.3" />
          <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.05" />
          <stop offset="1" stop-color="#b197ff" stop-opacity="0.22" />
        </linearGradient>
        <linearGradient id={`${id}p`} gradientUnits="userSpaceOnUse" x1="12" y1="0" x2="42" y2="0">
          <stop offset="0" stop-color="#b197ff" />
          <stop offset="1" stop-color="#8b5cf6" />
        </linearGradient>
        <linearGradient id={`${id}q`} gradientUnits="userSpaceOnUse" x1="22" y1="0" x2="52" y2="0">
          <stop offset="0" stop-color="#4a34f0" />
          <stop offset="1" stop-color="#2d68f4" />
        </linearGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0.42" />
          <stop offset="0.55" stop-color="#ffffff" stop-opacity="0" />
        </linearGradient>
        <linearGradient id={`${id}m`} gradientUnits="userSpaceOnUse" x1="38" y1="20" x2="26" y2="44">
          <stop offset="0" stop-color="#d6c9ff" />
          <stop offset="0.55" stop-color="#ffffff" />
          <stop offset="1" stop-color="#ffffff" />
        </linearGradient>
        <filter id={`${id}f`} filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
        <clipPath id={`${id}c`}>
          <rect x="2" y="2" width="60" height="60" rx="16" />
        </clipPath>
      </defs>
      {/* The tile: lit violet from the top left and blue from the bottom right, with a fine light edge. */}
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#16141f" />
      <rect x="2" y="2" width="60" height="60" rx="16" fill={url("v")} />
      <rect x="2" y="2" width="60" height="60" rx="16" fill={url("b")} />
      <rect x="2.375" y="2.375" width="59.25" height="59.25" rx="15.625" fill="none" stroke={url("e")} stroke-width="0.75" />
      {/* A block on Portaldot (violet) and a block on Ethereum (blue), each with a soft sheen. */}
      <rect x="12" y="16" width="30" height="8" rx="4" fill={url("p")} />
      <rect x="12" y="16" width="30" height="8" rx="4" fill={url("s")} />
      <rect x="22" y="40" width="30" height="8" rx="4" fill={url("q")} />
      <rect x="22" y="40" width="30" height="8" rx="4" fill={url("s")} />
      {/* The one proven link between them: a beam with a soft glow. */}
      <g clip-path={url("c")}>
        <path d="M38 20 L26 44" stroke="#b197ff" stroke-opacity="0.75" stroke-width="9" stroke-linecap="round" filter={url("f")} />
      </g>
      <path d="M38 20 L26 44" stroke={url("m")} stroke-width="8" stroke-linecap="round" />
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
