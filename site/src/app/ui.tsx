// The app's small pieces: icons and marks from the sprite, addresses with copy and explorer buttons,
// tips, toasts, the screen-reader announcer, and the one sheet (a modal on desktop, a bottom sheet on
// phones).

import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Box, useBox } from "./store.ts";

export function Icon({ id, cls = "" }: { id: string; cls?: string }) {
  return (
    <svg class={`i ${cls}`} aria-hidden="true">
      <use href={`#${id}`} />
    </svg>
  );
}

export function Mark({ id, cls = "" }: { id: string; cls?: string }) {
  return (
    <svg class={`mark ${cls}`} aria-hidden="true">
      <use href={`#${id}`} />
    </svg>
  );
}

export const short = (h: string, head = 6, tail = 4): string => h.slice(0, head) + "…" + h.slice(-tail);

/** A number as the app shows it: grouped, at most `max` decimals. */
export const fmt = (n: number, max = 4): string => n.toLocaleString("en-US", { maximumFractionDigits: max });

/** A whole number, grouped. */
export const num = (n: number): string => n.toLocaleString("en-US");

/** A countdown or a stopwatch: m:ss. */
export function clock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** A duration. Number and unit are joined by a narrow no-break space (U+202F). */
export function dur(s: number): string {
  const t = Math.round(s);
  if (t < 60) return `${t} s`;
  const r = t % 60;
  return `${Math.floor(t / 60)} min${r ? ` ${r} s` : ""}`;
}

/** A measured time in seconds, said in seconds (84 s, never 1 min 24 s). */
export const secs = (s: number): string => `${Math.round(s)} s`;

/** A badge: a dot, an icon or nothing before its text. `kind` is the badge--<kind> modifier. */
export function Chip({ kind, children, icon, cls = "" }: { kind: string; children: ComponentChildren; icon?: string; cls?: string }) {
  return (
    <span class={`badge badge--${kind} ${cls}`}>
      {icon === "dot" ? <span class="badge__dot" aria-hidden="true" /> : icon ? <Icon id={icon} /> : null}
      {children}
    </span>
  );
}

/** Keeps a phrase on one line. */
export const Nb = ({ children }: { children: ComponentChildren }) => <span class="nowrap">{children}</span>;

export const Mono = ({ children }: { children: ComponentChildren }) => <span class="mono">{children}</span>;

// ---------------------------------------------------------------------------------------------
// The screen-reader announcer

const announcement = new Box("");

export function announce(text: string): void {
  announcement.set("");
  setTimeout(() => announcement.set(text), 30);
}

