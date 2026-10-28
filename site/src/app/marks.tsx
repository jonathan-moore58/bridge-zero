// The chains' and the Polkadot wallets' own marks, each from its owner's brand kit or official
// repository, stored unmodified in ./marks/ and served with the page (NOTICE.md gives each file's
// source and terms). A chain's mark sits in the app's round chip; a wallet's mark is shown as the
// wallet picker shows an Ethereum wallet's own icon. Ethereum wallets keep the icon they announce
// (EIP-6963).
//
// Three marks are held back, because their owners' terms ask for written approval before anyone
// uses them (NOTICE.md quotes each): Base's Square and Arbitrum's logomark, whose chips show the
// chain's initial instead, and SubWallet's, shown with the generic wallet icon as before. Their files
// stay in ./marks/ and are not imported, so the build does not ship them. To show one once its owner
// approves, import its file here and add it to CHAIN or WALLET; Base's Square then sits on a white
// ground at half the chip (its App Icons rule), Arbitrum's file is already its kit's all-white
// logomark for dark grounds, and the wallet button's status dot must not cover either chain's mark.

import type { MarkKey } from "./dests.ts";
import ethereum from "./marks/ethereum.svg";
import polkadotJs from "./marks/polkadot-js.svg";
import portaldotWallet from "./marks/portaldot-wallet.png";
import portaldot from "./marks/portaldot.png";
import talisman from "./marks/talisman.svg";

/** The chains' marks the page ships; a chain missing here is held back (see above). */
const CHAIN: Partial<Record<MarkKey, string>> = { portaldot, ethereum };

/** The letter a chain's chip shows while its mark is held back. */
const INITIAL: Record<MarkKey, string> = { portaldot: "P", ethereum: "E", base: "B", arbitrum: "A" };

/** A chain's mark in the app's round chip, or its initial while the mark is held back; `cls` sets its size (mark--28 and so on). */
export function ChainMark({ mark, cls = "" }: { mark: MarkKey; cls?: string }) {
  const src = CHAIN[mark];
  return (
    <span class={`mark mark--logo${src ? "" : " mark--initial"} ${cls}`} data-mark={mark} aria-hidden="true">
      {src ? (
        <img class="mark__img" src={src} alt="" decoding="async" draggable={false} />
      ) : (
        <svg class="mark__letter" viewBox="0 0 24 24" focusable="false">
          <text x="12" y="12.5" text-anchor="middle" dominant-baseline="central">
            {INITIAL[mark]}
          </text>
        </svg>
      )}
    </span>
  );
}

/** The Polkadot wallets the page ships a mark for, by the key each injects itself under (window.injectedWeb3). SubWallet's is held back (see above). */
const WALLET: Record<string, string> = {
  "portaldot extension": portaldotWallet,
  "polkadot-js": polkadotJs,
  talisman,
};

/** A Polkadot wallet's mark, or null for a wallet the page ships none for. */
export const walletMark = (key: string): string | null => WALLET[key] ?? null;

/** The Portaldot Wallet's mark, for the row that offers to install it. */
export const PORTALDOT_WALLET_MARK = portaldotWallet;
