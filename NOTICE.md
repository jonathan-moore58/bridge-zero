# Third-party code

Each entry gives the source, the pinned commit or tag, the licence, and whether we
changed it. Unmodified dependencies are pulled in as git submodules under
`contracts/lib/`.

| Library | Source | Pinned at | Licence | Use | Changes |
|---|---|---|---|---|---|
| forge-std | https://github.com/foundry-rs/forge-std | v1.17.0 (`f3dae6e6ee381f25eb6a246f7da9b85c91a68219`) | MIT OR Apache-2.0 | Foundry test framework | none |
| crypto-lib (SCL) | https://github.com/get-smooth/crypto-lib | `d714e9824e2e2e44be3c8fd498e0de651ddc9425` (2024-12-14) | MIT; `external/sha512/LibBytes.sol`, which the build compiles, also keeps its 2018 ZeroEx Apache-2.0 notice | ed25519 signature verification (`SCL_EIP6565`), chosen by the gas benchmark (`docs/GAS.md`) | none |
| blake2b-solidity | https://github.com/dhl/blake2b-solidity | `a0aa6db4390cd7dc8283f990dbc5d272f9575e64` (2024-10-16) | MIT | BLAKE2b over the EIP-152 precompile: header hashes, trie node hashes, storage key hashes | none |
| solidity-merkle-trees | https://github.com/polytope-labs/solidity-merkle-trees | `6bbc83d5ac33f85761725cf2eba4f8700164e8ba` (2026-06-26) | Apache-2.0 | Substrate storage proof verification (`PolkadotTrie`) | none |
| solidity-merkle-trees, `src/PolkadotTrie.sol` (modified copy at `contracts/src/trie/vendor/PolkadotTrie.sol`) | https://github.com/polytope-labs/solidity-merkle-trees | `6bbc83d5ac33f85761725cf2eba4f8700164e8ba` (2026-06-26) | Apache-2.0 | Substrate storage proof walk with blake2b-256 node hashes | modified: node hash `keccak256` changed to blake2b-256 (original line 69); `VerifyProof` and `ReadChildProof` changed from `pure` to `view`; imports point at the unmodified originals in `contracts/lib/solidity-merkle-trees` |

Apart from forge-std, none of these repositories has release tags, so each is pinned at its
default-branch head of Oct 14, 2026.

The gas benchmark also measured two other ed25519 libraries, which were removed after it:
chengwenxi/Ed25519 (https://github.com/chengwenxi/Ed25519, `34d8c5701c8f73c4be68f3f6fdd50cba0e40f1af`,
Apache-2.0) and farcaster-solidity (https://github.com/pavlovdog/farcaster-solidity,
`cbb770d8b722ea8c3c165ad97c649e07aaf91fc0`, Apache-2.0 per its file headers). The commit that
adds `docs/GAS.md` still has them.

A modified copy of a single file lives under `contracts/src/**/vendor/`. It keeps its original
copyright and licence header and says at the top what was changed.

## npm packages (relayer)

Installed from npm at the exact versions in `relayer/package.json` (resolved in
`relayer/package-lock.json`); nothing is copied into the repository.

| Package | Source | Version | Licence | Use | Changes |
|---|---|---|---|---|---|
| @noble/hashes | https://github.com/paulmillr/noble-hashes | 2.4.0 | MIT | BLAKE2b hashing | none |
| @noble/curves | https://github.com/paulmillr/noble-curves | 2.4.0 | MIT | ed25519 signature checks | none |
| @polkadot/api | https://github.com/polkadot-js/api | 17.0.2 | Apache-2.0 | the V3 vault tool (`relayer/src/v3-vault.ts`): reviveApi dry runs, the sr25519 key and signing of `revive.instantiateWithCode`, extrinsic status and events | none |
| tsx (dev) | https://github.com/privatenumber/tsx | 4.23.15 | MIT | runs the TypeScript sources | none |
| typescript (dev) | https://github.com/microsoft/TypeScript | 6.0.3 | Apache-2.0 | type checking | none |
| @types/node (dev) | https://github.com/DefinitelyTyped/DefinitelyTyped | 24.19.0 | MIT | Node.js type definitions | none |

