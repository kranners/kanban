import { effect } from "@preact/signals";
import type { FocusReport } from "../shared/types.ts";
import { view } from "./Canvas.tsx";
import { visibleBoard } from "./Comments.tsx";
import { reportFocus } from "./comments.ts";
import { focusedSessionId, focusedSubagent } from "./state.ts";

// Butler sees what Aaron is working on: this page tells the board which
// session Aaron has open and what part of the board is on screen, when
// either changes, every minute while the page is in front of him, and
// that he has gone when it is hidden or closed.

/** Settles a pan or zoom before telling the board. */
export const focusSettleMs = 1000;
/** Keeps the report fresh while Aaron stays put; the board forgets it after three minutes. */
export const focusHeartbeatMs = 60_000;

// Not crypto.randomUUID: the board is also reached over plain http on WireGuard.
const client = `page-${Math.random().toString(36).slice(2, 12)}`;

/** What this page has in front of Aaron right now. */
function focusNow(
	session: string | null,
	viewport: FocusReport["viewport"],
): FocusReport {
	return {
		client,
		...(session ? { session } : {}),
		...(viewport ? { viewport } : {}),
	};
}

export function startFocusReports(): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let last = "";
	const visible = () => document.visibilityState === "visible";
	const send = (always: boolean) => {
		if (!visible()) return;
		const report = focusNow(
			focusedSessionId.peek() ?? focusedSubagent.peek()?.sessionId ?? null,
			visibleBoard(),
		);
		const key = JSON.stringify(report);
		if (!always && key === last) return;
		last = key;
		void reportFocus(report);
	};
	const away = () => {
		last = "";
		void reportFocus({ client, away: true });
	};
	effect(() => {
		// Read to re-run whenever Aaron opens a session or moves the board.
		void focusedSessionId.value;
		void focusedSubagent.value;
		void view.value;
		clearTimeout(timer);
		timer = setTimeout(() => send(false), focusSettleMs);
	});
	setInterval(() => send(true), focusHeartbeatMs);
	document.addEventListener("visibilitychange", () => {
		if (visible()) send(true);
		else away();
	});
	addEventListener("pagehide", away);
}
