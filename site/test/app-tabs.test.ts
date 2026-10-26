// One tab follows each transfer (src/app/tabs.ts), on Node's own Web Locks: two instances of the
// module stand in for two tabs of one browser, which share one lock manager as a browser's origin
// does. A transfer one tab started is that tab's; another tab waits its turn, and takes it over at
// once only when its visitor acts on it there, and then the first tab is told. Offline.

import assert from "node:assert/strict";
import { test } from "node:test";

type Tabs = typeof import("../src/app/tabs.ts");

/** A tab: its own instance of the module, so its own idea of what it follows. */
const tab = (name: string): Promise<Tabs> => import(new URL(`../src/app/tabs.ts?tab=${name}`, import.meta.url).href) as Promise<Tabs>;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

test("a transfer one tab started is that tab's; another tab waits for it, and takes it only when its visitor acts there", async () => {
  const [a, b] = await Promise.all([tab("a1"), tab("b1")]);
  const lostA: string[] = [];
  const lostB: string[] = [];
  a.onTaken((id) => lostA.push(id));
  b.onTaken((id) => lostB.push(id));

  a.own("in-t1-1");
  await settle();
  let waited = 0;
  b.claim("in-t1-1", () => waited++);
  await settle();
  assert.deepEqual([a.follows("in-t1-1"), b.follows("in-t1-1"), waited], [true, false, 0], "B waits while A follows it");

  let took = 0;
  b.take("in-t1-1", () => took++);
  await settle();
  assert.deepEqual([a.follows("in-t1-1"), b.follows("in-t1-1"), took], [false, true, 1], "B's visitor acted on it: B follows it now");
  assert.deepEqual(lostA, ["in-t1-1"], "A is told, so that it stops running it");
  assert.equal(waited, 0, "B's earlier request still waits behind its own hold");

  let back = 0;
  a.take("in-t1-1", () => back++);
  await settle();
  assert.deepEqual([a.follows("in-t1-1"), b.follows("in-t1-1"), back], [true, false, 1]);
  assert.deepEqual(lostB, ["in-t1-1"]);
});

test("a transfer no tab follows is claimed at once, and a second claim of it asks nothing more", async () => {
  const c = await tab("c2");
  let ran = 0;
  c.claim("back-t2-1", () => ran++);
  await settle();
  assert.deepEqual([c.follows("back-t2-1"), ran], [true, 1]);
  c.claim("back-t2-1", () => ran++);
  await settle();
  assert.equal(ran, 2, "already followed: it runs at once");
  const held = (await navigator.locks.query()).held?.filter((l) => l.name === "bz-app.transfer.back-t2-1") ?? [];
  assert.equal(held.length, 1);
});
