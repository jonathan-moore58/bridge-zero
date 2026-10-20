import { ZeroMark } from "../components/marks.tsx";
import { ExtLink } from "../components/ui.tsx";
import { etherscanAddress, nodeConsoleBlock, records, REPO, repoFile, repoTree, VAULT } from "../lib/chains.ts";
import { formatDay } from "../lib/format.ts";
import { shortAddr } from "../lib/display.ts";
import { NAV } from "./Header.tsx";


export function Footer() {
  const commit = records.build.commit;
  return (
    <footer class="foot">
      <div class="container">
        <div class="foot__top">
          <div class="foot__brand">
            <a class="brand" href="#top">
              <ZeroMark size={30} />
              <span class="brand__name">Bridge Zero</span>
            </a>
            <p class="small muted">
              A Portaldot light client on Ethereum, and a token bridge built on it. Contracts on Sepolia check GRANDPA finality and Substrate storage proofs; trust rests on the
              Portaldot validator set.
            </p>
            <p class="foot__testnet">
              <span class="badge badge--brand">testnet only</span>
              <span class="small dim">Sepolia and the Portaldot V3 testnet only: tPOT and wtPOT are testnet tokens, and the vendored cryptography and trie code is treated as unaudited.</span>
            </p>
          </div>
          <nav class="foot__col" aria-label="This page">
            <p class="micro">This page</p>
            <ul>
              {NAV.map((n) => (
                <li key={n.id}>
                  <a class="link-quiet" href={`#${n.id}`}>
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <nav class="foot__col" aria-label="The project">
            <p class="micro">The project</p>
            <ul>
              <li>
                <ExtLink href={REPO} class="link-quiet">
                  Repository
                </ExtLink>
              </li>
              <li>
                <ExtLink href={`${REPO}#evidence`} class="link-quiet">
                  Evidence table
                </ExtLink>
              </li>
              <li>
                <ExtLink href={repoFile("docs/BRIDGE.md")} class="link-quiet">
                  docs/BRIDGE.md
                </ExtLink>
              </li>
              <li>
                <ExtLink href={repoFile("docs/DECISIONS.md")} class="link-quiet">
                  docs/DECISIONS.md
                </ExtLink>
              </li>
              <li>
                <ExtLink href={repoTree("deployments")} class="link-quiet">
                  deployments/
                </ExtLink>
              </li>
              <li>
                <ExtLink href={repoFile("NOTICE.md")} class="link-quiet">
                  Third-party code
                </ExtLink>
              </li>
            </ul>
          </nav>
          <div class="foot__col foot__col--wide">
            <p class="micro">Contracts</p>
            <ul class="foot__contracts">
              {records.sepolia.contracts.map((c) => (
                <li key={c.address}>
                  <ExtLink href={etherscanAddress(c.address)} class="link-quiet">
                    {c.name}
                  </ExtLink>
                  <span class="mono small dim">{shortAddr(c.address)}</span>
                  <span class="small dim">{c.role}</span>
                </li>
              ))}
              <li>
                <ExtLink
                  href={nodeConsoleBlock(records.bridge.vault.deployBlock.number)}
                  class="link-quiet"
                  title="We found no indexed explorer for the V3 testnet; the Node Console shows the deployment block"
                >
                  PortaldotVault
                </ExtLink>
                <span class="mono small dim">{shortAddr(VAULT)}</span>
                <span class="small dim">the vault, on the V3 testnet</span>
              </li>
            </ul>
          </div>
        </div>
        <div class="foot__bottom">
          <p class="source">
            Built {formatDay(records.build.builtAt)} from {commit ? <ExtLink href={`${REPO}/commit/${commit}`} class="link-quiet mono">{commit.slice(0, 7)}</ExtLink> : "a local checkout"}. Recorded values come from{" "}
            <span class="mono">deployments/</span>, <span class="mono">fixtures/</span> and the README at that commit, and the intervals measured during the timed run from{" "}
            <span class="mono">site/data/</span>, checked against them; live values from the RPC endpoints named next to them. No analytics, no cookies, no wallet.
          </p>
          <p class="source">Fonts: Sora and Geist Mono, SIL Open Font License 1.1, served with the page. The Portaldot mark is Portaldot's.</p>
        </div>
      </div>
    </footer>
  );
}
