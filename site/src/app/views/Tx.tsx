// A transfer in progress, or a recorded run replayed: its steps, its checks and what it trusts.

import type { NetState } from "../net.ts";
import type { Route } from "../router.ts";
import { Soon } from "./Soon.tsx";

export function TxView(_props: { route: Route; net: NetState }) {
  return <Soon name="tx" />;
}
