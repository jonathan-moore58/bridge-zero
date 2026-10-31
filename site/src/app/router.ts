// Hash routes: #/bridge, #/bridge/back, #/tx/<id>, #/receipt/<id>, #/activity, #/verify,
// #/verify/<id>, #/network, #/lab. A query after the route (#/bridge/back?amount=0.5) carries a
// view's own state.

import { useEffect, useState } from "preact/hooks";

export const ROUTES = ["bridge", "tx", "receipt", "activity", "verify", "network", "lab"] as const;
export type RouteName = (typeof ROUTES)[number];

export interface Route {
  name: RouteName;
  parts: string[];
  q: URLSearchParams;
}

export function parseRoute(hash: string): Route | null {
  const h = hash.replace(/^#\/?/, "");
  const qi = h.indexOf("?");
  const q = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : "");
  const parts = (qi >= 0 ? h.slice(0, qi) : h).split("/").filter(Boolean);
  const name = parts[0] ?? "bridge";
  return (ROUTES as readonly string[]).includes(name) ? { name: name as RouteName, parts, q } : null;
}

export function useRoute(): Route {
  const read = () => parseRoute(location.hash);
  const [route, setRoute] = useState<Route>(() => read() ?? { name: "bridge", parts: [], q: new URLSearchParams() });
  useEffect(() => {
    const on = () => {
      const r = read();
      if (!r) {
        location.replace("#/bridge");
        return;
      }
      setRoute(r);
    };
    if (!read()) on();
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(hash: string): void {
  location.hash = hash;
}
