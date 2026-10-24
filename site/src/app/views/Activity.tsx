// The connected wallet's locks and burns, and the recorded runs.

import type { Route } from "../router.ts";
import { Soon } from "./Soon.tsx";

export function ActivityView(_props: { route: Route }) {
  return <Soon name="activity" />;
}
