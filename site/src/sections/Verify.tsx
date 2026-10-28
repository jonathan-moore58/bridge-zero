import { useState } from "preact/hooks";
import { Chevron, Doc, GitHub, Terminal } from "../components/icons.tsx";
import { CopyButton, ExtLink, Md, SectionHead } from "../components/ui.tsx";
import { etherscanTx, records, REPO, repoFile, repoTree } from "../lib/chains.ts";
import { shortHex } from "../lib/hex.ts";

const V = records.verify;

const LINKS = [
  { href: REPO, label: "The repository", sub: "contracts, relayer, records", icon: <GitHub /> },
  { href: `${REPO}#evidence`, label: "The evidence table", sub: `${records.evidence.length} transactions, each with its result`, icon: <Doc /> },
  { href: `${REPO}#verify-it-yourself`, label: "README: Verify it yourself", sub: "these commands, and checks without chain access", icon: <Doc /> },
  { href: repoFile("docs/BRIDGE.md"), label: "docs/BRIDGE.md", sub: "from a lock to wtPOT, and back", icon: <Doc /> },
  { href: repoFile("docs/DECISIONS.md"), label: "docs/DECISIONS.md", sub: "the design decisions and why", icon: <Doc /> },
  { href: repoTree("deployments"), label: "deployments/", sub: "every transaction, recorded", icon: <Doc /> },
];

/** The groups shown before "show all": the light clients, the thresholds, the state roots, the minter. */
const FIRST_GROUPS = 4;

/** The explorers the README links the rollups' evidence rows to. */
const ROLLUP_SCAN = { "base-sepolia": "https://sepolia.basescan.org", "arbitrum-sepolia": "https://sepolia.arbiscan.io" } as const;

/**
 * A command, wrapped only between its words: a flag such as --rpc-url or a variable stays whole on
 * its line, and only a hash too long for the line breaks inside. The text copied is the same.
 */
function CmdText({ cmd }: { cmd: string }) {
  return (
    <>
      {cmd.split(/( +)/).map((t, i) => (/^ +$/.test(t) || t === "" ? t : <span key={i} class={t.length > 24 ? "tok tok--long" : "tok"}>{t}</span>))}
    </>
  );
}

export function Verify() {
  const [showAll, setShowAll] = useState(false);
  const [allCommands, setAllCommands] = useState(false);
  const total = V ? V.groups.reduce((n, g) => n + g.commands.length, 0) : 0;
  const shownGroups = V ? (allCommands ? V.groups : V.groups.slice(0, FIRST_GROUPS)) : [];
  const hidden = V ? V.groups.slice(shownGroups.length).reduce((n, g) => n + g.commands.length, 0) : 0;
  return (
    <section id="verify" class="section" aria-labelledby="verify-title">
      <div class="container">
        <SectionHead
          id="verify"
          n="07"
          eyebrow="Verify it yourself"
          title={
            <>
              This page reads the chains. <em>You can too, without it.</em>
            </>
          }
          lead="The README's commands, as it lists them: they read the chains with Foundry's cast and sign nothing. The comment under each is the output the README recorded; a later mint, burn or release changes some of them."
        />
        <div class="verify reveal">
          <div class="term card">
            <header class="term__bar">
              <span class="term__dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span class="term__title">
                <Terminal /> bash · read-only · from README.md
              </span>
              {V && (
                <span class="term__copyall">
                  <CopyButton text={V.text} label="all commands" />
                  <span class="small dim">copy all</span>
                </span>
              )}
            </header>
            {V ? (
              <div class="term__body">
                <div class="term__cmd term__cmd--env">
                  <pre>
                    <code>{V.env.join("\n")}</code>
                  </pre>
                  <CopyButton text={V.env.join("\n")} label="the RPC variables" />
                </div>
                {shownGroups.map((g, gi) => (
                  <div class="term__group" key={gi}>
                    {g.what.length > 0 && <p class="term__what">{g.what.join(" ")}</p>}
                    {g.commands.map((c) => (
                      <div class="term__cmd" key={c.cmd}>
                        <pre>
                          <code>
                            <span class="term__prompt" aria-hidden="true">
                              ${" "}
                            </span>
                            <CmdText cmd={c.cmd} />
                            {c.output.length > 0 && (
                              <span class="term__out">
                                {"\n"}
                                {c.output.map((o) => `# ${o}`).join("\n")}
                              </span>
                            )}
                            {c.now && (
                              <span class="term__now" title="The README recorded the output above before a later mint, burn or release; this is the value deployments/ gives at this build">
                                {"\n"}# deployments/ at this build: {c.now}
                              </span>
                            )}
                          </code>
                        </pre>
                        <CopyButton text={c.cmd} label="this command" />
                      </div>
                    ))}
                  </div>
                ))}
                {V.groups.length > FIRST_GROUPS && (
                  <div class="term__more">
                    <button type="button" class="disclose" aria-expanded={allCommands} onClick={() => setAllCommands(!allCommands)}>
                      <Chevron />
                      {allCommands ? "Show the first commands only" : `Show the other ${hidden} of the README's ${total} commands`}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <p class="term__body small dim">The README at this build has no Verify it yourself block.</p>
            )}
          </div>
          <nav class="vlinks" aria-label="Sources">
            {LINKS.map((l) => (
              <a class="vlink card spot" href={l.href} target="_blank" rel="noopener noreferrer" key={l.href}>
                <span class="vlink__icon">{l.icon}</span>
                <span class="vlink__text">
                  <span class="vlink__label">{l.label}</span>
                  <span class="small dim">{l.sub}</span>
                </span>
                <span class="sr-only"> (opens in a new tab)</span>
              </a>
            ))}
          </nav>
        </div>
        <div class="evidence reveal">
          <button type="button" class="disclose" aria-expanded={showAll} aria-controls="evidence-list" onClick={() => setShowAll(!showAll)}>
            <Chevron />
            {showAll ? "Hide" : "Show"} all {records.evidence.length} recorded transactions, from the README's evidence tables
          </button>
          <div id="evidence-list" hidden={!showAll}>
            {showAll && (
              <ol class="evlist">
                {records.evidence.map((r) => (
                  <li class={`evrow ${/revert/.test(r.result) ? "is-revert" : ""} ${r.n === records.bridge.row ? "is-hero" : ""}`} key={r.n}>
                    <span class="evrow__n num">{r.n}</span>
                    <span class="evrow__what small">
                      <Md text={r.what} />
                    </span>
                    <span class="evrow__tx">
                      {r.chain !== "v3" && r.tx ? (
                        <ExtLink href={r.chain === "sepolia" ? etherscanTx(r.tx) : `${ROLLUP_SCAN[r.chain]}/tx/${r.tx}`} class="mono small">
                          {shortHex(r.tx, 6, 4)}
                        </ExtLink>
                      ) : r.blockUrl ? (
                        <ExtLink href={r.blockUrl} class="mono small" title="We found no indexed explorer for the V3 testnet: the Node Console shows the block">
                          V3 #{r.block.toLocaleString("en-US")}
                        </ExtLink>
                      ) : (
                        <span class="mono small">{r.txText}</span>
                      )}
                    </span>
                    <span class="evrow__res small">
                      <Md text={r.result} />
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
