import type { ComponentChildren } from "preact";
import { Check, Cpu, HashSign, Key, Lock, Replay, Shield, Signature, Tree, Users } from "../components/icons.tsx";
import { Hash, SectionHead, StatusBadge } from "../components/ui.tsx";
import { etherscanAddress, LC, records } from "../lib/chains.ts";
import { useField } from "../lib/live.ts";

function Item({ icon, title, children, tone }: { icon: ComponentChildren; title: string; children: ComponentChildren; tone: "verify" | "trust" }) {
  return (
    <li class={`titem titem--${tone}`}>
      <span class="titem__icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <h4 class="titem__title">{title}</h4>
        <p class="small muted">{children}</p>
      </div>
    </li>
  );
}

const N_MAIN = LC.mainnet.fixtureSet.keys.length;
const N_V3 = LC.v3.fixtureSet.keys.length;
const thresholdOf = (n: number) => n - Math.floor((n - 1) / 3);

export function Trust() {
  const main = useField("lc.mainnet");
  const v3 = useField("lc.v3");
  const admin = main.value?.admin ?? v3.value?.admin ?? null;
  const sameAdmin = main.value?.admin && v3.value?.admin && main.value.admin === v3.value.admin;
  const committee = records.returnPath.committee;
  return (
    <section id="trust" class="section" aria-labelledby="trust-title">
      <div class="container">
        <SectionHead
          id="trust"
          n="05"
          eyebrow="Trust map"
          title={
            <>
              What is checked, and what is trusted. <em>Both, plainly.</em>
            </>
          }
          lead="No relayer is trusted: whoever sends a transaction only brings data, and the contracts check it. What the contracts cannot check is trusted, and listed here too."
        />
        <ol class="flow reveal" aria-label="The path of a lock, and what each part rests on">
          <li class="flow__node flow__node--trust">
            <Users />
            <span>Portaldot validators</span>
            <span class="badge badge--trust">trusted</span>
          </li>
          <li class="flow__edge" aria-hidden="true">
            <span>signatures</span>
          </li>
          <li class="flow__node">
            <Cpu />
            <span>Light client</span>
            <span class="badge badge--verify">checks</span>
          </li>
          <li class="flow__edge" aria-hidden="true">
            <span>state root</span>
          </li>
          <li class="flow__node">
            <Tree />
            <span>BridgeMinter</span>
            <span class="badge badge--verify">checks</span>
          </li>
          <li class="flow__edge" aria-hidden="true">
            <span>mint</span>
          </li>
          <li class="flow__node">
            <Lock />
            <span>wtPOT</span>
          </li>
        </ol>
        <div class="trust reveal">
          <div class="trust__col trust__col--verify card">
            <header class="trust__head">
              <span class="badge badge--verify">
                <Check /> verified on chain
              </span>
              <p class="small dim">Every import and every mint, by the contracts on Sepolia.</p>
            </header>
            <ul class="tlist">
              <Item tone="verify" icon={<Signature />} title="GRANDPA signatures">
                Each counted precommit is an ed25519 signature, over the message the light client rebuilds on chain, by a key of the set it follows. At least N − ⌊(N − 1) / 3⌋ of
                them: {main.value?.threshold ?? thresholdOf(N_MAIN)} of {N_MAIN} on the old mainnet, {v3.value?.threshold ?? thresholdOf(N_V3)} of {N_V3} on V3.
              </Item>
              <Item tone="verify" icon={<HashSign />} title="The header hash">
                The header's blake2b-256 has to be the block the validators signed, so the state root inside it is the finalized one.
              </Item>
              <Item tone="verify" icon={<Tree />} title="Storage proofs">
                The vault's account entry, its child-trie root and commitments[nonce] are trie walks from that state root. Every item is found by its hash.
              </Item>
              <Item tone="verify" icon={<Shield />} title="The commitment">
                The minter recomputes it with its own chain id and address, the vault, and the lock's recipient, amount and nonce. The proven word has to be exactly that.
              </Item>
              <Item tone="verify" icon={<Replay />} title="The nonce">
                A lock mints once: used[nonce] is set before the mint, and the same proof sent again reverts.
              </Item>
            </ul>
          </div>
          <div class="trust__col trust__col--trust card">
            <header class="trust__head">
              <span class="badge badge--trust">trusted</span>
              <p class="small dim">What the contracts cannot check.</p>
            </header>
            <ul class="tlist">
              <Item tone="trust" icon={<Users />} title="The Portaldot validator set">
                More than two thirds of a set can finalize any block, with any state root. V3 has {N_V3} validators, probably development keys; the old mainnet has {N_MAIN}.
              </Item>
              <Item tone="trust" icon={<Key />} title="Each chain's sudo key">
                A sudo key can change any account's code or storage, and a light client cannot rule that out. V3: <span class="mono">{short(LC.v3.sudo.ss58)}</span>; old mainnet:{" "}
                <span class="mono">{short(LC.mainnet.sudo.ss58)}</span> (Sudo.Key, from the node probes).
              </Item>
              <Item tone="trust" icon={<Cpu />} title="Each light client's admin">
                It set the checkpoint, the first validator set, and can pause a client and install a new checkpoint while it is paused or halted, so it could make a client accept a
                state root of its choosing: it is trusted like the validator set.{" "}
                {admin ? (
                  <span class="nowrap">
                    Admin{sameAdmin ? " of both" : ""}: <Hash value={admin} href={etherscanAddress(admin)} head={4} tail={4} label="admin address" /> <StatusBadge field={main} compact />
                  </span>
                ) : null}
              </Item>
              <Item tone="trust" icon={<Users />} title="The return path">
                Any {committee.threshold} of the {committee.members.length} committee members release tPOT on V3, up to what is outstanding, to any address. Nothing on V3 checks the
                burn.
              </Item>
            </ul>
          </div>
        </div>
        <div class="trust__foot reveal">
          <p class="small">
            <strong>Not trusted:</strong> the relayer, or anyone else who sends an import or a mint. They bring headers, signatures and proofs; a copied mint mints to the same
            recipient.
          </p>
          <p class="small dim">
            Testnet only. The ed25519, BLAKE2b and trie code the contracts use is vendored and treated as unaudited for this use.
          </p>
        </div>
      </div>
    </section>
  );
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
