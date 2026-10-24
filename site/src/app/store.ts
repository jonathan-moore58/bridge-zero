// A small observable value for the app's shared state (the wallet, toasts, the open sheet), and the
// hook that re-renders a component when it changes.

import { useEffect, useState } from "preact/hooks";

type Listener = () => void;

export class Box<T> {
  private listeners = new Set<Listener>();
  private value: T;

  constructor(value: T) {
    this.value = value;
  }

  get(): T {
    return this.value;
  }

  set(next: T | ((prev: T) => T)): void {
    const v = typeof next === "function" ? (next as (prev: T) => T)(this.value) : next;
    if (Object.is(v, this.value)) return;
    this.value = v;
    for (const l of this.listeners) l();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function useBox<T>(box: Box<T>): T {
  const [, bump] = useState(0);
  useEffect(() => box.subscribe(() => bump((n) => n + 1)), [box]);
  return box.get();
}
