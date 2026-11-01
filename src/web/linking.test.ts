import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Relation, RelationEnd, Session } from "../shared/types.ts";
import type { PlacedNode } from "./layout.ts";
import { type Linkable, linkableAt, linkables } from "./linking.ts";

const session = (id: string): RelationEnd => ({ kind: "session", id });

const candidate = (
	end: RelationEnd,
	x: number,
	y: number,
	refused = false,
): Linkable => ({ end, rect: { x, y, w: 100, h: 100 }, refused });

const board: Linkable[] = [
	candidate(session("c"), 0, 0),
	candidate(session("d"), 300, 0),
	candidate(session("a"), 50, 50),
	candidate(session("b"), 600, 0),
	candidate(session("cloudy"), 900, 0, true),
];

const link = (from: RelationEnd, to: RelationEnd): Relation => ({
	id: "r1",
	from,
	to,
	createdAt: 0,
});

describe("linkableAt", () => {
	it("picks the topmost card under the point", () => {
		assert.deepEqual(linkableAt({ x: 75, y: 75 }, board, session("b"), []), {
			kind: "session",
			id: "a",
		});
		assert.deepEqual(linkableAt({ x: 20, y: 20 }, board, session("b"), []), {
			kind: "session",
			id: "c",
		});
		assert.equal(linkableAt({ x: 250, y: 250 }, board, session("b"), []), null);
	});

	it("leaves out the source, existing links and cloud sessions", () => {
		assert.equal(linkableAt({ x: 650, y: 50 }, board, session("b"), []), null);
		assert.deepEqual(linkableAt({ x: 650, y: 50 }, board, session("c"), []), {
			kind: "session",
			id: "b",
		});
		const linked = [link(session("b"), session("d"))];
		assert.equal(
			linkableAt({ x: 350, y: 50 }, board, session("b"), linked),
			null,
		);
		assert.equal(
			linkableAt({ x: 650, y: 50 }, board, session("d"), linked),
			null,
		);
		assert.equal(linkableAt({ x: 950, y: 50 }, board, session("a"), []), null);
	});
});

describe("linkables", () => {
	it("offers placed session cards, refusing ones it cannot link", () => {
		const node = (id: string, x: number): PlacedNode => ({
			key: `session:${id}`,
			ref: { kind: "session", id },
			family: 0,
			x,
			y: 0,
			w: 312,
			h: 240,
		});
		const sessions = [
			{ id: "a", kind: "background" },
			{ id: "unplaced", kind: "background" },
			{
				id: "cloudy",
				kind: "background",
				cloud: { url: "https://claude.ai/code/x" },
			},
			{ id: "terminal", kind: "interactive" },
		] as Session[];
		const found = linkables(
			new Map([
				["session:a", node("a", 0)],
				["session:cloudy", node("cloudy", 400)],
				["session:terminal", node("terminal", 800)],
			]),
			sessions,
		);
		assert.deepEqual(
			found.map(({ end, refused }) => [end.kind, end.id, refused]),
			[
				["session", "a", false],
				["session", "cloudy", true],
				["session", "terminal", true],
			],
		);
	});
});
