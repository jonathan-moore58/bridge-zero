import type { ComponentChildren } from "preact";
import { Check, Clock, Flame, Lock, Users } from "../components/icons.tsx";
import { Chain, ExtLink, Hash, SectionHead, SourceLine, StatusBadge } from "../components/ui.tsx";
import { DECIMALS, etherscanAddress, etherscanBlock, etherscanTx, MINTER, nodeConsoleBlock, records, SEPOLIA_CHAIN_ID, VAULT } from "../lib/chains.ts";
import { formatDuration, formatInt, formatUnits } from "../lib/format.ts";
import { useField } from "../lib/live.ts";
import { burnId as computeBurnId } from "../lib/proofs.ts";

const RP = records.returnPath;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const rowOf = (tx: string | null) => (tx ? (records.evidence.find((r) => r.tx === tx.toLowerCase())?.n ?? null) : null);
const amount = (u: string | bigint) => formatUnits(BigInt(u), DECIMALS);
/** "12:51 UTC" */
const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;

/** A check's mark: a tick when it passed, a cross when it failed, a hollow dot when nothing was read again. */
function Mark({ state }: { state: "is-ok" | "is-bad" | "is-wait" }) {
  if (state === "is-ok") return <Check />;
  if (state === "is-bad") return <span class="x">×</span>;
  return <span class="cchip__rec" aria-hidden="true" />;
}

function Rec({ children, rows = [] }: { children: ComponentChildren; rows?: (number | null)[] }) {
  const ns = [...new Set(rows.filter((r): r is number => r !== null))].sort((a, b) => a - b);
  const tag = ns.length === 0 ? "" : ns.length === 1 ? ` · row ${ns[0]}` : ` · rows ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`;
  return (
    <div class="rrec">
      <span class="rrec__tag micro">recorded{tag}</span>
      <div class="rrec__body small">{children}</div>
    </div>
  );
}

