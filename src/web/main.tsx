import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./App.tsx";
import { connectFeed } from "./feed.ts";
import "./theme.ts";
import "./keyboard.ts";

connectFeed();

const root = document.getElementById("app");
if (root) render(<App />, root);

// Installed on a phone or tablet, the board opens to an offline page when the
// Mac can't be reached; the worker caches the app shell and never board data.
if ("serviceWorker" in navigator && window.isSecureContext) {
	navigator.serviceWorker.register("sw.js").catch(() => {});
}
