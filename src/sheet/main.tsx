import "./fonts.css";
import { render } from "preact";
import { parseSheetInput } from "./input.ts";
import { Sheet } from "./Sheet.tsx";

// The card sheet: one page that draws the board's own cards, strips,
// project dashboards and status reports from the JSON in #sheet-data, so a
// renderer can picture them with nothing else loaded.

const root = document.documentElement;
const mount = document.getElementById("sheet");

function failed(message: string): void {
	if (mount) {
		mount.replaceChildren();
		const shown = document.createElement("p");
		shown.className = "sheet-error";
		shown.textContent = `Sheet error: ${message}`;
		mount.append(shown);
	}
	root.dataset.sheet = "error";
}

function draw(): void {
	const parsed = parseSheetInput(
		document.getElementById("sheet-data")?.textContent ?? "",
	);
	if (!parsed.ok) {
		failed(parsed.error);
		return;
	}
	const { input } = parsed;
	if (input.theme) root.dataset.theme = input.theme;
	root.style.setProperty("--sheet-width", `${input.width}px`);
	if (!mount) {
		failed("the page has no #sheet");
		return;
	}
	render(<Sheet input={input} />, mount);
	void document.fonts.ready.then(() => {
		root.dataset.sheet = "ready";
	});
}

try {
	draw();
} catch (error) {
	failed(error instanceof Error ? error.message : String(error));
}
