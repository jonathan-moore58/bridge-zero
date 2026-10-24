// A finished transfer: what was sent, what was checked, the transactions.

import type { Route } from "../router.ts";
import { Soon } from "./Soon.tsx";

export function ReceiptView(_props: { route: Route }) {
  return <Soon name="receipt" />;
}
