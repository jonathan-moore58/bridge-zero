// Small building blocks: copy buttons, hashes, status badges, number tickers, section headers.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { formatInt, formatUtc, timeAgo } from "../lib/format.ts";
import { checksumAddress, shortHex } from "../lib/hex.ts";
import { keccak256 } from "../lib/hashes.ts";
import type { Field } from "../lib/live.ts";
import { useNow } from "../lib/live.ts";
import { Check, Copy as CopyIcon, External } from "./icons.tsx";
import { EthereumMark, PortaldotMark } from "./marks.tsx";

export const reducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function CopyButton({ text, label, class: cls }: { text: string; label: string; class?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      class={`copy ${cls ?? ""}`}
      data-done={done ? "true" : "false"}
      aria-label={done ? `Copied ${label}` : `Copy ${label}`}
      title={done ? "Copied" : `Copy ${label}`}
      onClick={async () => setDone(await writeClipboard(text))}
    >
      {done ? <Check /> : <CopyIcon />}
      <span class="sr-only" aria-live="polite">
        {done ? "Copied" : ""}
      </span>
    </button>
  );
}

export function ExtLink({ href, children, class: cls, title }: { href: string; children: ComponentChildren; class?: string; title?: string }) {
  return (
    <a class={`ext ${cls ?? "link"}`} href={href} target="_blank" rel="noopener noreferrer" title={title}>
      {children}
      <External />
      <span class="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** A hash, shortened unless `full`, with a copy button and an optional link. */
export function Hash({
  value,
  href,
  label = "hash",
  full = false,
  head = 8,
  tail = 8,
  copy = true,
  class: cls,
}: {
  value: string;
  href?: string;
  label?: string;
  full?: boolean;
  head?: number;
  tail?: number;
  copy?: boolean;
  class?: string;
}) {
  const shown = /^0x[0-9a-fA-F]{40}$/.test(value) ? checksumAddress(value, keccak256) : value;
  const text = full ? shown : shortHex(shown, head, tail);
  return (
    <span class={`hash ${full ? "hash--full" : ""} ${cls ?? ""}`}>
      {href ? (
        <a class="hash__text" href={href} target="_blank" rel="noopener noreferrer" title={shown}>
          {text}
          <span class="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <span class="hash__text" title={shown}>
          {text}
        </span>
      )}
      {copy && <CopyButton text={shown} label={label} />}
    </span>
  );
}

/** LIVE, RECORDED, CHECKING or UNAVAILABLE, with where the value came from in its title. */
export function StatusBadge({ field, compact = false }: { field: Field<unknown>; compact?: boolean }) {
  const now = useNow(5000);
  let cls = "badge--loading";
  let text = "Checking";
  let title = "Reading the chain";
  if (field.status === "live") {
    cls = "badge--live";
    text = "Live";
    title = `Read live from ${field.endpoint ?? "the chain"}, ${field.at ? timeAgo(field.at, now) : "just now"}${field.error ? `. The last refresh failed: ${field.error}` : ""}`;
  } else if (field.status === "recorded") {
    cls = "badge--recorded";
    text = "Recorded";
    title = `From the repository's records (${field.from ?? "deployments/"}). The live read failed: ${field.error ?? "no answer"}`;
  } else if (field.status === "error") {
    cls = "badge--error";
    text = "Unavailable";
    title = `No live answer and nothing recorded: ${field.error ?? "unknown"}`;
  } else if (field.value !== undefined) {
    text = "Checking";
    title = `Showing the recorded value (${field.from ?? "records"}) while the live read runs`;
  }
  return (
    <span class={`badge ${cls}`} title={title}>
      <span class="badge__dot" />
      {compact ? null : text}
      <span class="sr-only">{compact ? text : ""}. {title}</span>
    </span>
  );
}

/** Where a field's value came from, in words: for footnotes under live tiles. */
export function SourceLine({ field, live }: { field: Field<unknown>; live: string }) {
  const now = useNow(5000);
  if (field.status === "live") return <p class="source">{`${live} · ${field.endpoint} · ${field.at ? timeAgo(field.at, now) : ""}`}</p>;
  if (field.status === "recorded") return <p class="source">{`recorded · ${field.from} · live read failed`}</p>;
  if (field.status === "error") return <p class="source">{`unavailable · ${field.error ?? ""}`}</p>;
  return <p class="source">{field.value === undefined ? "reading…" : `recorded · ${field.from} · checking live…`}</p>;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** An integer that counts to its new value when it changes. */
export function Ticker({ value, format = formatInt, duration = 900 }: { value: number | undefined; format?: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState<number | undefined>(value);
  const from = useRef<number | undefined>(value);
  const [ticking, setTicking] = useState(false);
  useEffect(() => {
    if (value === undefined) return;
    const start = from.current;
    from.current = value;
    if (start === undefined || start === value || reducedMotion()) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    setTicking(true);
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setShown(Math.round(start + (value - start) * easeOut(p)));
      if (p < 1) raf = requestAnimationFrame(step);
      else setTicking(false);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  if (shown === undefined) return <span class="skel" aria-hidden="true" />;
  return (
    <span class={`num ticker ${ticking ? "is-ticking" : ""}`} aria-label={format(value ?? shown)}>
      <span aria-hidden="true">{format(shown)}</span>
    </span>
  );
}

export function Skel({ w = "8ch" }: { w?: string }) {
  return <span class="skel" style={{ width: w }} aria-hidden="true" />;
}

/**
 * Inline markdown from the records: `code` spans, **bold** and [links](url). A link to an anchor
 * (#evidence) points into `base`, the repository's README, when one is given; otherwise it is text.
 */
export function Md({ text, base }: { text: string; base?: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g).filter((p) => p !== "");
  return (
    <span class="md">
      {parts.map((p, i) => {
        if (p.length > 1 && p.startsWith("`") && p.endsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
        if (p.length > 4 && p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
        if (link?.[1] && link[2]) {
          const href = link[2].startsWith("#") ? (base ? `${base}${link[2]}` : null) : /^https:\/\//.test(link[2]) ? link[2] : base ? `${base}/blob/main/${link[2].replace(/^\.?\//, "")}` : null;
          return href ? (
            <ExtLink key={i} href={href}>
              {link[1]}
            </ExtLink>
          ) : (
            <span key={i}>{link[1]}</span>
          );
        }
        return p;
      })}
    </span>
  );
}

export function SectionHead({ id, n, eyebrow, title, lead, children }: { id: string; n: string; eyebrow: string; title: ComponentChildren; lead?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <header class="shead reveal">
      <p class="eyebrow">
        <span class="eyebrow__n">{n}</span>
        <span class="eyebrow__rule" aria-hidden="true" />
        <span>{eyebrow}</span>
      </p>
      <h2 class="h2" id={`${id}-title`}>
        {title}
      </h2>
      {lead && <p class="lead">{lead}</p>}
      {children}
    </header>
  );
}

export function Chain({ which, small = false, children }: { which: "v3" | "mainnet" | "sepolia"; small?: boolean; children?: ComponentChildren }) {
  const size = small ? 16 : 20;
  const name = which === "v3" ? "Portaldot V3 testnet" : which === "mainnet" ? "Old Portaldot mainnet" : "Ethereum Sepolia";
  return (
    <span class={`chain ${small ? "chain--sm" : ""}`}>
      {which === "sepolia" ? <EthereumMark size={size} /> : <PortaldotMark size={size} />}
      <span>{children ?? name}</span>
    </span>
  );
}

export function When({ iso }: { iso: string }) {
  return <time dateTime={iso}>{formatUtc(iso)}</time>;
}

export type Children = ComponentChildren;
export type Attrs = JSX.HTMLAttributes<HTMLElement>;
