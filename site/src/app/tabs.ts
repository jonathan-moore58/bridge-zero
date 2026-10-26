// One tab of this browser follows each transfer: the tab that holds the transfer's Web Lock. That tab
// alone asks the wallet for the transfer's next step and writes it in the journal; any other tab
// shows it as the journal has it, and takes it over when the tab that follows it closes, which
// releases the lock to it, or when its visitor acts on the transfer there (the lock is taken from
// the other tab, which stops following it). So two tabs never both run a transfer, and a tab never
// reads a transfer as not sent while another tab's wallet prompt for it is open. Without Web Locks
// (an older browser), each tab follows what it holds, as one tab would.

const owned = new Set<string>();
/** Transfers this tab waits for, its request queued behind the tab that follows them. */
const queued = new Set<string>();

let lost: (id: string) => void = () => undefined;

const lockName = (id: string): string => `bz-app.transfer.${id}`;

/** The browser's LockManager (named so, as Node's types, which the tests check this with, keep it in a module). */
type Locks = Navigator["locks"];

function manager(): Locks | null {
  try {
    return typeof navigator !== "undefined" && "locks" in navigator && navigator.locks ? navigator.locks : null;
  } catch {
    return null;
  }
}

/** Held until the tab closes, which releases it, or until another tab takes it. */
const forever = (): Promise<void> => new Promise<void>(() => undefined);

function hold(locks: Locks, id: string, steal: boolean, then: () => void): void {
  if (!steal) queued.add(id);
  locks
    .request(lockName(id), { steal }, () => {
      if (!steal) queued.delete(id);
      owned.add(id);
      try {
        then();
      } catch {
        // The transfer's own run settles its errors; the lock stays held either way.
      }
      return forever();
    })
    .catch(() => {
      if (!steal) queued.delete(id);
      // Taken by another tab, where the visitor acted on it.
      if (owned.delete(id)) lost(id);
    });
}

/** Whether this tab follows the transfer: only then does it ask the wallet for it, or write it in the journal. */
export const follows = (id: string): boolean => owned.has(id) || manager() === null;

/** What this tab does when another takes a transfer from it: stop running it, and wait to take it back. */
export function onTaken(fn: (id: string) => void): void {
  lost = fn;
}

/** A transfer this tab has just started: no other tab knows its id, so this one follows it from now on. */
export function own(id: string): void {
  if (owned.has(id)) return;
  owned.add(id);
  // Requested now, before the journal names the id, so that a tab that reads it there waits its turn.
  const locks = manager();
  if (locks) hold(locks, id, false, () => undefined);
}

/**
 * A transfer this tab read from the journal: `then` runs once this tab follows it, at once when no
 * other tab does, else when that tab closes.
 */
export function claim(id: string, then: () => void): void {
  const locks = manager();
  if (owned.has(id) || !locks) {
    owned.add(id);
    then();
    return;
  }
  if (!queued.has(id)) hold(locks, id, false, then);
}

/** A transfer another tab follows, taken from it now for the visitor acting on it here: `then` runs once this tab follows it. */
export function take(id: string, then: () => void): void {
  const locks = manager();
  if (owned.has(id) || !locks) {
    owned.add(id);
    then();
    return;
  }
  hold(locks, id, true, then);
}
