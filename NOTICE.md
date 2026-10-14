# Third-party code

Each entry gives the source, the pinned commit or tag, the licence, and whether we
changed it. Unmodified dependencies are pulled in as git submodules under
`contracts/lib/`.

| Library | Source | Pinned at | Licence | Use | Changes |
|---|---|---|---|---|---|
| forge-std | https://github.com/foundry-rs/forge-std | v1.17.0 (`f3dae6e`) | MIT OR Apache-2.0 | Foundry test framework | none |

## npm packages (relayer)

Installed from npm at the exact versions in `relayer/package.json` (resolved in
`relayer/package-lock.json`); nothing is copied into the repository.

| Package | Source | Version | Licence | Use | Changes |
|---|---|---|---|---|---|
| @noble/hashes | https://github.com/paulmillr/noble-hashes | 2.4.0 | MIT | BLAKE2b hashing | none |
| @noble/curves | https://github.com/paulmillr/noble-curves | 2.4.0 | MIT | ed25519 signature checks | none |
| tsx (dev) | https://github.com/privatenumber/tsx | 4.23.15 | MIT | runs the TypeScript sources | none |
| typescript (dev) | https://github.com/microsoft/TypeScript | 6.0.3 | Apache-2.0 | type checking | none |
| @types/node (dev) | https://github.com/DefinitelyTyped/DefinitelyTyped | 24.19.0 | MIT | Node.js type definitions | none |
