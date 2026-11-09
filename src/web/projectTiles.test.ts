import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectsOfCards } from "../shared/butlerRegions.ts";
import type { Project } from "../shared/projects.ts";
import type { ButlerCard } from "../shared/types.ts";
import {
	inFilter,
	progressOf,
	stalledMs,
	tileKeyOf,
	tileOf,
} from "./projectTiles.ts";

const card = (id: string, fields: Partial<ButlerCard> = {}): ButlerCard => ({
	id,
	kind: "butler-card",
	title: id,
	state: "idle",
	x: 0,
	y: 0,
	w: 312,
	h: 216,
	z: 1,
	updatedAt: 0,
	...fields,
});

const project = (id: string, fields: Partial<Project> = {}): Project => ({
	id,
	title: `Title of ${id}`,
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

describe("A project region's overview tile", () => {
	const now = stalledMs * 10;
	const projects = [
		project("fox", {
			links: ["a", "b", "c", "d", "e", "f"].map(change),
			sessions: ["s1"],
		}),
		project("tennis"),
	];
	const byId = new Map(projects.map((p) => [p.id, p]));
	const cards = [
		card("a", { selfFix: "a", state: "working", updatedAt: now }),
		card("b", { selfFix: "b", state: "working", updatedAt: 0 }),
		card("c", { selfFix: "c", state: "needs-you" }),
		card("d", { selfFix: "d", state: "failed" }),
		card("e", { selfFix: "e", state: "done" }),
		card("f", { selfFix: "f", state: "done" }),
		card("loose", { state: "working", updatedAt: now }),
		card("ghost", { selfFix: "gone" }),
	];
	const owners = projectsOfCards(cards, projects);

	it("counts its cards by status, a working card with no news for 10 minutes as stalled and one waiting in the strip as its own", () => {
		const tile = tileOf("fox", cards, owners, byId, now);
		assert.equal(tile.title, "Title of fox");
		assert.deepEqual(tile.counts, {
			working: 1,
			"needs-you": 1,
			stalled: 1,
			failed: 1,
			idle: 0,
			done: 2,
		});
	});

	it("puts cards no known project claims in Unsorted, and counts nothing for a project with no cards", () => {
		const unsorted = tileOf(null, cards, owners, byId, now);
		assert.equal(unsorted.title, "Unsorted");
		assert.deepEqual(
			unsorted.cards.map((c) => c.id),
			["loose", "ghost"],
		);
		const empty = tileOf("tennis", cards, owners, byId, now);
		assert.equal(
			Object.values(empty.counts).reduce((a, b) => a + b, 0),
			0,
		);
	});

	it("knows its regions by their folder", () => {
		assert.equal(tileKeyOf("/kanban/butler/project/fox"), "fox");
		assert.equal(tileKeyOf("/kanban/butler/unsorted"), null);
		assert.equal(tileKeyOf("/kanban/butler/waiting"), undefined);
		assert.equal(tileKeyOf("/Users/aaron/workspace/jimbo"), undefined);
	});

	it("shows its progress from the project, else from how far along its stage is", () => {
		assert.equal(progressOf(project("p", { progress: 0.4 })), 0.4);
		assert.equal(progressOf(project("p", { stage: "idea" })), 0);
		assert.equal(progressOf(project("p", { stage: "done" })), 1);
		assert.equal(progressOf(project("p", { stage: "paused" })), null);
		assert.equal(progressOf(null), null);
	});

	it("filters the board to one project's cards and linked sessions", () => {
		assert.ok(inFilter(null, { card: "loose" }, owners, byId));
		assert.ok(inFilter("fox", { card: "a" }, owners, byId));
		assert.ok(!inFilter("fox", { card: "loose" }, owners, byId));
		assert.ok(inFilter("unsorted", { card: "loose" }, owners, byId));
		assert.ok(inFilter("fox", { session: "s1" }, owners, byId));
		assert.ok(!inFilter("fox", { session: "s2" }, owners, byId));
	});
});
