import type { Annotation, Board, NodeRef } from "../shared/types.ts";
import type { Group } from "./groups.ts";
import type { NodeKey, PlacedNode } from "./layout.ts";
import { nodeKey } from "./layout.ts";

export type Carried = { nodes: NodeKey[]; notes: Annotation[] };

function linkedFrom(board: Board): Map<NodeKey, NodeKey[]> {
	const linked = new Map<NodeKey, NodeKey[]>();
	const link = (from: NodeRef, to: NodeRef) => {
		const key = nodeKey(from);
		linked.set(key, [...(linked.get(key) ?? []), nodeKey(to)]);
	};
	for (const { from, to } of board.links) link(from, to);
	for (const agent of board.subagents)
		link(
			agent.parentAgentId
				? { kind: "subagent", id: agent.parentAgentId }
				: { kind: "session", id: agent.sessionId },
			{ kind: "subagent", id: agent.id },
		);
	return linked;
}

export function carriedWith(
	roots: readonly NodeKey[],
	board: Board,
	nodes: ReadonlyMap<NodeKey, PlacedNode>,
	annotations: Iterable<Annotation>,
	projects: readonly Group[],
): Carried {
	const projectOf = new Map<NodeKey, string>();
	for (const project of projects)
		for (const key of project.members) projectOf.set(key, project.key);
	const home = new Set(roots.map((key) => projectOf.get(key)));
	const foreign = (key: NodeKey) => {
		const project = projectOf.get(key);
		return project !== undefined && !home.has(project);
	};

	const linked = linkedFrom(board);
	const held = new Set(roots);
	const queue = [...roots];
	for (const key of queue) {
		for (const next of linked.get(key) ?? []) {
			if (held.has(next) || !nodes.has(next) || foreign(next)) continue;
			held.add(next);
			queue.push(next);
		}
	}

	const followsHeld = (key: NodeKey) => {
		const leader = nodes.get(key)?.follows;
		return leader !== undefined && held.has(leader);
	};
	return {
		nodes: [...held].filter((key) => !roots.includes(key) && !followsHeld(key)),
		notes: [...annotations].filter(
			(a) =>
				a.kind === "note" &&
				a.session !== undefined &&
				held.has(nodeKey({ kind: "session", id: a.session })),
		),
	};
}
