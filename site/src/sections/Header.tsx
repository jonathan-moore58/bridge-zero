import { useEffect, useState } from "preact/hooks";
import { REPO, repoFile } from "../lib/chains.ts";
import { ArrowRight, Cross, Doc, GitHub, Menu } from "../components/icons.tsx";
import { ZeroMark } from "../components/marks.tsx";

export const NAV = [
  { id: "bridge", label: "Bridge" },
  { id: "receipt", label: "Receipt" },
  { id: "break", label: "Break it" },
  { id: "validators", label: "Validators" },
  { id: "trust", label: "Trust" },
  { id: "return", label: "Return" },
  { id: "verify", label: "Verify" },
  { id: "roadmap", label: "Roadmap" },
] as const;

function useActiveSection(): string {
  const [active, setActive] = useState("");
  useEffect(() => {
    const els = NAV.map((n) => document.getElementById(n.id)).filter((e): e is HTMLElement => e !== null);
    if (!("IntersectionObserver" in window) || els.length === 0) return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        let best = "";
        let ratio = 0;
        for (const [id, r] of visible) {
          if (r > ratio) {
            ratio = r;
            best = id;
          }
        }
        setActive(ratio > 0 ? best : "");
      },
      { rootMargin: "-30% 0px -55% 0px", threshold: [0, 0.01, 0.2, 0.5, 1] },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  return active;
}

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const active = useActiveSection();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header class={`hdr ${scrolled ? "is-scrolled" : ""} ${open ? "is-open" : ""}`}>
      <div class="hdr__bar container">
        <a class="brand" href="#top" aria-label="Bridge Zero, back to the top">
          <ZeroMark size={30} />
          <span class="brand__name">Bridge Zero</span>
          <span class="brand__tag">testnet</span>
        </a>
        <nav class="hdr__nav" aria-label="Sections">
          {NAV.map((n) => (
            <a key={n.id} href={`#${n.id}`} class={active === n.id ? "is-active" : ""} aria-current={active === n.id ? "true" : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
        <div class="hdr__actions">
          <a class="btn btn--primary btn--sm" href="app/">
            Open the app
          </a>
          <a class="btn btn--ghost btn--sm hdr__docs" href={repoFile("docs/BRIDGE.md")} target="_blank" rel="noopener noreferrer">
            <Doc />
            Docs
          </a>
          <a class="iconbtn" href={REPO} target="_blank" rel="noopener noreferrer" aria-label="The repository on GitHub (opens in a new tab)" title="GitHub">
            <GitHub />
          </a>
          <button type="button" class="iconbtn hdr__menu" aria-expanded={open} aria-controls="mobile-nav" aria-label={open ? "Close the menu" : "Open the menu"} onClick={() => setOpen(!open)}>
            {open ? <Cross /> : <Menu />}
          </button>
        </div>
      </div>
      <nav id="mobile-nav" class="mnav" aria-label="Sections" hidden={!open}>
        <div class="container mnav__inner">
          <a href="app/" onClick={() => setOpen(false)}>
            <span class="mnav__n">
              <ArrowRight />
            </span>
            Open the bridge app
          </a>
          {NAV.map((n, i) => (
            <a key={n.id} href={`#${n.id}`} onClick={() => setOpen(false)}>
              <span class="mnav__n">{String(i + 1).padStart(2, "0")}</span>
              {n.label}
            </a>
          ))}
          <a href={repoFile("docs/BRIDGE.md")} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
            <span class="mnav__n">
              <Doc />
            </span>
            Docs
          </a>
        </div>
      </nav>
    </header>
  );
}
