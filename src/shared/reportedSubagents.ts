import type { SubagentState } from "./subagents.ts";
import type { Subagent } from "./types.ts";

/**
 * A subagent as something outside the board reports it: a runner from its
 * session's transcript, or spike from the cloud session or Discord thread
 * behind a Butler card. The board turns each into a Subagent of the card or
 * session it belongs to.
 */
export type ReportedSubagent = {
	id: string;
	description: string;
	type: string;
	state: SubagentState;
	parent?: string;
	startedAt?: number;
	updatedAt: number;
};

export const maxReportedSubagents = 40;
const maxText = 200;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const states: readonly SubagentState[] = ["working", "idle", "done"];

const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

const shortText = (value: unknown): string | null =>
	typeof value === "string" && value.length <= maxText ? value : null;

/** The reported subagents, or null when the list is not one. */
export function parseReportedSubagents(
	value: unknown,
): ReportedSubagent[] | null {
	if (!Array.isArray(value) || value.length > maxReportedSubagents) return null;
	const parsed: ReportedSubagent[] = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) return null;
		const { id, description, type, state, parent, startedAt, updatedAt } =
			raw as Record<string, unknown>;
		const text = shortText(description);
		const kind = shortText(type);
		if (
			typeof id !== "string" ||
			!idPattern.test(id) ||
			text === null ||
			kind === null ||
			!states.includes(state as SubagentState) ||
			(parent !== undefined &&
				(typeof parent !== "string" || !idPattern.test(parent))) ||
			(startedAt !== undefined && !isTime(startedAt)) ||
			!isTime(updatedAt)
		)
			return null;
		parsed.push({
			id,
			description: text,
			type: kind,
			state: state as SubagentState,
			...(parent === undefined ? {} : { parent: parent as string }),
			...(startedAt === undefined ? {} : { startedAt: startedAt as number }),
			updatedAt,
		});
	}
	return parsed;
}

/** A reported subagent as the board's own, under the session or card it belongs to. */
export function reportedSubagent(
	reported: ReportedSubagent,
	sessionId: string,
	reachable = true,
): Subagent {
	return {
		id: reported.id,
		kind: "agent",
		sessionId,
		parentAgentId: reported.parent ?? null,
		type: reported.type,
		description: reported.description,
		live: reachable && reported.state === "working",
		done: reported.state === "done",
		startedAt: reported.startedAt ?? reported.updatedAt,
		updatedAt: reported.updatedAt,
	};
}

/** An owner's reported subagents as the board's own, one under a parent it no longer reports standing under the owner. */
export function ownedSubagents(
	reported: readonly ReportedSubagent[],
	ownerId: string,
): Subagent[] {
	const ids = new Set(reported.map((s) => s.id));
	return reported.map((s) =>
		reportedSubagent(
			s.parent && ids.has(s.parent) ? s : { ...s, parent: undefined },
			ownerId,
		),
	);
}
