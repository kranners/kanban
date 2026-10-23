import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./App.tsx";
import { connectFeed } from "./feed.ts";
import "./theme.ts";

connectFeed();

const root = document.getElementById("app");
if (root) render(<App />, root);
