import { render } from "preact";
import { startLive } from "../lib/live.ts";
import { App } from "./App.tsx";
import { startPolka } from "./polkadot.ts";
import { startSends } from "./sends.ts";
import { insertSprite } from "./sprite.ts";
import { startWallet } from "./wallet.ts";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/bg.css";
import "./styles/app.css";
import "./styles/screens.css";
import "./styles/v3.css";

insertSprite();
const root = document.getElementById("app");
if (root) {
  render(<App />, root);
  startLive();
  startWallet();
  startPolka();
  startSends();
}