export function ReturnPath() {
  const minter = useField("sepolia.minter");
  const vault = useField("v3.vault");
  const checks = useField("return.checks");
  const burns = RP.burns.filter((b) => b.txHash && b.ok && b.status === 1);
  const burn = burns[0] ?? null;
  const release = burn ? (RP.releases.find((r) => r.burnId === burn.burnId) ?? null) : null;
  const ran = !!burn && release?.status === "released";
  const opened = release?.approvals.find((a) => a.action === "open") ?? null;
  const executed = release?.approvals.find((a) => a.action === "execute") ?? null;
  const check = burn ? checks.value?.find((c) => c.burnId === burn.burnId) : undefined;
  // Only a live read is a check; a recorded value is shown as the record's.
  const checked = checks.status === "live";
  const recomputed = burn?.burnNonce !== null && burn ? computeBurnId(SEPOLIA_CHAIN_ID, MINTER, BigInt(burn.burnNonce ?? "0")) : null;
  const liveBurns = minter.status === "live" ? Number(minter.value?.burnCount ?? 0n) : null;
  const unrecorded = liveBurns !== null && liveBurns > burns.length;
  const releasedAll = RP.releases.filter((r) => r.status === "released");
  const status = ran ? (releasedAll.length > 1 ? `run ${releasedAll.length} times` : "run once") : burn ? "burned, release pending" : "built, not run yet";
  // A release fast mode ran (the record's "by"), with its burn's and its execution's signing times.
  const fast = releasedAll.find((r) => r.by === "fast") ?? null;
  const fastBurn = fast ? (burns.find((b) => b.txHash === fast.burnTx) ?? null) : null;
  const fastRun = fast?.approvals.find((a) => a.action === "execute") ?? null;
  const fastRows = [rowOf(fast?.burnTx ?? null), rowOf(fastRun?.extrinsicHash ?? null)];
  const idState = checked && check?.onChain ? (check.onChain === burn?.burnId ? "is-ok" : "is-bad") : "is-wait";
  const relState = checked && check?.released === true ? "is-ok" : checked && check?.released === false ? "is-bad" : "is-wait";

  return (
    <section id="return" class="section section--alt" aria-labelledby="return-title">
      <div class="container">
        <SectionHead
          id="return"
          n="06"
          eyebrow="Return path"
          title={
            <>
              The way back is trusted. <em>Said plainly.</em>
            </>
          }
          lead={`wtPOT burned on Sepolia is released on V3 by a ${RP.committee.threshold}-of-${RP.committee.members.length} committee through pallet-multisig. Nothing on V3 checks the burn: this direction rests on the committee, not on a proof.`}
        />
        <ol class="rpath reveal">
          <li class="rstep card">
            <span class="rstep__n num">1</span>
            <Chain which="sepolia" small />
            <h3 class="h3">
              <Flame class="rstep__icon" /> Burn on Sepolia
            </h3>
            <p class="small muted">
              <code class="inline">BridgeMinter.burn(amount, v3Recipient)</code> destroys the caller's wtPOT and emits <code class="inline">BurnRequested</code> with a burn id. Final on Sepolia:
              the minter cannot undo it and does not see the release.
            </p>
            {burn ? (
              <Rec rows={[rowOf(burn.txHash)]}>
                Burn {burn.burnNonce}: <span class="num">{amount(burn.amount)}</span> wtPOT for <Hash value={burn.v3Recipient} head={4} tail={4} copy={false} /> on V3
                <br />
                <Hash value={burn.txHash!} href={etherscanTx(burn.txHash!)} head={6} tail={4} label="burn transaction" /> · block{" "}
                <ExtLink href={etherscanBlock(burn.block ?? 0)}>
                  <span class="num">#{formatInt(burn.block ?? 0)}</span>
                </ExtLink>
              </Rec>
            ) : (
              <Hash value={MINTER} href={etherscanAddress(MINTER)} head={4} tail={4} label="BridgeMinter address" />
            )}
          </li>
          <li class="rstep__edge" aria-hidden="true" />
          <li class="rstep rstep--trust card">
            <span class="rstep__n num">2</span>
            <span class="badge badge--trust">trusted</span>
            <h3 class="h3">
              <Users class="rstep__icon" /> The committee approves
            </h3>
            <p class="small muted">
              Any {RP.committee.threshold} of its {RP.committee.members.length} members sign <code class="inline">multisig.asMulti</code> of a <code class="inline">revive.call</code> to the
              vault's <code class="inline">release</code>, after checking the burn themselves.
            </p>
            {release && opened && executed ? (
              <Rec rows={[rowOf(opened.extrinsicHash), rowOf(executed.extrinsicHash)]}>
                Member {opened.member} opened it at V3{" "}
                <ExtLink href={nodeConsoleBlock(opened.block ?? 0)}>
                  <span class="num">#{formatInt(opened.block ?? 0)}</span>
                </ExtLink>
                , member {executed.member} ran it at{" "}
                <ExtLink href={nodeConsoleBlock(executed.block ?? 0)}>
                  <span class="num">#{formatInt(executed.block ?? 0)}</span>
                </ExtLink>
                <br />
                <Hash value={executed.extrinsicHash} head={6} tail={4} label="the executing extrinsic" />{" "}
                {RP.funding.length > 0 && <span class="dim">· {RP.funding.length} funding transfers before it</span>}
              </Rec>
            ) : (
              <span class="mono small dim">multisig {short(RP.committee.multisig)}</span>
            )}
          </li>
          <li class="rstep__edge" aria-hidden="true" />
          <li class="rstep card">
            <span class="rstep__n num">3</span>
            <Chain which="v3" small />
            <h3 class="h3">
              <Lock class="rstep__icon" /> Release on V3
            </h3>
            <p class="small muted">
              Only the vault's <code class="inline">RELEASER</code>, the committee's multisig address, can call <code class="inline">release</code>: it pays the address the
              committee names, once per burn id, never more than is outstanding.
            </p>
            {release && release.releasedAt ? (
              <Rec rows={[rowOf(executed?.extrinsicHash ?? null)]}>
                <span class="num">{amount(release.amountNative ?? "0")}</span> tPOT paid to <Hash value={release.payee ?? VAULT} head={4} tail={4} copy={false} /> in V3 block{" "}
                <ExtLink href={nodeConsoleBlock(release.releasedAt.number)}>
                  <span class="num">#{formatInt(release.releasedAt.number)}</span>
                </ExtLink>
              </Rec>
            ) : (
              <Hash value={RP.committee.releaser} head={4} tail={4} label="releaser address" />
            )}
          </li>
        </ol>
        <div class="rtime reveal">
          <span class="rtime__icon" aria-hidden="true">
            <Clock />
          </span>
          <p class="small">
            <strong>Why it takes minutes.</strong> Without fast mode, the committee releases only once Sepolia has finalized the burn's block, about 13 to 15 minutes after it.
            {RP.timing ? (
              <>
                {" "}
                That wait is why the recorded way back took about {formatDuration(RP.timing.seconds)}: the burn was sent at {hhmm(RP.timing.burnSentAt)} and the release ran at{" "}
                {hhmm(RP.timing.releaseRunAt)}, by the records' timestamps.
              </>
            ) : null}
            {fast && fastBurn?.signedAt && fastRun?.signedAt ? (
              <>
                {" "}
                Fast mode releases a small burn after a few Sepolia confirmations instead, before Sepolia finalizes it: burn {fast.burnNonce} was sent at {hhmm(fastBurn.signedAt)} and its
                release ran at {hhmm(fastRun.signedAt)}{fastRows[0] && fastRows[1] ? ` (rows ${fastRows[0]} to ${fastRows[1]})` : ""}. A reorg deeper than those confirmations could undo
                a burn after its release.
              </>
            ) : null}{" "}
            And it is trusted: nothing on V3 checks the release against the burn.
          </p>
        </div>
        <div class="rstatus reveal">
          <div class="rstatus__main card">
            <header class="rstatus__head">
              <span class="micro">Status, from the records</span>
              <span class={`badge ${ran ? "badge--trust" : ""}`}>{status}</span>
            </header>
            {burn ? (
              <p class="small muted">
                {amount(burn.amount)} wtPOT burned on Sepolia{ran && release ? `, and ${amount(release.amountNative ?? "0")} tPOT released on V3 by ${release.approvals.length} of the committee's members` : ""}
                {burn.burnNonce !== null ? ` (burn ${burn.burnNonce})` : ""}. The release is the committee's decision: no contract checked it against the burn.
              </p>
            ) : (
              <p class="small muted">
                <code class="inline">burn</code> is in the deployed BridgeMinter and <code class="inline">release</code> in the deployed vault; no burn or release is in{" "}
                <code class="inline">deployments/</code> at this build.
              </p>
            )}
            {unrecorded && (
              <p class="small rnote" role="status">
                BridgeMinter reports {liveBurns} burn{liveBurns === 1 ? "" : "s"} on chain right now (<code class="inline">burnCount()</code>, live); the records this page was built from
                hold {burns.length}, so this page does not describe the newer {liveBurns - burns.length === 1 ? "one" : "ones"}.
              </p>
            )}
            {burn && (
              <ul class="checks rchecks">
                <li class={recomputed === burn.burnId ? "is-ok" : "is-bad"}>
                  <Mark state={recomputed === burn.burnId ? "is-ok" : "is-bad"} />
                  <span>
                    burn id <Hash value={burn.burnId ?? ""} head={6} tail={6} label="burn id" />: keccak-256 of (BridgeZero.Burn.v1, 11155111, minter, {burn.burnNonce}) in this browser{" "}
                    {recomputed === burn.burnId ? "gives the same word" : "gives another word"}
                  </span>
                </li>
                <li class={idState}>
                  <Mark state={idState} />
                  <span>
                    <code class="inline">burnIdOf({burn.burnNonce})</code> on Sepolia:{" "}
                    {!checked ? (checks.status === "loading" ? "reading…" : "not read again (no node answered)") : check?.onChain ? (check.onChain === burn.burnId ? "the same id" : "a different id") : "reading…"}{" "}
                    <StatusBadge field={checks} compact />
                  </span>
                </li>
                <li class={relState}>
                  <Mark state={relState} />
                  <span>
                    <code class="inline">released(burnId)</code> on the V3 vault:{" "}
                    {!checked ? (checks.status === "loading" ? "reading…" : "not read again (no node answered)") : check?.released === undefined || check.released === null ? "reading…" : String(check.released)}{" "}
                    <StatusBadge field={checks} compact />
                  </span>
                </li>
              </ul>
            )}
            <p class="source">
              recorded · deployments/sepolia-bridge.json (the burn) · deployments/v3-testnet.json (funding and releases)
            </p>
          </div>
          <div class="rstatus__live card">
            <dl class="kv">
              <dt>
                Burns <StatusBadge field={minter} compact />
              </dt>
              <dd>
                {minter.value ? (
                  <>
                    <span class="num">{String(minter.value.burnCount)}</span> <span class="dim small">burnCount() on BridgeMinter</span>
                  </>
                ) : (
                  <span class="skel" />
                )}
              </dd>
              <dt>
                Outstanding <StatusBadge field={vault} compact />
              </dt>
              <dd>
                {vault.value ? (
                  <>
                    <span class="num">{amount(vault.value.outstanding)}</span> tPOT <span class="dim small">in the vault for wtPOT; the most a release can pay</span>
                  </>
                ) : (
                  <span class="skel" />
                )}
              </dd>
              <dt>Committee</dt>
              <dd class="mono small">
                {RP.committee.members.map((m) => (
                  <span class="rmember" key={m} title={m}>
                    {short(m)}
                  </span>
                ))}
                <span class="dim"> · {RP.committee.threshold} of {RP.committee.members.length}</span>
              </dd>
              <dt>Multisig</dt>
              <dd>
                <span class="mono small" title={RP.committee.multisig}>
                  {short(RP.committee.multisig)}
                </span>{" "}
                <span class="dim small">as an address</span> <Hash value={RP.committee.releaser} head={4} tail={4} label="releaser address" />
              </dd>
            </dl>
            <SourceLine field={minter} live="eth_call" />
          </div>
        </div>
        {RP.funding.length > 0 && (
          <p class="small dim rfoot">
            Before the release, the testnet account funded the members: {RP.funding.map((f) => `${f.role}, ${amount(f.amount)} tPOT at #${formatInt(f.block ?? 0)}`).join("; ")}. Each
            extrinsic's full hash is in <code class="inline">deployments/v3-testnet.json</code>.
          </p>
        )}
      </div>
    </section>
  );
}