@polkadot/api brings the rest of polkadot-js with it (`@polkadot/*`, Apache-2.0) and their own
dependencies (rxjs, Apache-2.0; tslib, 0BSD; bn.js, ws, @scure/*, @noble/* 1.x and others, MIT), at
the versions `relayer/package-lock.json` resolves. `@polkadot/rpc-provider` also lists
`@substrate/connect` 0.8.11 as an optional dependency, which npm installs with two packages of its
own (GPL-3.0-only): it serves only `ScProvider`, a light client the caller has to pass it to, and no
code here loads it.

## Logos (the bridge app)

The bridge app (`site/app/`) shows each chain and each Polkadot wallet by its owner's own mark,
where the owner's terms allow it. Each file in `site/src/app/marks/` is the owner's file, byte for
byte: nothing is redrawn, recoloured, cropped or resized, and the build serves it as it is
(`site/vite.config.ts` inlines no asset). A chain's mark sits in the app's round chip; a wallet's
mark is shown in the wallet picker's rounded icon frame, as every wallet's own icon is. Ethereum
wallets are shown with the icon they announce themselves (EIP-6963), which the app does not ship.
Each mark names its chain or wallet, and only that: no partnership or endorsement is implied. The
names and marks are their owners' trademarks. Downloaded on Oct 28, 2026; the SHA-256 is of the
file as it is in the repository. The app's Network page links here, for the credit CC BY 4.0 asks.

### Shown

| File | Mark | Source | Licence or terms of use | SHA-256 |
|---|---|---|---|---|
| `portaldot.png` | Portaldot, for the Portaldot V3 testnet | `icons/chains/portaldot.png` in Portaldot's wallet list, https://github.com/portaldotVolunteer/wallet-list at `7eb4a9ce8e0e0a4e4518b34c56e2dc5f4fb556be` (Portaldot's GitHub organisation, which https://portaldot.world links); the same mark as https://portaldot.world/brand/portaldot-logo.png, at 150 px | No licence file in the repository; portaldot.world states no terms for its mark. Portaldot's name and mark, used to name its chain | `43057a8129e3c4ac660de3516d21215552d90aa76f26b4168476e70050000f8a` |
| `ethereum.svg` | The ETH diamond (color filled), for Ethereum Sepolia | https://ethereum.org/images/assets/svgs/eth-glyph-colored.svg, "ETH diamond (color filled)" in "Ethereum brand assets" on https://ethereum.org/en/assets/; chosen over the purple diamond, whose facets fall to 2.0:1 against the app's dark chip | ethereum.org's Terms of Use (https://ethereum.org/en/terms-of-use/): material on the site other than code is licensed under Creative Commons Attribution 4.0 International (https://creativecommons.org/licenses/by/4.0/) unless marked otherwise; its trademark clause covers the Foundation's own name and logo. ETH diamond (color filled) by ethereum.org, CC BY 4.0, unmodified | `86ba3592277849e5bf173705788634e35ee202600cf6e6c029e0fe6b9f1b3eb6` |
| `portaldot-wallet.png` | The Portaldot Wallet extension's icon | `images/icon-128.png`, the icon its `manifest.json` names, in `Portaldot-Extension.zip`, https://github.com/portaldotVolunteer/Portaldot-Extension at `47fc187ae18de4c08c21839e73a5f328eafe9493` (the extension portaldot.world links on the Chrome Web Store) | No licence file in the repository. Portaldot's mark, used to name its wallet | `9edf681300d3c54d661d67dc2e2e2371e2c572a849217a757d7c2f9fe64c885d` |
| `polkadot-js.svg` | polkadot{.js} | `packages/extension-ui/src/assets/pjs.svg`, https://github.com/polkadot-js/extension at `54f44022004f4cefb4a2b929f3a397715a134d6f` | Apache-2.0, the repository's licence; it grants no right to the polkadot{.js} name or mark beyond naming the work, which is all this does | `fa351eb26e8e546d21fdf8eee29b8fcde2c612943f2b49d02a83e489ccc7b0ac` |
| `talisman.svg` | Talisman's icon (red) | `Talisman Logos/2-Icons/Icons_red.svg` in "Talisman Logo Pack.zip", Talisman's Brand / Media Kit, https://docs.talisman.xyz/talisman/external-resources/brand-media-kit | No licence stated. The kit's logo usage guidelines: the logo can be used on its own and cannot be arbitrarily modified. Not taken from Talisman's repository, whose licence (The Talisman Licence, since Jul 8, 2026) grants no right to publish its files | `274c5129a421abf15b10c7aacf3a7c4df9d23b08d992233b18d5dc28f14680b0` |

Portaldot's wallet list also has an app icon for the V3 testnet itself
(`patch/patch-chains-icon/portaldot_v3_test.png`, a white tile): the app shows Portaldot's mark
instead, which reads on its dark surfaces.

### Marks whose owners' terms ask for approval

These three owners' terms ask for written approval before anyone uses their mark, and none has
been asked yet. On Oct 28 the project's owner chose to show Base's and Arbitrum's marks to name
their networks, as multichain pages do, following each brand's rules (Base's Square on a white
ground at half the chip; Arbitrum's all-white logomark on the dark chip; the wallet button's status
dot outside both). SubWallet's stays held back: `site/src/app/marks.tsx` does not import its file,
so the build does not ship it, and SubWallet shows the generic wallet icon.

| File | Mark | Source | The terms | SHA-256 |
|---|---|---|---|---|
| `base.svg` | Base's Square (blue), for Base Sepolia | `logo/TheSquare/Digital/Base_square_blue.svg` in Base's brand kit, https://github.com/base/brand-kit at `eba9e730be34f8c9ae7f9a21f32cc6aafebe2ad1` (linked from https://brand.base.org/) | Base's Terms of Service (https://docs.base.org/terms-of-service, last updated Apr 8, 2026) govern the Base Testnet, which the app reads; under Acceptable Use the user agrees not to "Use any Coinbase brands, logos, or trademarks (or any brands, logos, or trademarks that are confusingly similar) without our express prior written approval, which we may withhold at our discretion for any reason", and the same terms count "the Base logo, the Base name" among Coinbase's marks. The brand kit has no licence file, and the brand guide grants no permission. Shown, the guide's App Icons rule (https://brand.base.org/core-identifiers) would apply: "place the blue Square on a white ground: no gradients, borders, or drop shadows", and "in a circular mask, reduce to fifty percent" | `b4f2b487011713f98481cc53c4ce095629b4876acbdbc2f0f3ad69a9688ba82e` |
| `arbitrum.svg` | The Arbitrum logomark, secondary (all white), for Arbitrum Sepolia | `0923_Arbitrum_Logos_zip/Arbiturm-logomark_AllWhite_RGB/0923_Arbitrum_Logos_Logomark_RGB.svg` in `AllVersionsOfArbitrumLogos.zip`, attached to "Arbitrum brand guidelines" in the Arbitrum Foundation's brand kit, https://arbitrumfoundation.notion.site/Arbitrum-Brand-Kit-48751dc5e03240a5872496283f088f79 (linked from https://arbitrum.foundation/). The all-white version because the guidelines say: "Do ensure excellent readability by using the secondary version of the Arbitrum logo against a dark and clean background", and the primary's navy hexagon is 1.3:1 against the app's chip | The guidelines' "9. Legal": "Use of our brand assets must be expressly authorized in writing (including, in many cases, pursuant to the related product or service license agreement or similar arrangement)." No licence is stated; inquiries go to partnerships@arbitrum.io. Shown, the guidelines' other rules would apply: colours and proportions unchanged, no drop shadow, never below 12 px, and "Don't place your logo or anything within the clear space" | `939aa2f49ee22058c05c115de0a4f0c95ffd7a57e121df25de893cecca4036db` |
| `subwallet.png` | SubWallet's mark (gradient) | `packages/extension-koni/public/images/subwallet/gradient-logo.png`, https://github.com/Koniverse/SubWallet-Extension at `1f9b2a4cb6fea68193e5e012dcca7284a1dd0d80` | SubWallet's Branding Kit (https://brand.koni.studio/subwallet-brand-kit.html, in Koni Studio's brand center), under its rules: "Don't imply a partnership: Use the logo only in approved co-marketing contexts. Submit for review before publishing."; its footer: "Branding Kit v1.0.1 · Partner use only"; approvals: partners@koni.studio. The "Brand Kit" link on https://subwallet.app downloads https://codeload.github.com/Koniverse/SubWallet-Branding-Kit/zip/refs/heads/main, a repository with no README or licence. The extension's Apache-2.0 licence grants no trademark rights (its section 6) | `c6d6ec63d1c4782a6364463df6f69217fb6ec6c54101926558fe765b15c7ff5a` |
