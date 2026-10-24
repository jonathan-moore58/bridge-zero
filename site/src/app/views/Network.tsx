// The light clients, the vault, the committee and the contracts, read live.

import type { NetState } from "../net.ts";
import { Soon } from "./Soon.tsx";

export function NetworkView(_props: { net: NetState }) {
  return <Soon name="network" />;
}
