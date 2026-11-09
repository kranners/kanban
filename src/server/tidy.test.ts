import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Project } from "../shared/projects.ts";
import type { ButlerCard, Note, Region } from "../shared/types.ts";
import type { Rect } from "../web/placement.ts";
import {
	columnsFor,
	isHeld,
	movedHoldMs,
	orderCards,
	planTidy,
	projectCwd,
	projectsOfCards,
	unsortedCwd,
	waitingCwd,
} from "./tidy.ts";

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
		id: `t-${id}`,
		kind: "conversation",
		link: "https://discord.com/channels/1/1",
		private: false,
	},
	...fields,
});

const project = (id: string, fields: Partial<Project> = {}): Project => ({
	id,
	title: id,
	parent: null,
	area: "butler",
	kind: "project",
	stage: "building",
	state: "",
	next: "",
	blockedOn: null,
	createdAt: null,
	touchedAt: null,
	stageSince: null,
	links: [],
	history: [],
	stale: false,
	progress: null,
	live: [],
	sessions: [],
	...fields,
});

const change = (ref: string) => ({ kind: "change" as const, ref, url: null });

const placed = (cards: ButlerCard[], plan: ReturnType<typeof planTidy>) =>
	cards.map((c) => {
		const move = plan.moves.find((m) => m.id === c.id);
		return move ? { ...c, x: move.x, y: move.y } : c;
	});

const overlap = (a: Rect, b: Rect) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inside = (c: Rect, r: Rect) =>
	c.x >= r.x && c.y >= r.y && c.x + c.w <= r.x + r.w && c.y + c.h <= r.y + r.h;

const sessions: Rect[] = [{ x: 0, y: 0, w: 400, h: 300 }];

const states = ["working", "needs-you", "idle", "failed", "done"] as const;

/** Cards spread over projects p0 to p5 by their changes, some unlinked. */
const board = (count: number) => {
	const projects = Array.from({ length: 6 }, (_, i) =>
		project(`p${i}`, {
			stage: (["landing", "building", "live", "planned"] as const)[i % 4],
			links: Array.from({ length: count }, (_, c) => c)
				.filter((c) => c % 6 === i && c % 7 !== 3)
				.map((c) => change(`fix-${c}`)),
		}),
	);
	const cards = Array.from({ length: count }, (_, i) =>
		card(`c${i}`, {
			startedAt: i * 1000,
			state: states[i % 5],
			selfFix: `fix-${i}`,
			thread: undefined,
		}),
	);
	return { projects, cards };
};

const plan = (
	cards: ButlerCard[],
	projects: Project[],
	regions: Region[] = [],
	now = 0,
) =>
	planTidy({ cards, notes: [], obstacles: sessions, regions, projects, now });

const regionOf = (p: ReturnType<typeof planTidy>, cwd: string) =>
	p.regions.find((r) => r.cwd === cwd);

describe("Which project a card belongs to", () => {
	it("follows a project's links to the card's change, desk session or thread, else the card that started it", () => {
		const projects = [
			project("fox", { links: [change("20261109-141009-1")] }),
			project("tennis", {
				links: [{ kind: "desk", ref: "1109-26", url: null }],
			}),
			project("ritual", {
				links: [{ kind: "thread", ref: "555", url: null }],
			}),
		];
		const cards = [
			card("change", { selfFix: "20261109-141009-1", thread: undefined }),
			card("desk", { desk: "1109-26" }),
			card("thread-555", {
				thread: {
					id: "555",
					kind: "conversation",
					link: "https://discord.com/channels/1/1",
					private: false,
				},
			}),
			card("child", { parent: "desk" }),
			card("loose"),
		];
		const owners = projectsOfCards(cards, projects);
		assert.equal(owners.get("change"), "fox");
		assert.equal(owners.get("desk"), "tennis");
		assert.equal(owners.get("thread-555"), "ritual");
		assert.equal(owners.get("child"), "tennis");
		assert.equal(owners.get("loose"), null);
	});

	it("prefers a child project to its parent when both link the same card, and survives a loop of parents", () => {
		const projects = [
			project("butler", { links: [change("fix")] }),
			project("fox", { parent: "butler", links: [change("fix")] }),
		];
		const owners = projectsOfCards(
			[
				card("a", { selfFix: "fix", thread: undefined }),
				card("x", { parent: "y" }),
				card("y", { parent: "x" }),
			],
			projects,
		);
		assert.equal(owners.get("a"), "fox");
		assert.equal(owners.get("x"), null);
	});
});

