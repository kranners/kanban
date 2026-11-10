import { ownedSubagents } from "../shared/reportedSubagents.ts";
import {
	outstandingStates,
	subagentCountsBySession,
} from "../shared/subagents.ts";
import type {
	Annotations,
	Board,
	ButlerCard,
	Link,
	Subagent,
} from "../shared/types.ts";

export function butlerCards(annotations: Annotations): ButlerCard[] {
	return Object.values(annotations).filter(
		(annotation): annotation is ButlerCard => annotation.kind === "butler-card",
	);
}

/**
 * The board with Butler's cards in it as the board's own: each card's
 * subagents owned by the card as a session owns its own, and a spawned link
 * from each card to the cards and sessions it started, so they are drawn,
 * counted, filtered and hidden the same way. Kept on the page, so the words
 * of a thread's subagents never reach the server's snapshots or history.
 */
export function withButlerCards(board: Board, annotations: Annotations): Board {
	return withLineage(withButlerSubagents(board, annotations), annotations);
}

/** A spawned link from each Butler card to the cards and sessions it started, never one to itself. */
function withLineage(board: Board, annotations: Annotations): Board {
	const card = (id: string | undefined) =>
		id !== undefined && annotations[id]?.kind === "butler-card";
	const started: [string, string][] = [
		...butlerCards(annotations).flatMap((child): [string, string][] =>
			card(child.parent) && child.parent !== child.id
				? [[child.parent as string, child.id]]
				: [],
		),
		...board.sessions.flatMap((session): [string, string][] =>
			card(session.parent?.card)
				? [[session.parent?.card as string, session.id]]
				: [],
		),
	];
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

function withButlerSubagents(board: Board, annotations: Annotations): Board {
	const taken = new Set(board.subagents.map((subagent) => subagent.id));
	const added: Subagent[] = butlerCards(annotations).flatMap((card) => {
		const reported = (card.subagents ?? []).filter((s) => !taken.has(s.id));
		for (const s of reported) taken.add(s.id);
		return ownedSubagents(reported, card.id);
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

/** The Butler card a subagent belongs to, when it is one of a card's. */
export function cardOf(
	subagent: Pick<Subagent, "sessionId">,
	annotations: Annotations,
): ButlerCard | null {
	const owner = annotations[subagent.sessionId];
	return owner?.kind === "butler-card" ? owner : null;
}
