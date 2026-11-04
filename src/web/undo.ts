import { signal } from "@preact/signals";
import type { KeyPress } from "./actions.ts";

export type UndoDirection = "undo" | "redo";

export type UndoReply =
	| { ok: true; label: string; skipped: number }
	| { ok: false; error: string };

export type UndoNotice = { id: number; text: string; failed: boolean };

const noticeMs = 4000;

export const undoNotice = signal<UndoNotice | null>(null);

/** cmd+z and cmd+shift+z on a Mac; ctrl+z, ctrl+shift+z and ctrl+y elsewhere. */
export function undoKey(press: KeyPress, apple: boolean): UndoDirection | null {
	if (press.altKey) return null;
	const command = apple
		? press.metaKey && !press.ctrlKey
		: press.ctrlKey && !press.metaKey;
	if (!command) return null;
	const key = press.key.toLowerCase();
	if (key === "z") return press.shiftKey ? "redo" : "undo";
	if (key === "y" && !apple && !press.shiftKey) return "redo";
	return null;
}

export function noticeText(direction: UndoDirection, reply: UndoReply): string {
	if (!reply.ok) return reply.error;
	const done = `${direction === "undo" ? "Undid" : "Redid"}: ${reply.label}`;
	if (reply.skipped === 0) return done;
	const left = reply.skipped === 1 ? "1 thing" : `${reply.skipped} things`;
	return `${done} (left ${left} that changed since)`;
}

let shown = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function show(text: string, failed: boolean): void {
	const notice = { id: ++shown, text, failed };
	undoNotice.value = notice;
	clearTimeout(timer);
	timer = setTimeout(() => {
		if (undoNotice.peek() === notice) undoNotice.value = null;
	}, noticeMs);
}

let pending: Promise<void> = Promise.resolve();

async function post(direction: UndoDirection): Promise<void> {
	try {
		const path = direction === "undo" ? "/api/undo" : "/api/redo";
		const response = await fetch(path, { method: "POST" });
		const reply = (await response.json().catch(() => null)) as UndoReply | null;
		if (!reply)
			return show(`The board server answered HTTP ${response.status}`, true);
		show(noticeText(direction, reply), !reply.ok);
	} catch (caught) {
		show(`Couldn't reach the board server (${caught})`, true);
	}
}

/** Steps the board's history; presses queue so a quick run of cmd+z goes back that many steps. */
export function step(direction: UndoDirection): Promise<void> {
	pending = pending.then(() => post(direction));
	return pending;
}
