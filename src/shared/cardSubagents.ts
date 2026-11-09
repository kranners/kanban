import type { SubagentState } from "./subagents.ts";

/**
 * A subagent of the cloud session behind a Butler card, such as a change's,
 * as spike reads it from that session's transcript: what it was asked, its
 * state and, for a subagent's own subagent, the id of the one it ran under.
 */
export type CardSubagent = {
	id: string;
	description: string;
	type: string;
	state: SubagentState;
	parent?: string;
	startedAt?: number;
	updatedAt: number;
};

export const maxCardSubagents = 40;
const maxText = 200;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const states: readonly SubagentState[] = ["working", "idle", "done"];

const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

const shortText = (value: unknown): string | null =>
	typeof value === "string" && value.length <= maxText ? value : null;

/** The subagents a card may carry, or null when the list is not one. */
export function parseCardSubagents(value: unknown): CardSubagent[] | null {
	if (!Array.isArray(value) || value.length > maxCardSubagents) return null;
	const parsed: CardSubagent[] = [];
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

/** "3 subagents: 1 working, 2 done", the states with none left out. */
export function cardSubagentSummary(
	subagents: readonly CardSubagent[],
): string {
	const counts = states
		.map(
			(state) =>
				[state, subagents.filter((s) => s.state === state).length] as const,
		)
		.filter(([, count]) => count > 0)
		.map(([state, count]) => `${count} ${state}`);
	const total = subagents.length;
	return `${total} ${total === 1 ? "subagent" : "subagents"}: ${counts.join(", ")}`;
}

/** Working first, then idle, then done, each newest first, a parent before its own subagents. */
export function orderCardSubagents(
	subagents: readonly CardSubagent[],
): { subagent: CardSubagent; depth: number }[] {
	const rank = (s: CardSubagent) => states.indexOf(s.state);
	const byRecency = [...subagents].sort(
		(a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt,
	);
	const ids = new Set(subagents.map((s) => s.id));
	const children = new Map<string, CardSubagent[]>();
	for (const s of byRecency) {
		if (s.parent && ids.has(s.parent) && s.parent !== s.id) {
			children.set(s.parent, [...(children.get(s.parent) ?? []), s]);
		}
	}
	const out: { subagent: CardSubagent; depth: number }[] = [];
	const seen = new Set<string>();
	const visit = (s: CardSubagent, depth: number) => {
		if (seen.has(s.id)) return;
		seen.add(s.id);
		out.push({ subagent: s, depth });
		for (const child of children.get(s.id) ?? []) visit(child, depth + 1);
	};
	for (const s of byRecency) {
		if (!s.parent || !ids.has(s.parent) || s.parent === s.id) visit(s, 0);
	}
	for (const s of byRecency) visit(s, 0);
	return out;
}
