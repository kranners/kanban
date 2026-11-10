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
 * The board with each Butler card's subagents as the board's own subagents,
 * owned by the card as a session owns its own, so they are drawn, counted,
 * filtered and hidden the same way. Kept on the page, so the words of a
 * thread's subagents never reach the server's snapshots or history.
 */
export function withButlerSubagents(
	board: Board,
	annotations: Annotations,
): Board {
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
