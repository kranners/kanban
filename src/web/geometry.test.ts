import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, Link, Session, Subagent } from "../shared/types.ts";
import {
	drawnLinks,
	facingSide,
	facingSides,
	previewPath,
	relationPath,
	sidePoint,
	tetherLine,
} from "./geometry.ts";
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
		goal: null,
		startedAt: 0,
		updatedAt: 0,
		attachable: true,
		cmux: false,
		artifacts: [],
		tasks: [],
		steps: [],
	};
}

function subagent(id: string, at: number, parentAgentId: string | null) {
	return {
		id,
		sessionId: "root",
		kind: "agent",
		parentAgentId,
		type: "explore",
		description: id,
		live: true,
		done: false,
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
		subagentCounts: {},
		subagentStates: {},
		workflowRuns: {},
		workflows: [],
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

test("a tether runs between the facing edges of a note and its card frame", () => {
	const board: Board = {
		sessions: [session("root")],
		subagents: [],
		subagentCounts: {},
		subagentStates: {},
		workflowRuns: {},
		workflows: [],
		links: [],
		messages: [],
		generatedAt: 0,
	};
	const card = arrange(board, {}, seedsOf(board), new Map()).nodes.get(
		"session:root",
	);
	assert.ok(card);
	const frameTop = card.y;
	const note = {
		x: card.x + card.w + 48,
		y: frameTop,
		w: 192,
		h: card.y + card.h - frameTop,
	};
	assert.deepEqual(tetherLine(note, card), {
		from: { x: note.x, y: note.y + note.h / 2 },
		to: { x: card.x + card.w, y: note.y + note.h / 2 },
	});
	assert.equal(tetherLine({ ...note, x: card.x }, card), null);
});

const card = { x: 100, y: 200, w: 300, h: 100 };

test("sidePoint finds the middle of each side", () => {
	assert.deepEqual(sidePoint(card, "top"), { x: 250, y: 200 });
	assert.deepEqual(sidePoint(card, "right"), { x: 400, y: 250 });
	assert.deepEqual(sidePoint(card, "bottom"), { x: 250, y: 300 });
	assert.deepEqual(sidePoint(card, "left"), { x: 100, y: 250 });
});

test("facingSides joins side by side cards across and stacked cards up and down", () => {
	const right = { ...card, x: 700, y: 260 };
	assert.deepEqual(facingSides(card, right), ["right", "left"]);
	assert.deepEqual(facingSides(right, card), ["left", "right"]);
	const below = { ...card, x: 160, y: 600 };
	assert.deepEqual(facingSides(card, below), ["bottom", "top"]);
	assert.deepEqual(facingSides(below, card), ["top", "bottom"]);
	assert.equal(facingSide(card, { x: 250, y: -400 }), "top");
});

test("relationPath runs between facing sides with its middle on the curve", () => {
	const right = { ...card, x: 700 };
	const drawn = relationPath(card, right);
	assert.deepEqual(drawn.from, { x: 400, y: 250 });
	assert.deepEqual(drawn.to, { x: 700, y: 250 });
	assert.deepEqual(drawn.mid, { x: 550, y: 250 });
	assert.equal(drawn.path, "M400 250 C500 250 600 250 700 250");
	const near = relationPath(card, { ...card, x: 430, y: 220 });
	assert.equal(near.path, "M400 250 C440 250 390 270 430 270");
	const far = relationPath(card, { ...card, x: 2000, y: 500 });
	assert.match(far.path, /^M400 250 C560 250 /);
});

test("previewPath leaves the handle along its side", () => {
	assert.equal(
		previewPath({ x: 250, y: 300 }, "bottom", { x: 250, y: 600 }),
		"M250 300 C250 400 250 600 250 600",
	);
});
