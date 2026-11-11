import { ownedSubagents } from "../shared/reportedSubagents.ts";
import {
	outstandingStates,
	subagentCountsBySession,
} from "../shared/subagents.ts";
import type {
	Annotations,
	Board,
	ButlerCard,
	ButlerOrigin,
	Link,
	Region,
	Session,
	Step,
	Subagent,
} from "../shared/types.ts";
import { centreOf, inside } from "./placement.ts";

/** Whether a session of the page's board is one of Butler's cards rather than a Claude session. */
export const isCard = (session: Session): boolean =>
	session.butler?.card.id === session.id;

/** The board's Claude sessions, leaving out Butler's cards, which only look like them. */
export const claudeSessions = (sessions: readonly Session[]): Session[] =>
	sessions.filter((session) => !isCard(session));

export function butlerCards(annotations: Annotations): ButlerCard[] {
	return Object.values(annotations).filter(
		(annotation): annotation is ButlerCard => annotation.kind === "butler-card",
	);
}

export function originOf(card: ButlerCard): ButlerOrigin {
	if (card.selfFix) return "change";
	if (card.desk) return "desk";
	switch (card.thread?.kind) {
		case undefined:
			return "butler";
		case "dm":
		case "desk":
		case "job":
		case "voice":
			return card.thread.kind;
		default:
			return "thread";
	}
}

const stateLabels: Record<ButlerCard["state"], string> = {
	working: "Working",
	"needs-you": "Needs you",
	idle: "Idle",
	done: "Done",
	failed: "Failed",
	watching: "Watching",
	stopped: "Stopped",
};

/** Each change of the card's state and status, as a session's steps. */
function stepsOf(card: ButlerCard): Step[] {
	const history = card.history?.length
		? card.history
		: [{ at: card.updatedAt, state: card.state, status: card.status }];
	return history.map((event) => ({
		at: event.at,
		text: event.status
			? `${stateLabels[event.state]}: ${event.status}`
			: stateLabels[event.state],
	}));
}

const areaOf = (region: Region) => region.w * region.h;

/** The smallest region the card's centre falls in, whose project it then belongs to as a session would. */
function homeOf(card: ButlerCard, regions: readonly Region[]): Region | null {
	return regions
		.filter((region) => inside(region, centreOf(card)))
		.reduce<Region | null>(
			(best, region) =>
				best === null || areaOf(region) < areaOf(best) ? region : best,
			null,
		);
}

/**
 * One of Butler's cards as a session of the board, so the board draws,
 * places, frames, filters and opens it as it does any session. Its spot
 * stays the card's own, which Tidy keeps.
 */
export function cardSession(
	card: ButlerCard,
	regions: readonly Region[] = [],
): Session {
	const home = homeOf(card, regions);
	const status = card.status ?? null;
	const steps = stepsOf(card);
	const parent = card.parent?.match(/^thread-([0-9]{5,25})$/)?.[1];
	return {
		id: card.id,
		short: null,
		pid: null,
		name: card.title,
		cwd: home?.cwd ?? "",
		project: home?.cwd ?? card.title,
		kind: "background",
		activity: card.state,
		doing: card.state === "needs-you" ? null : status,
		needs: card.state === "needs-you" ? (status ?? "Needs you") : null,
		goal: card.title,
		startedAt: card.startedAt ?? steps[0]?.at ?? card.updatedAt,
		updatedAt: card.updatedAt,
		attachable: false,
		cmux: false,
		artifacts: [],
		tasks: [],
		steps,
		...(parent && card.parent
			? { parent: { thread: parent, card: card.parent } }
			: {}),
		butler: { origin: originOf(card), card },
	};
}

/** The session a change's card stands for, when that cloud session is already on the board. */
function sessionOfChange(
	card: ButlerCard,
	sessions: readonly Session[],
): Session | undefined {
	if (!card.selfFix || !card.link) return undefined;
	return sessions.find((session) => session.cloud?.url === card.link);
}

/** Butler's cards that are drawn as their own session, rather than on a session already on the board. */
export function ownCards(board: Board | null): ButlerCard[] {
	return (board?.sessions ?? []).flatMap((session) =>
		session.butler && isCard(session) ? [session.butler.card] : [],
	);
}

/**
 * The board with Butler's cards in it as sessions: each card a session,
 * its subagents owned by it, and a spawned link from each card to the cards
 * and sessions it started. A change whose cloud session is already on the
 * board stays that one session, with the card's facts on it. Kept on the
 * page, so the server's board, its tools and snapshots never see them.
 */
export function withButlerCards(
	board: Board,
	annotations: Annotations,
	regions: readonly Region[] = [],
): Board {
	const cards = butlerCards(annotations);
	if (cards.length === 0) return board;
	const merged = new Map<string, ButlerCard>();
	const added: Session[] = [];
	for (const card of cards) {
		const session = sessionOfChange(card, board.sessions);
		if (session) merged.set(session.id, card);
		else added.push(cardSession(card, regions));
	}
	const sessions = [
		...board.sessions.map((session) => {
			const card = merged.get(session.id);
			return card
				? { ...session, butler: { origin: originOf(card), card } }
				: session;
		}),
		...added,
	];
	return withLineage(withCardSubagents({ ...board, sessions }, added));
}

/** A spawned link from each of Butler's cards to every card and session it started, never one to itself. */
function withLineage(board: Board): Board {
	const cards = new Set(ownCards(board).map((card) => card.id));
	const started = board.sessions.flatMap((session): [string, string][] => {
		const parent = session.parent?.card;
		return parent !== undefined && parent !== session.id && cards.has(parent)
			? [[parent, session.id]]
			: [];
	});
	if (started.length === 0) return board;
	return {
		...board,
		links: [
			...board.links,
			...started.map(
				([from, to]): Link => ({
					from: { kind: "session", id: from },
					to: { kind: "session", id: to },
					kind: "spawned",
				}),
			),
		],
	};
}

function withCardSubagents(board: Board, cards: readonly Session[]): Board {
	const taken = new Set(board.subagents.map((subagent) => subagent.id));
	const added: Subagent[] = cards.flatMap((session) => {
		const reported = (session.butler?.card.subagents ?? []).filter(
			(s) => !taken.has(s.id),
		);
		for (const s of reported) taken.add(s.id);
		return ownedSubagents(reported, session.id);
	});
	if (added.length === 0) return board;
	const links: Link[] = added.map((subagent) => ({
		from: subagent.parentAgentId
			? { kind: "subagent", id: subagent.parentAgentId }
			: { kind: "session", id: subagent.sessionId },
		to: { kind: "subagent", id: subagent.id },
		kind: "subagent",
	}));
	return {
		...board,
		subagents: [...board.subagents, ...added],
		subagentCounts: {
			...board.subagentCounts,
			...subagentCountsBySession(added),
		},
		subagentStates: { ...board.subagentStates, ...outstandingStates(added) },
		links: [...board.links, ...links],
	};
}
