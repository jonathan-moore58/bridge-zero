import { useEffect } from "preact/hooks";
import { Attacks } from "./sections/Attacks.tsx";
import { Bridge } from "./sections/Bridge.tsx";
import { Footer } from "./sections/Footer.tsx";
import { Header } from "./sections/Header.tsx";
import { Hero } from "./sections/Hero.tsx";
import { Receipt } from "./sections/Receipt.tsx";
import { Roadmap } from "./sections/Roadmap.tsx";
import { ReturnPath } from "./sections/ReturnPath.tsx";
import { Trust } from "./sections/Trust.tsx";
import { Validators } from "./sections/Validators.tsx";
import { Verify } from "./sections/Verify.tsx";

/** Pointer-following light on `.spot` cards, one listener for the page. */
function useSpotlight() {
  useEffect(() => {
    if (!window.matchMedia("(hover: hover)").matches) return;
    let frame = 0;
    let last: PointerEvent | null = null;
    const apply = () => {
      frame = 0;
      const e = last;
      if (!e) return;
      const el = (e.target as Element | null)?.closest?.(".spot") as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      document.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);
}

/** Fades sections in as they enter the viewport. */
function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.06 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

export function App() {
  useSpotlight();
  useReveal();
  return (
    <>
      <a class="skip" href="#bridge">
        Skip to the bridge
      </a>
      <div class="backdrop" aria-hidden="true" />
      <Header />
      <main id="main">
        <Hero />
        <Bridge />
        <Receipt />
        <Attacks />
        <Validators />
        <Trust />
        <ReturnPath />
        <Verify />
        <Roadmap />
      </main>
      <Footer />
    </>
  );
}
