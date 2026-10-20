import { render } from "preact";
import { App } from "./app.tsx";
import { startLive } from "./lib/live.ts";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/hero.css";
import "./styles/sections.css";

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
  startLive();
}
