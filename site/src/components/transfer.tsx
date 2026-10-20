// One side of a recorded transfer: the chain, the contract, the amount with what happened to it,
// and the block it happened in. The hero's card and the bridge section's card both use it, inside
// a `.xfer` panel, with the transaction between the two legs. It reads as a record, not a form:
// no selectors, no inputs.

import type { ComponentChildren } from "preact";
import { shortAddr } from "../lib/display.ts";
import { EthereumMark, PortaldotMark } from "./marks.tsx";

export function TransferLeg({
  dir,
  state,
  chain,
  net,
  contract,
  address,
  value,
  unit,
  where,
}: {
  dir: string;
  state: string;
  chain: "v3" | "sepolia";
  net: string;
  contract: string;
  address: string;
  value: string;
  unit: string;
  where: ComponentChildren;
}) {
  return (
    <div class="xfer__leg">
      <div class="xfer__top">
        <span class="xfer__k">{dir}</span>
        <span class="xfer__where">
          <span class={`xfer__dot xfer__dot--${chain}`} aria-hidden="true" />
          {where}
        </span>
      </div>
      <div class="xfer__row">
        <span class="xfer__chain">
          {chain === "v3" ? <PortaldotMark size={30} /> : <EthereumMark size={30} />}
          <span class="xfer__names">
            <span class="xfer__net">{net}</span>
            <span class="xfer__contract">
              {contract} <span class="mono">{shortAddr(address)}</span>
            </span>
          </span>
        </span>
        <span class="xfer__amt">
          <span class="xfer__value">{value}</span>
          <span class="xfer__unit">{unit}</span>
          <span class="xfer__done">{state}</span>
        </span>
      </div>
    </div>
  );
}
