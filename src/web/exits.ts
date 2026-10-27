import { effect, signal } from "@preact/signals";
import type { ExitResult, Session } from "../shared/types.ts";
import { arrangement } from "./arrangement.ts";
import type { ExitState } from "./exitState.ts";
import { exits } from "./exitState.ts";
import { nodeKey } from "./layout.ts";
import { board } from "./state.ts";

export type ExitAsk = { session: Session; force: boolean };

const leaveMs = 260;
const noticeMs = 15_000;
const answerMs = 10 * 60_000;

const answers = new Map<string, (result: ExitResult) => void>();

export const exitAsk = signal<ExitAsk | null>(null);
export const held = signal({ shift: false, option: false });

function hold(shift: boolean, option: boolean): void {
	const now = held.peek();
	if (now.shift !== shift || now.option !== option)
		held.value = { shift, option };
}

addEventListener("keydown", (event) => hold(event.shiftKey, event.altKey));
addEventListener("keyup", (event) => hold(event.shiftKey, event.altKey));
addEventListener("blur", () => hold(false, false));

function setExit(id: string, state: ExitState | null): void {
	const next = new Map(exits.peek());
	if (state) next.set(id, state);
	else next.delete(id);
	exits.value = next;
}

type Accepted = { ok: true } | { ok: false; error: string };

async function postExit(id: string, force: boolean): Promise<Accepted> {
	try {
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(id)}/exit`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ force }),
			},
		);
		if (response.status === 202) return { ok: true };
		return { ok: false, error: await errorOf(response) };
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

export async function errorOf(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error) return body.error;
	} catch {}
	return `The board server answered HTTP ${response.status}`;
}

function answerFor(id: string): {
	answer: Promise<ExitResult>;
	cancel: () => void;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const answer = new Promise<ExitResult>((resolve) => {
		const settle = (result: ExitResult) => {
			clearTimeout(timer);
			answers.delete(id);
			resolve(result);
		};
		answers.set(id, settle);
		timer = setTimeout(
			() =>
				settle({
					ok: false,
					error: "The board server never said how the exit went",
				}),
			answerMs,
		);
	});
	return {
		answer,
		cancel: () => {
			clearTimeout(timer);
			answers.delete(id);
		},
	};
}

export function receiveExit(id: string, result: ExitResult): void {
	answers.get(id)?.(result);
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
	const node = placed();
	setExit(id, { phase: "checking", force, session, node });
	const { answer, cancel } = answerFor(id);
	const accepted = await postExit(id, force);
	if (!accepted.ok) cancel();
	const result = accepted.ok ? await answer : accepted;
	if (!result.ok) {
		refuse(id, "Couldn't exit", result.error);
		return;
	}
	if (!result.exited) {
		refuse(id, "Can't exit yet", result.reason);
		return;
	}
	setExit(id, { phase: "leaving", session, node: placed() ?? node });
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
