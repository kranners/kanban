import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Relation, RelationEnd, Session } from "../shared/types.ts";
import type { PlacedNode } from "./layout.ts";
import { type Linkable, linkableAt, linkables } from "./linking.ts";

const session = (id: string): RelationEnd => ({ kind: "session", id });
const docs = (id: string): RelationEnd => ({ kind: "docs", id });

const candidate = (
	end: RelationEnd,
	x: number,
	y: number,
	refused = false,
): Linkable => ({ end, rect: { x, y, w: 100, h: 100 }, refused });

const board: Linkable[] = [
	candidate(docs("d1"), 0, 0),
	candidate(docs("d2"), 300, 0),
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
			kind: "docs",
			id: "d1",
		});
		assert.equal(linkableAt({ x: 250, y: 250 }, board, session("b"), []), null);
	});

	it("leaves out the source, doc store pairs, existing links and cloud sessions", () => {
		assert.equal(linkableAt({ x: 650, y: 50 }, board, session("b"), []), null);
		assert.equal(linkableAt({ x: 350, y: 50 }, board, docs("d1"), []), null);
		assert.deepEqual(linkableAt({ x: 650, y: 50 }, board, docs("d1"), []), {
			kind: "session",
			id: "b",
		});
		const linked = [link(session("b"), docs("d2"))];
		assert.equal(
			linkableAt({ x: 350, y: 50 }, board, session("b"), linked),
			null,
		);
		assert.equal(
			linkableAt({ x: 650, y: 50 }, board, docs("d2"), linked),
			null,
		);
		assert.equal(linkableAt({ x: 950, y: 50 }, board, session("a"), []), null);
	});
});

describe("linkables", () => {
	it("offers doc stores by stacking order beneath placed session cards", () => {
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
		const store = {
			kind: "docs",
			y: 0,
			w: 288,
			h: 216,
			title: "Docs",
		} as const;
		const found = linkables(
			new Map([
				["session:a", node("a", 0)],
				["session:cloudy", node("cloudy", 400)],
				["session:terminal", node("terminal", 800)],
			]),
			sessions,
			{
				high: { id: "high", ...store, x: 10, z: 5 },
				low: { id: "low", ...store, x: 20, z: 1 },
				note: {
					id: "note",
					kind: "note",
					x: 0,
					y: 0,
					w: 10,
					h: 10,
					z: 9,
					color: "yellow",
					text: "",
				},
			},
		);
		assert.deepEqual(
			found.map(({ end, refused }) => [end.kind, end.id, refused]),
			[
				["docs", "low", false],
				["docs", "high", false],
				["session", "a", false],
				["session", "cloudy", true],
				["session", "terminal", true],
			],
		);
	});
});
