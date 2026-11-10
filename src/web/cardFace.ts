import { signal } from "@preact/signals";
import type {
	Activity,
	ButlerCard,
	Session,
	Subagent,
} from "../shared/types.ts";

// Every card on the board, Aaron's own sessions and Butler's threads, desk
// sessions and changes alike, is drawn by one card face. This is its model:
// who started the card and the status its colours follow.

export const cardAuthorKinds = ["kanban", "butler", "desk", "change"] as const;
export type CardAuthorKind = (typeof cardAuthorKinds)[number];

/** Who started a card, and the card it came from when it has one. */
export type CardAuthor = { kind: CardAuthorKind; label: string; from?: string };

export const authorKindLabels: Record<CardAuthorKind, string> = {
	kanban: "Kanban",
	butler: "Butler",
	desk: "Desk",
	change: "Change",
};

const fromTitle = (title: string | undefined) => (title ? { from: title } : {});

export function sessionAuthor(session: Pick<Session, "parent">): CardAuthor {
	const { parent } = session;
	if (!parent) return { kind: "kanban", label: authorKindLabels.kanban };
	if (parent.desk) {
		return {
			kind: "desk",
			label: `Desk ${parent.desk}`,
			...fromTitle(parent.title),
		};
	}
	return {
		kind: "butler",
		label: authorKindLabels.butler,
		...fromTitle(parent.title),
	};
}

export function butlerCardAuthor(
	card: Pick<ButlerCard, "selfFix" | "desk" | "thread">,
): CardAuthor {
	if (card.selfFix) return { kind: "change", label: authorKindLabels.change };
	if (card.desk) return { kind: "desk", label: `Desk ${card.desk}` };
	if (card.thread?.kind === "desk") {
		return { kind: "desk", label: authorKindLabels.desk };
	}
	return { kind: "butler", label: authorKindLabels.butler };
}

/** A card's status: its activity, or stalled once it claims to work with nothing new for `stallMs`. */
export type CardStatus = Activity | "stalled";

/** How long a working card may go without a tool call, message or subagent step before it counts as stalled. */
export const stallMs = 10 * 60_000;

export function statusOf(
	activity: Activity,
	lastActivity: number,
	now: number,
): CardStatus {
	return activity === "working" && now - lastActivity > stallMs
		? "stalled"
		: activity;
}

const newest = (times: readonly number[]) => Math.max(0, ...times);

/** When a session last did something; now while a tool call or subagent of its own is still running. */
export function sessionLastActivity(
	session: Pick<Session, "id" | "updatedAt" | "toolRunning">,
	subagents: readonly Pick<Subagent, "sessionId" | "updatedAt" | "live">[],
	now: number,
): number {
	const own = subagents.filter((subagent) => subagent.sessionId === session.id);
	if (session.toolRunning || own.some((subagent) => subagent.live)) return now;
	return newest([
		session.updatedAt,
		...own.map((subagent) => subagent.updatedAt),
	]);
}

export function butlerCardLastActivity(
	card: Pick<
		ButlerCard,
		"updatedAt" | "lastActiveAt" | "history" | "subagents"
	>,
): number {
	if (card.lastActiveAt !== undefined) {
		return newest([
			card.lastActiveAt,
			...(card.subagents ?? []).map((subagent) => subagent.updatedAt),
		]);
	}
	return newest([
		card.updatedAt,
		...(card.history ?? []).map((event) => event.at),
		...(card.subagents ?? []).map((subagent) => subagent.updatedAt),
	]);
}

export const statusLabels: Record<CardStatus, string> = {
	working: "Working",
	"needs-you": "Needs you",
	watching: "Watching",
	idle: "Idle",
	done: "Finished",
	failed: "Failed",
	stopped: "Stopped",
	stalled: "Stalled",
};

export function stalledText(lastActivity: number, now: number): string {
	return `Stalled ${Math.floor((now - lastActivity) / 60_000)} min`;
}

/** Which authors' cards the board shows at full strength, kept per browser; the rest are dimmed. */
export type AuthorFilter = CardAuthorKind | "all";

export const authorFilterKey = "kanban.authorFilter";

function readFilter(): AuthorFilter {
	try {
		const kept = localStorage.getItem(authorFilterKey);
		return (cardAuthorKinds as readonly string[]).includes(kept ?? "")
			? (kept as CardAuthorKind)
			: "all";
	} catch {
		return "all";
	}
}

export const authorFilter = signal<AuthorFilter>(readFilter());

export function setAuthorFilter(filter: AuthorFilter): void {
	authorFilter.value = filter;
	try {
		localStorage.setItem(authorFilterKey, filter);
	} catch {}
}

export const dimmedByAuthor = (author: CardAuthor, filter: AuthorFilter) =>
	filter !== "all" && author.kind !== filter;

/** What any card on the board shows, whoever started it. */
export type CardView = {
	/** Whose subagents it shows: the session's id, or the Butler card's. */
	owner: string;
	author: CardAuthor;
	activity: Activity;
	status: CardStatus;
	lastActivity: number;
	goal: string | null;
	needs: string | null;
	doing: string | null;
	parent?: { card?: string; thread?: string; title?: string };
	updatedAt: number;
};

export function sessionView(
	session: Session,
	subagents: readonly Pick<Subagent, "sessionId" | "updatedAt" | "live">[],
	now: number,
	doing: string | null,
): CardView {
	const lastActivity = sessionLastActivity(session, subagents, now);
	return {
		owner: session.id,
		author: sessionAuthor(session),
		activity: session.activity,
		status: statusOf(session.activity, lastActivity, now),
		lastActivity,
		goal: session.goal,
		needs: session.needs,
		doing,
		...(session.parent ? { parent: session.parent } : {}),
		updatedAt: session.updatedAt,
	};
}

export function butlerCardView(card: ButlerCard, now: number): CardView {
	const lastActivity = butlerCardLastActivity(card);
	const status = card.status ?? null;
	return {
		owner: card.id,
		author: butlerCardAuthor(card),
		activity: card.state,
		status: statusOf(card.state, lastActivity, now),
		lastActivity,
		goal: card.title,
		needs: card.state === "needs-you" ? (status ?? "Needs you") : null,
		doing: card.state === "needs-you" ? null : status,
		...(card.parent ? { parent: { card: card.parent } } : {}),
		updatedAt: card.updatedAt,
	};
}
