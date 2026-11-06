import { signal } from "@preact/signals";
import type {
	Annotations,
	ButlerCard,
	ButlerThreadKind,
	ButlerThreadView,
	CommentThread,
	Session,
} from "../shared/types.ts";
import {
	type Outcome,
	openThreadId,
	receiveComment,
	request,
} from "./comments.ts";

// The page's side of Butler's thread cards: the card whose thread is open,
// what each kind of thread is called, and the calls that read a thread's
// log and send Aaron's replies and new jobs to Butler. A thread's words come
// only from GET /api/butler/threads/<id>, never from the board's own feed.

/** The Discord thread id of the thread card whose view is open. */
export const openThreadCard = signal<string | null>(null);

/** Whether the New Butler job composer is open. */
export const jobComposerOpen = signal(false);

export const threadKindLabels: Record<ButlerThreadKind, string> = {
	conversation: "Conversation",
	dm: "DM",
	board: "Board",
	job: "Job",
	desk: "Desk session",
	scheduled: "Scheduled",
	voice: "Voice",
};

/** How often the open thread view reads its thread again. */
export const threadPollMs = 4000;

const threadPath = (thread: string) =>
	`/api/butler/threads/${encodeURIComponent(thread)}`;

export function fetchThreadView(
	thread: string,
): Promise<Outcome<ButlerThreadView>> {
	return request<ButlerThreadView>("GET", threadPath(thread));
}

export function replyToThread(
	thread: string,
	text: string,
): Promise<Outcome<{ ok: true }>> {
	return request<{ ok: true }>("POST", `${threadPath(thread)}/messages`, {
		text,
	});
}

/** Starts a Butler job and opens its board thread, like a / message. */
export async function startJob(
	text: string,
	viewport?: { x: number; y: number; w: number; h: number },
): Promise<Outcome<CommentThread>> {
	const started = await request<{ thread: CommentThread }>(
		"POST",
		"/api/butler/jobs",
		{ text, ...(viewport ? { viewport } : {}) },
	);
	if (!started.ok) return started;
	receiveComment(started.value.thread);
	openThreadId.value = started.value.thread.id;
	return { ok: true, value: started.value.thread };
}

/** How many cards and sessions came from a thread card. */
export function linkedCount(
	card: ButlerCard,
	annotations: Annotations,
	sessions: readonly Session[],
): number {
	if (!card.thread) return 0;
	const id = card.thread.id;
	return (
		Object.values(annotations).filter(
			(a) => a.kind === "butler-card" && a.parent === card.id,
		).length + sessions.filter((s) => s.parent?.thread === id).length
	);
}

/** The title of the thread card a card or session came from, if it is on the board. */
export function parentTitle(
	parent: string | undefined,
	annotations: Annotations,
	fallback?: string,
): string | null {
	if (!parent) return null;
	const card = annotations[parent];
	if (card?.kind === "butler-card") return card.title;
	return fallback ?? null;
}

/** The title the daemon gives Butler's DM with Aaron. */
export const dmTitle = "Direct messages";

/**
 * Whether a card or session came from Butler's DM, which is his face on the
 * page rather than a card: its parent names the DM's thread, or, while the
 * board has no DM, a parent titled as the DM that is no card on the board.
 */
export function isFromDm(
	parent: { card?: string; thread?: string; title?: string } | undefined,
	dmThread: string | undefined,
	annotations: Annotations,
): boolean {
	if (!parent) return false;
	if (dmThread) {
		if (parent.card === `thread-${dmThread}`) return true;
		if (parent.thread === dmThread) return true;
	}
	return (
		parent.title === dmTitle &&
		(parent.card === undefined || annotations[parent.card] === undefined)
	);
}

/** Opens the thread card a card or session came from, when it has one. */
export function openParent(parent: string | undefined): void {
	const thread = parent?.match(/^thread-([0-9]{5,25})$/)?.[1];
	if (thread) openThreadCard.value = thread;
}

type Box = { x: number; y: number; w: number; h: number };

/** One arrow of Butler's family tree: from the card that started something to what it started. */
export type LineageEdge = { key: string; from: Box; to: Box };

/**
 * The arrows from each of Butler's cards to the cards and sessions it started:
 * a desk session's or a change's card from its thread's, and a session from
 * the thread that asked for it. Only what is on the board is drawn, and a
 * card's own parent never points back at itself.
 */
export function lineageEdges(
	annotations: Annotations,
	sessions: readonly Session[],
	sessionBox: (id: string) => Box | undefined,
): LineageEdge[] {
	const edges: LineageEdge[] = [];
	for (const child of Object.values(annotations)) {
		if (child.kind !== "butler-card" || !child.parent) continue;
		if (child.parent === child.id) continue;
		const parent = annotations[child.parent];
		if (parent?.kind !== "butler-card") continue;
		edges.push({ key: `${parent.id}>${child.id}`, from: parent, to: child });
	}
	for (const session of sessions) {
		const card = session.parent?.card;
		if (!card) continue;
		const parent = annotations[card];
		const box = sessionBox(session.id);
		if (parent?.kind !== "butler-card" || !box) continue;
		edges.push({
			key: `${parent.id}>session-${session.id}`,
			from: parent,
			to: box,
		});
	}
	return edges;
}