export function Announcer() {
  const text = useBox(announcement);
  return (
    <p class="visually-hidden" aria-live="polite" id="announcer">
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// Copy

/** A copy button: an icon, or with `text` an icon and a word that says what it copies (`icon` for it, the copy icon unless given). */
export function CopyButton({ value, label, cls = "addr__btn", icon = "i-copy", text }: { value: string; label: string; cls?: string; icon?: string; text?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const onClick = (e: Event) => {
    e.preventDefault();
    navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopied(true);
    announce("Copied");
  };
  return (
    <button class={`${cls}${copied ? " is-copied" : ""}`} type="button" aria-label={`Copy ${label}`} title={text ? `Copy ${label}` : undefined} onClick={onClick}>
      <Icon id={copied ? "i-check" : icon} />
      {text ? <span>{text}</span> : null}
    </button>
  );
}

/** An address or hash, shortened, with copy and explorer buttons. */
export function Addr({ full, href, label, cls = "" }: { full: string; href?: string; label: string; cls?: string }) {
  return (
    <span class={`addr ${cls}`}>
      <span class="addr__text">{short(full)}</span>
      <CopyButton value={full} label={label} />
      {href ? (
        <a class="addr__btn" href={href} target="_blank" rel="noopener" aria-label={`Open ${label} in the explorer`}>
          <Icon id="i-external" />
        </a>
      ) : null}
    </span>
  );
}

/** A value with a copy button, for network parameters. */
export function CopyChip({ value, label, shown }: { value: string; label: string; shown?: string }) {
  return (
    <span class="addr addr--inline">
      <span class="addr__text">{shown ?? value}</span>
      <CopyButton value={value} label={`the ${label}`} />
    </span>
  );
}

export function Tip({ id, label, children, cls = "tip__bubble--end" }: { id: string; label: string; children: ComponentChildren; cls?: string }) {
  return (
    <span class="tip">
      <button class="tip__trigger" type="button" aria-label={label} aria-describedby={id}>
        <Icon id="i-info" />
      </button>
      <span class={`tip__bubble ${cls}`} role="tooltip" id={id}>
        {children}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Toasts

export type ToastKind = "verify" | "trust" | "revert" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  text: string;
  leaving: boolean;
}

const toasts = new Box<ToastItem[]>([]);
let toastId = 0;

function dismiss(id: number): void {
  toasts.set((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
  setTimeout(() => toasts.set((list) => list.filter((t) => t.id !== id)), 220);
}

export function toast(kind: ToastKind, title: string, text: string): void {
  const id = ++toastId;
  toasts.set((list) => [...list, { id, kind, title, text, leaving: false }]);
  setTimeout(() => dismiss(id), 5200);
}

const TOAST_ICON: Record<ToastKind, string> = { verify: "i-check-circle", trust: "i-alert", revert: "i-alert", info: "i-info" };

export function Toasts() {
  const list = useBox(toasts);
  return (
    <div class="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`toast toast--${t.kind}${t.leaving ? " is-leaving" : ""}`} role={t.kind === "revert" ? "alert" : "status"}>
          <Icon id={TOAST_ICON[t.kind]} />
          <p class="toast__text">
            <strong>{t.title}</strong>
            {t.text}
          </p>
          <button class="btn btn--ghost btn--icon" type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon id="i-x" cls="i--16" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The sheet

export interface SheetSpec {
  title: string;
  body: ComponentChildren;
  cls?: string;
  foot?: ComponentChildren;
}

const sheet = new Box<SheetSpec | null>(null);
let lastFocus: Element | null = null;

export function openSheet(spec: SheetSpec): void {
  if (!sheet.get()) lastFocus = document.activeElement;
  sheet.set(spec);
}

export function closeSheet(silent = false): void {
  if (!sheet.get()) return;
  sheet.set(null);
  if (!silent && lastFocus instanceof HTMLElement && document.body.contains(lastFocus)) lastFocus.focus();
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SheetHost() {
  const spec = useBox(sheet);
  const overlay = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  // A soft fade at the foot of the body while more is below.
  const measure = useCallback(() => {
    const b = body.current;
    if (b) setMore(b.scrollTop + b.clientHeight < b.scrollHeight - 2);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("has-sheet", !!spec);
    if (!spec) return;
    if (body.current) body.current.scrollTop = 0;
    const frame = requestAnimationFrame(measure);
    const t = setTimeout(() => {
      const root = overlay.current;
      const target = root?.querySelector<HTMLElement>("[data-autofocus]") ?? root?.querySelector<HTMLElement>("[data-close]");
      target?.focus();
    }, 20);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, [spec, measure]);

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      closeSheet();
      return;
    }
    if (e.key !== "Tab") return;
    const f = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    const first = f[0];
    const last = f[f.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      class="overlay"
      id="sheet"
      ref={overlay}
      hidden={!spec}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSheet();
      }}
      onKeyDown={onKeyDown}
    >
      <div class={`modal ${spec?.cls ?? ""}${more ? " has-more" : ""}`} role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet__handle" aria-hidden="true" />
        <div class="modal__head">
          <h2 class="modal__title" id="sheet-title">
            {spec?.title}
          </h2>
          <button class="btn btn--ghost btn--icon" type="button" data-close aria-label="Close" onClick={() => closeSheet()}>
            <Icon id="i-x" />
          </button>
        </div>
        <div class="modal__body" ref={body} onScroll={measure}>
          {spec?.body}
        </div>
        <div class="modal__foot" hidden={!spec?.foot}>
          {spec?.foot}
        </div>
      </div>
    </div>
  );
}
