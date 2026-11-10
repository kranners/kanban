import { signal } from "@preact/signals";

// Whether the board tidies itself whenever its cards change, like a tiling window manager, kept per browser: off unless turned on.

export const autoLayoutKey = "kanban.autoLayout";

function read(): boolean {
	try {
		return localStorage.getItem(autoLayoutKey) === "on";
	} catch {
		return false;
	}
}

export const autoLayout = signal(read());

export function setAutoLayout(on: boolean): void {
	autoLayout.value = on;
	try {
		localStorage.setItem(autoLayoutKey, on ? "on" : "off");
	} catch {}
}
