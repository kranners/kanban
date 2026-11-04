import { signal } from "@preact/signals";
import type { KeyPress } from "./actions.ts";

export type UndoDirection = "undo" | "redo";

export type UndoReply =
	| { ok: true; label: string; skipped: number }
	| { ok: false; error: string };

export type Removal = "archive" | "delete";

export type UndoNotice = {
	id: number;
	text: string;
	failed: boolean;
	/** Set for a removal the board can take back, so the toast offers undo. */
	undoable?: Removal;
};

const noticeMs = 4000;
/** A removal's toast stays longer, so there is time to reach its undo button. */
const removalMs = 8000;

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

/** What a removal's toast says, such as "Archived “Fix login”" or "Deleted 2 notes". */
export function removalText(
	verb: string,
	noun: [string, string],
	names: readonly (string | null)[],
): string {
	const [name] = names;
	if (names.length === 1 && name) return `${verb} “${name}”`;
	const [one, many] = noun;
	if (names.length === 1)
		return `${verb} ${/^[aeiou]/.test(one) ? "an" : "a"} ${one}`;
	return `${verb} ${names.length} ${many}`;
}

let shown = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function show(text: string, failed: boolean, undoable?: Removal): void {
	const notice = { id: ++shown, text, failed, undoable };
	undoNotice.value = notice;
	clearTimeout(timer);
	timer = setTimeout(
		() => {
			if (undoNotice.peek() === notice) undoNotice.value = null;
		},
		undoable ? removalMs : noticeMs,
	);
}

/** Says a card was removed or archived, offering to take it back. */
export function announceRemoval(text: string, removal: Removal): void {
	show(text, false, removal);
}

/** The toast's undo button: takes back the last step, as cmd+z would. */
export function undoRemoval(): Promise<void> {
	undoNotice.value = null;
	return step("undo");
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
