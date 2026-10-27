import "./demo.css";
import { createBackend } from "./backend.ts";
import { calm } from "./calm.ts";
import { headline } from "./headline.ts";
import { install } from "./shim.ts";

const params = new URLSearchParams(location.search);
const big = params.get("scenario") === "headline";
const backend = createBackend(big ? headline : calm);
install(backend, location.href);

const settleMs = 300;

function fitOnceDrawn(): void {
	const fit = document.querySelector<HTMLButtonElement>(
		'[aria-label="Fit to view"]',
	);
	if (fit && document.querySelector(".node"))
		setTimeout(() => fit.click(), settleMs);
	else requestAnimationFrame(fitOnceDrawn);
}

if (big) requestAnimationFrame(fitOnceDrawn);

const badge = document.createElement("aside");
badge.className = "demo-badge";
badge.innerHTML =
	'<strong>Demo</strong><span>fake data</span><span aria-hidden="true">·</span><span>Stickers: <a href="https://github.com/jdecked/twemoji" target="_blank" rel="noopener">Twemoji</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC-BY 4.0</a></span>';
document.body.append(badge);

Object.assign(globalThis, {
	__demo: { play: backend.play, duration: backend.duration },
});
if (params.has("play")) void backend.play();
