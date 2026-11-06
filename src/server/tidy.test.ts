import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ButlerCard, Note } from "../shared/types.ts";
import type { Rect } from "../web/placement.ts";
import { isHeld, movedHoldMs, orderCards, planTidy, topicOf } from "./tidy.ts";

const card = (id: string, fields: Partial<ButlerCard> = {}): ButlerCard => ({
	id,
	kind: "butler-card",
	title: id,
	state: "idle",
	x: 5000,
	y: 5000,
	w: 312,
	h: 216,
	z: 1,
	updatedAt: 0,
	thread: {
		id: "1",
		kind: "conversation",
		link: "https://discord.com/channels/1/1",
		private: false,
	},
	...fields,
});

const placed = (cards: ButlerCard[], plan: ReturnType<typeof planTidy>) =>
	cards.map((c) => {
		const move = plan.moves.find((m) => m.id === c.id);
		return move ? { ...c, x: move.x, y: move.y } : c;
	});

const overlap = (a: Rect, b: Rect) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const many = (count: number) =>
	Array.from({ length: count }, (_, i) =>
		card(`c${i}`, {
			startedAt: i * 1000,
			state: (["working", "needs-you", "idle", "done", "failed"] as const)[
				i % 5
			],
			...(i % 3 === 0
				? {
						selfFix: `20261106-1414${String(i).padStart(2, "0")}-1`,
						thread: undefined,
					}
				: {}),
			...(i % 7 === 0
				? {
						thread: {
							id: String(i),
							kind: "scheduled",
							link: "https://discord.com/channels/1/2",
							private: false,
						},
					}
				: {}),
		}),
	);

const sessions: Rect[] = [{ x: 0, y: 0, w: 400, h: 300 }];

describe("Tidy's layout", () => {
	it("puts each card in its topic", () => {
		assert.equal(topicOf(card("a", { state: "needs-you" })), "waiting");
		assert.equal(
			topicOf(card("b", { selfFix: "20261106-141450-1", thread: undefined })),
			"changes",
		);
		assert.equal(
			topicOf(
				card("c", {
					thread: {
						id: "2",
						kind: "job",
						link: "https://discord.com/channels/1/2",
						private: false,
					},
				}),
			),
			"jobs",
		);
		assert.equal(topicOf(card("d")), "butler");
	});

	it("never overlaps two cards, a card and a session, or two regions", () => {
		const cards = many(23);
		const plan = planTidy({
			cards,
			notes: [],
			obstacles: sessions,
			regions: [],
			now: 0,
		});
		const after = placed(cards, plan);
		for (const [i, a] of after.entries()) {
			for (const b of after.slice(i + 1))
				assert.ok(!overlap(a, b), `${a.id} ${b.id}`);
			for (const s of sessions) assert.ok(!overlap(a, s), a.id);
		}
		for (const [i, a] of plan.regions.entries()) {
			for (const b of plan.regions.slice(i + 1)) assert.ok(!overlap(a, b));
			for (const s of sessions) assert.ok(!overlap(a, s));
		}
	});

	it("sizes each region to hold its cards and places all four left to right from Waiting on you", () => {
		const cards = many(23);
		const plan = planTidy({
			cards,
			notes: [],
			obstacles: sessions,
			regions: [],
			now: 0,
		});
		const after = placed(cards, plan);
		assert.deepEqual(
			plan.regions.map((r) => r.name),
			["Waiting on you", "Butler", "Jobs", "Changes"],
		);
		for (const c of after) {
			const region = plan.regions.find((r) => r.topic === topicOf(c));
			assert.ok(region);
			assert.ok(
				c.x >= region.x &&
					c.y >= region.y &&
					c.x + c.w <= region.x + region.w &&
					c.y + c.h <= region.y + region.h,
				c.id,
			);
		}
		assert.ok(plan.regions.every((r) => r.y === 0));
	});

	it("is stable: tidying a tidy board moves nothing, and a new card takes the next free slot", () => {
		const cards = many(9);
		const first = placed(
			cards,
			planTidy({ cards, notes: [], obstacles: sessions, regions: [], now: 0 }),
		);
		const again = planTidy({
			cards: first,
			notes: [],
			obstacles: sessions,
			regions: [],
			now: 0,
		});
		assert.deepEqual(again.moves, []);
	});

	it("orders by state, then newest first, each card followed by those it started", () => {
		const order = orderCards([
			card("old", { startedAt: 1 }),
			card("new", { startedAt: 9 }),
			card("child", { startedAt: 2, parent: "old" }),
			card("busy", { startedAt: 0, state: "working" }),
		]).map((c) => c.id);
		assert.deepEqual(order, ["busy", "new", "old", "child"]);
	});

	it("leaves a pinned card, or one Aaron dragged lately, where it is and flows around it", () => {
		const pinned = card("pinned", { pinned: true, x: -720, y: 48 });
		const dragged = card("dragged", { movedAt: 1000, x: 9000, y: 9000 });
		assert.ok(isHeld(dragged, 1000 + movedHoldMs - 1));
		assert.ok(!isHeld(dragged, 1000 + movedHoldMs));
		const others = [card("a", { startedAt: 3 }), card("b", { startedAt: 2 })];
		const plan = planTidy({
			cards: [pinned, dragged, ...others],
			notes: [],
			obstacles: sessions,
			regions: [],
			now: 1000,
		});
		assert.ok(!plan.moves.some((m) => m.id === "pinned" || m.id === "dragged"));
		const after = placed(others, plan);
		for (const c of after) assert.ok(!overlap(c, pinned), c.id);
	});

	it("moves Butler's notes with their card and keeps them clear of the next card", () => {
		const a = card("a", { startedAt: 2 });
		const b = card("b", { startedAt: 1 });
		const note: Note = {
			id: "n",
			kind: "note",
			text: "hi",
			color: "blue",
			author: "butler",
			session: "a",
			x: 0,
			y: 0,
			w: 240,
			h: 120,
			z: 1,
		};
		const plan = planTidy({
			cards: [a, b],
			notes: [note],
			obstacles: sessions,
			regions: [],
			now: 0,
		});
		const [pa, pb] = placed([a, b], plan);
		const moved = plan.moves.find((m) => m.id === "n");
		assert.ok(pa && pb && moved);
		assert.equal(moved.y, pa.y);
		assert.ok(moved.x >= pa.x + pa.w);
		assert.ok(!overlap({ ...note, ...moved }, pb));
	});

	it("reuses the regions it made before, by their folder", () => {
		const plan = planTidy({
			cards: [card("a")],
			notes: [],
			obstacles: sessions,
			regions: [
				{
					id: "r1",
					cwd: "/kanban/butler/threads",
					name: "Butler",
					x: 0,
					y: 0,
					w: 100,
					h: 100,
				},
			],
			now: 0,
		});
		assert.equal(plan.regions.find((r) => r.topic === "butler")?.id, "r1");
	});
});
