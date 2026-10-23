import { computed, effect, signal } from "@preact/signals";
import type { ExitResult, Session } from "../shared/types.ts";
import { arrangement } from "./arrangement.ts";
import type { PlacedNode } from "./layout.ts";
import { nodeKey } from "./layout.ts";
import { board } from "./state.ts";

export type ExitState =
	| { phase: "checking"; force: boolean }
	| { phase: "refused"; title: string; message: string }
	| { phase: "leaving"; session: Session; node: PlacedNode | undefined }
	| { phase: "gone" };

export type ExitAsk = { session: Session; force: boolean };

const leaveMs = 260;
const noticeMs = 15_000;

export const exits = signal<ReadonlyMap<string, ExitState>>(new Map());
export const exitAsk = signal<ExitAsk | null>(null);
export const shiftHeld = signal(false);

export const departed = computed(
	() =>
		new Set(
			[...exits.value]
				.filter(([, state]) => state.phase === "gone")
				.map(([id]) => id),
		),
);

addEventListener("keydown", (event) => {
	if (event.key === "Shift") shiftHeld.value = true;
});
addEventListener("keyup", (event) => {
	if (event.key === "Shift") shiftHeld.value = false;
});
addEventListener("blur", () => {
	shiftHeld.value = false;
});

function setExit(id: string, state: ExitState | null): void {
	const next = new Map(exits.peek());
	if (state) next.set(id, state);
	else next.delete(id);
	exits.value = next;
}

async function postExit(id: string, force: boolean): Promise<ExitResult> {
	try {
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(id)}/exit`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ force }),
			},
		);
		const text = await response.text();
		try {
			return JSON.parse(text) as ExitResult;
		} catch {
			return { ok: false, error: text || `HTTP ${response.status}` };
		}
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

function refuse(id: string, title: string, message: string): void {
	const state: ExitState = { phase: "refused", title, message };
	setExit(id, state);
	setTimeout(() => {
		if (exits.peek().get(id) === state) setExit(id, null);
	}, noticeMs);
}

export function busy(id: string): boolean {
	const phase = exits.peek().get(id)?.phase;
	return phase === "checking" || phase === "leaving" || phase === "gone";
}

export function askToExit(session: Session, force: boolean): void {
	if (busy(session.id)) return;
	exitAsk.value = { session, force };
}

export async function exitSession(
	session: Session,
	force: boolean,
): Promise<void> {
	const { id } = session;
	if (busy(id)) return;
	const placed = () =>
		arrangement.peek()?.nodes.get(nodeKey({ kind: "session", id }));
	const before = placed();
	setExit(id, { phase: "checking", force });
	const result = await postExit(id, force);
	if (!result.ok) {
		refuse(id, "Couldn't exit", result.error);
		return;
	}
	if (!result.exited) {
		refuse(id, "Can't exit yet", result.reason);
		return;
	}
	setExit(id, {
		phase: "leaving",
		session,
		node: placed() ?? before,
	});
	setTimeout(() => {
		const listed = board.peek()?.sessions.some((s) => s.id === id);
		setExit(id, listed ? { phase: "gone" } : null);
	}, leaveMs);
}

export function dismissExit(id: string): void {
	if (exits.peek().get(id)?.phase === "refused") setExit(id, null);
}

effect(() => {
	const listed = new Set((board.value?.sessions ?? []).map((s) => s.id));
	for (const [id, state] of exits.peek()) {
		if (state.phase === "gone" && !listed.has(id)) setExit(id, null);
	}
});
