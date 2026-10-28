import {
	type Activity,
	activityOrder,
	type Board,
	type NodeRef,
	type Session,
} from "../shared/types.ts";
import type { Group } from "./groups.ts";
import type { NodeKey, PlacedNode } from "./layout.ts";
import { nodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";

export type Summary = {
	key: string;
	project: string;
	cwd: string;
	frame: Rect;
	framed: boolean;
	sessions: Session[];
};

export function byAttention(sessions: readonly Session[]): Session[] {
	return [...sessions].sort(
		(a, b) =>
			activityOrder.indexOf(a.activity) - activityOrder.indexOf(b.activity) ||
			b.updatedAt - a.updatedAt,
	);
}

export function activityCounts(
	sessions: readonly Session[],
): [Activity, number][] {
	return activityOrder.flatMap((activity): [Activity, number][] => {
		const count = sessions.filter((s) => s.activity === activity).length;
		return count > 0 ? [[activity, count]] : [];
	});
}

export function summariesOf(
	groups: readonly Group[],
	sessions: readonly Session[],
	nodes: ReadonlyMap<NodeKey, PlacedNode>,
): Summary[] {
	const byKey = new Map(
		sessions.map((s) => [nodeKey({ kind: "session", id: s.id }), s]),
	);
	const grouped = new Set(groups.flatMap((group) => group.members));
	const framed = groups.flatMap((group): Summary[] => {
		const members = group.members.flatMap((key) => byKey.get(key) ?? []);
		if (members.length === 0) return [];
		return [
			{
				key: group.key,
				project: group.project,
				cwd: group.cwd,
				frame: group.frame,
				framed: true,
				sessions: byAttention(members),
			},
		];
	});
	const alone = sessions.flatMap((session): Summary[] => {
		const key = nodeKey({ kind: "session", id: session.id });
		const node = nodes.get(key);
		if (!node || grouped.has(key)) return [];
		return [
			{
				key,
				project: session.project,
				cwd: session.cwd,
				frame: { x: node.x, y: node.y, w: node.w, h: node.h },
				framed: false,
				sessions: [session],
			},
		];
	});
	return [...framed, ...alone];
}

const isSession = (ref: NodeRef) => ref.kind === "session";

export function sessionsOnly(board: Board): Board {
	return {
		...board,
		subagents: [],
		links: board.links.filter((l) => isSession(l.from) && isSession(l.to)),
		messages: board.messages.filter(
			(m) => isSession(m.from) && isSession(m.to),
		),
	};
}