describe("Tidy's project regions", () => {
	it("puts each card in its project's region, unlinked ones in Unsorted and those waiting on Aaron in the strip", () => {
		const { projects, cards } = board(30);
		const p = plan(cards, projects);
		const after = placed(cards, p);
		const owners = projectsOfCards(cards, projects);
		for (const c of after) {
			const owner = owners.get(c.id);
			const cwd =
				c.state === "needs-you"
					? waitingCwd
					: owner
						? projectCwd(owner)
						: unsortedCwd;
			const region = regionOf(p, cwd);
			assert.ok(region, `${c.id} has a region ${cwd}`);
			assert.ok(inside(c, region), `${c.id} inside ${cwd}`);
		}
		assert.equal(regionOf(p, projectCwd("p0"))?.name, "p0");
		assert.ok(regionOf(p, unsortedCwd));
	});

	it("never overlaps two regions, a region and a session, or two cards outside a done stack", () => {
		const { projects, cards } = board(40);
		const p = plan(cards, projects);
		const after = placed(cards, p).filter((c) => c.state !== "done");
		for (const [i, a] of after.entries()) {
			for (const b of after.slice(i + 1))
				assert.ok(!overlap(a, b), `${a.id} ${b.id}`);
		}
		for (const [i, a] of p.regions.entries()) {
			for (const b of p.regions.slice(i + 1))
				assert.ok(!overlap(a, b), `${a.cwd} ${b.cwd}`);
			for (const s of sessions) assert.ok(!overlap(a, s), a.cwd);
		}
	});

	it("lays the strip across the top and the projects in rows by stage, never one tall column", () => {
		const { projects, cards } = board(40);
		const p = plan(cards, projects);
		const strip = regionOf(p, waitingCwd);
		assert.ok(strip);
		const below = p.regions.filter((r) => r.cwd !== waitingCwd);
		assert.ok(below.every((r) => r.y >= strip.y + strip.h));
		assert.ok(
			below.every((r) => r.x >= strip.x && r.x + r.w <= strip.x + strip.w),
		);
		const rows = new Set(below.map((r) => r.y));
		assert.ok(rows.size < below.length, "several regions share a row");
		const first = below[0];
		assert.ok(first);
		assert.equal(
			projects.find((x) => projectCwd(x.id) === first.cwd)?.stage,
			"landing",
		);
		assert.equal(below.at(-1)?.cwd, unsortedCwd);
		assert.equal(columnsFor(1), 1);
		assert.equal(columnsFor(4), 2);
		assert.equal(columnsFor(9), 3);
		assert.equal(columnsFor(30), 4);
	});

	it("orders working cards first, then failed, idle and done, each followed by those it started", () => {
		const order = orderCards([
			card("old", { startedAt: 1 }),
			card("new", { startedAt: 9 }),
			card("child", { startedAt: 2, parent: "old" }),
			card("busy", { startedAt: 0, state: "working" }),
			card("broke", { startedAt: 0, state: "failed" }),
			card("over", { startedAt: 9, state: "done" }),
		]).map((c) => c.id);
		assert.deepEqual(order, ["busy", "broke", "new", "old", "child", "over"]);
	});

	it("stacks a project's done cards in one slot until Aaron opens the stack", () => {
		const projects = [
			project("p", { links: ["a", "b", "c", "d"].map(change) }),
		];
		const cards = ["a", "b", "c", "d"].map((id, i) =>
			card(id, {
				selfFix: id,
				thread: undefined,
				state: i === 0 ? "working" : "done",
				startedAt: i,
			}),
		);
		const shut = placed(cards, plan(cards, projects));
		const done = shut.filter((c) => c.state === "done");
		const spread =
			Math.max(...done.map((c) => c.x)) - Math.min(...done.map((c) => c.x));
		assert.ok(spread <= 24, "the done cards sit in one stack");
		const region: Region = {
			id: "r",
			cwd: projectCwd("p"),
			name: "p",
			x: 0,
			y: 0,
			w: 96,
			h: 96,
			doneOpen: true,
		};
		const open = placed(cards, plan(cards, projects, [region]));
		const openDone = open.filter((c) => c.state === "done");
		for (const [i, a] of openDone.entries()) {
			for (const b of openDone.slice(i + 1)) assert.ok(!overlap(a, b));
		}
	});

	it("is idempotent: tidying a tidy board moves nothing and changes no region", () => {
		const { projects, cards } = board(25);
		const first = plan(cards, projects);
		const regions: Region[] = first.regions.map((r, i) => ({
			...r,
			id: r.id ?? `r${i}`,
		}));
		const again = plan(placed(cards, first), projects, regions);
		assert.deepEqual(again.moves, []);
		assert.deepEqual(again.removed, []);
		assert.deepEqual(
			again.regions.map(({ id: _id, ...r }) => r),
			first.regions.map(({ id: _id, ...r }) => r),
		);
	});

	it("leaves a pinned card, or one Aaron dragged lately, where it is and flows around it", () => {
		const projects = [project("p", { links: [change("a"), change("b")] })];
		const pinned = card("pinned", { pinned: true, x: -720, y: 48 });
		const dragged = card("dragged", { movedAt: 1000, x: 9000, y: 9000 });
		assert.ok(isHeld(dragged, 1000 + movedHoldMs - 1));
		assert.ok(!isHeld(dragged, 1000 + movedHoldMs));
		const others = [
			card("a", { selfFix: "a", thread: undefined, startedAt: 3 }),
			card("b", { selfFix: "b", thread: undefined, startedAt: 2 }),
		];
		const p = plan([pinned, dragged, ...others], projects, [], 1000);
		assert.ok(!p.moves.some((m) => m.id === "pinned" || m.id === "dragged"));
		for (const c of placed(others, p)) assert.ok(!overlap(c, pinned), c.id);
	});

	it("keeps the bounds of a region Aaron moved or resized and lays its cards inside them", () => {
		const projects = [
			project("p", { links: ["a", "b", "c"].map(change) }),
			project("q", { links: [change("z")] }),
		];
		const cards = ["a", "b", "c", "z"].map((id) =>
			card(id, { selfFix: id, thread: undefined }),
		);
		const mine: Region = {
			id: "mine",
			cwd: projectCwd("p"),
			name: "p",
			x: -4800,
			y: 2400,
			w: 1200,
			h: 1200,
			manual: true,
		};
		const p = plan(cards, projects, [mine]);
		const kept = regionOf(p, projectCwd("p"));
		assert.deepEqual(kept && { x: kept.x, y: kept.y, w: kept.w, h: kept.h }, {
			x: -4800,
			y: 2400,
			w: 1200,
			h: 1200,
		});
		for (const c of placed(cards, p).filter((c) => c.id !== "z")) {
			assert.ok(inside(c, mine), c.id);
		}
		const empty = plan([], projects, [mine]);
		assert.ok(
			regionOf(empty, projectCwd("p")),
			"a region Aaron shaped stays though empty",
		);
		assert.deepEqual(empty.removed, []);
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
		const p = planTidy({
			cards: [a, b],
			notes: [note],
			obstacles: sessions,
			regions: [],
			now: 0,
		});
		const [pa, pb] = placed([a, b], p);
		const moved = p.moves.find((m) => m.id === "n");
		assert.ok(pa && pb && moved);
		assert.equal(moved.y, pa.y);
		assert.ok(moved.x >= pa.x + pa.w);
		assert.ok(!overlap({ ...note, ...moved }, pb));
	});

	it("reuses its regions by their folder, and removes the old topic regions and projects with no cards left", () => {
		const projects = [project("p", { links: [change("a")] }), project("gone")];
		const at = (id: string, cwd: string): Region => ({
			id,
			cwd,
			name: id,
			x: 0,
			y: 0,
			w: 100,
			h: 100,
		});
		const p = plan([card("a", { selfFix: "a", thread: undefined })], projects, [
			at("r1", projectCwd("p")),
			at("old", "/kanban/butler/threads"),
			at("stale", projectCwd("gone")),
			at("aarons", "/Users/aaron/workspace/jimbo"),
		]);
		assert.equal(regionOf(p, projectCwd("p"))?.id, "r1");
		assert.deepEqual(p.removed.sort(), ["old", "stale"]);
		assert.equal(regionOf(p, unsortedCwd), undefined);
	});
});
