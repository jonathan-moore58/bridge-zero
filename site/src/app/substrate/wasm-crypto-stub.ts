// What the page bundles in place of @polkadot/wasm-crypto (vite.config.ts, resolve.alias): a
// WebAssembly build that is never ready. The page's Content-Security-Policy does not let
// WebAssembly start, and @polkadot/util-crypto then takes its JavaScript paths (@noble/hashes,
// @scure), which do all the lock needs: blake2, xxhash and SS58. The wallet signs, not the page.
// Without it the lazy chunk carries about 220 KB of WebAssembly that could never run here. These
// are the names @polkadot/util-crypto 14.0.3 imports from it.

const never = (): never => {
  throw new Error("@polkadot/wasm-crypto is not in this page: its JavaScript paths are used");
};

export const isReady = (): boolean => false;
export const waitReady = async (): Promise<boolean> => false;

export const bip39Generate = never;
export const bip39ToEntropy = never;
export const bip39ToMiniSecret = never;
export const bip39ToSeed = never;
export const bip39Validate = never;
export const blake2b = never;
export const ed25519KeypairFromSeed = never;
export const ed25519Sign = never;
export const ed25519Verify = never;
export const hmacSha256 = never;
export const hmacSha512 = never;
export const keccak256 = never;
export const keccak512 = never;
export const pbkdf2 = never;
export const scrypt = never;
export const secp256k1Compress = never;
export const secp256k1Expand = never;
export const secp256k1FromSeed = never;
export const secp256k1Recover = never;
export const secp256k1Sign = never;
export const sha256 = never;
export const sha512 = never;
export const twox = never;
export const packageInfo = { name: "@polkadot/wasm-crypto", path: "", type: "esm", version: "0.0.0-stub" };
