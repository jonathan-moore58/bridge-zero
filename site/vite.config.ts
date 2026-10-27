import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { buildRecords } from "./build/records.ts";

const here = dirname(fileURLToPath(import.meta.url));
// RECORDS_ROOT builds the page from another checkout's records (a newer README, say).
const repoRoot = process.env.RECORDS_ROOT ? resolve(process.env.RECORDS_ROOT) : resolve(here, "..");

/** The repository's records (deployments/, fixtures/, README.md, contract sources) as `virtual:records`. */
function records(): Plugin {
  const id = "virtual:records";
  const resolved = "\0" + id;
  return {
    name: "bridge-zero-records",
    resolveId(source) {
      return source === id ? resolved : null;
    },
    load(source) {
      if (source !== resolved) return null;
      for (const dir of ["deployments", "fixtures", "contracts/src"]) this.addWatchFile(resolve(repoRoot, dir));
      this.addWatchFile(resolve(repoRoot, "README.md"));
      return `export default ${JSON.stringify(buildRecords(repoRoot))};`;
    },
  };
}

/** Endpoints the page may reach: the RPC nodes and nothing else. */
const CONNECT = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://sepolia.gateway.tenderly.co",
  "https://test-evm-rpc-v3.portaldot.dev",
  "https://test-node-v3.portaldot.dev",
  "wss://test-node-v3.portaldot.dev",
  "wss://mainnet.portaldot.io",
];

/** A Content-Security-Policy for the built page (not the dev server, which needs its own socket). */
function csp(): Plugin {
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${CONNECT.join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
  return {
    name: "bridge-zero-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace("<!--csp-->", `<meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

/**
 * Preloads the two variable fonts the first screen is set in, so the text does not reflow when they
 * arrive: one <link rel="preload"> per font file the build emits.
 */
function preloadFonts(): Plugin {
  let base = "/";
  return {
    name: "bridge-zero-preload-fonts",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => /\/(sora|geist-mono)-latin-wght-normal-[\w-]+\.woff2$/.test(f));
        if (files.length !== 2) throw new Error(`expected the Sora and Geist Mono font files in the bundle, found ${files.length}`);
        return files.sort().map((f) => ({
          tag: "link",
          attrs: { rel: "preload", as: "font", type: "font/woff2", href: `${base}${f}`, crossorigin: true },
          injectTo: "head" as const,
        }));
      },
    },
  };
}

export default defineConfig({
  base: "/bridge-zero/",
  plugins: [records(), csp(), preloadFonts()],
  resolve: {
    // @polkadot/api's crypto runs on its JavaScript paths: the page's CSP lets no WebAssembly start,
    // so the 220 KB WebAssembly build is replaced by a stub that is never ready (src/app/substrate/wasm-crypto-stub.ts).
    alias: { "@polkadot/wasm-crypto": resolve(here, "src/app/substrate/wasm-crypto-stub.ts") },
  },
  oxc: {
    jsx: { runtime: "automatic", importSource: "preact" },
  },
  build: {
    target: "es2022",
    // Two pages: the status page, and the bridge app at /app/.
    rolldownOptions: {
      input: { main: resolve(here, "index.html"), app: resolve(here, "app/index.html") },
    },
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: { port: 5173, strictPort: false },
  preview: { port: 4173, strictPort: false },
});
