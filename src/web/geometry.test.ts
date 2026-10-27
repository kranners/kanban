import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, Link, Session, Subagent } from "../shared/types.ts";
import { drawnLinks } from "./geometry.ts";
import { arrange, seedsOf } from "./placement.ts";

function session(id: string): Session {
	return {
		id,
		short: id,
		pid: null,
		name: id,
		cwd: `/Users/me/dev/${id}`,
		project: id,
		kind: "background",
		activity: "idle",
		doing: null,
		needs: null,
		startedAt: 0,
		updatedAt: 0,
		attachable: true,
		cmux: false,
	};
}

function subagent(id: string, at: number, parentAgentId: string | null) {
	return {
		id,
		sessionId: "root",
		parentAgentId,
		type: "explore",
		description: id,
		live: true,
		startedAt: at,
		updatedAt: at,
	} satisfies Subagent;
}

test("only the first row of a grid gets an edge, for nested subagents too", () => {
	const nested = Array.from({ length: 7 }, (_, i) =>
		subagent(`in${i}`, 10 + i, "outer"),
	);
	const leaves = Array.from({ length: 4 }, (_, i) =>
		subagent(`leaf${i}`, 20 + i, null),
	);
	const subagents = [subagent("outer", 1, null), ...nested, ...leaves];
	const links: Link[] = subagents.map((a) => ({
		from: a.parentAgentId
			? { kind: "subagent", id: a.parentAgentId }
			: { kind: "session", id: "root" },
		to: { kind: "subagent", id: a.id },
		kind: "subagent",
	}));
	const board: Board = {
		sessions: [session("root")],
		subagents,
		links,
		messages: [],
		generatedAt: 0,
	};
	const { nodes } = arrange(board, {}, seedsOf(board), new Map());
	const drawn = drawnLinks(links, nodes).map(({ to }) => to.key);
	assert.deepEqual(drawn.sort(), [
		"subagent:in0",
		"subagent:in1",
		"subagent:in2",
		"subagent:leaf0",
		"subagent:leaf1",
		"subagent:leaf2",
		"subagent:outer",
	]);
});
