// The auto-mint's entry point (npm run automint): automint.ts only defines it, so its tests can
// import it, and this file always runs it, whatever path it is started by (as relay-main.ts).

import { errorText, FAILED, main } from "./automint.js";

/** Ends with `code` once nothing is left to run, or 10 s later at the latest (a socket still closing; see relay.ts exit). */
function exit(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 10_000).unref();
}

main().then(exit, (error: unknown) => {
  console.log(`FAIL ${errorText(error)}`);
  exit(FAILED);
});
