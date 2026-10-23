// The relayer's entry point (npm run relay): relay.ts only defines the relayer, so its tests can
// import it, and this file always runs it, whatever path it is started by.

import { check, errorText, exit, FAILED, main } from "./relay.js";

main().then(exit, (error: unknown) => {
  check(false, errorText(error));
  exit(FAILED);
});
