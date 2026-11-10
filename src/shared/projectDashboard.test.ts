import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	bandsOf,
	dashboardOf,
	graphOf,
	neighboursIn,
	workStateOf,
} from "./projectDashboard.ts";
import type { Project } from "./projects.ts";
import type { ButlerCard } from "./types.ts";

const hour = 3_600_000;
const now = 1_800_000_000_000;

const project = (fields: Partial<Project>): Project => ({
	id: "p",
	title: "P",
	parent: null,
	area: "",
	kind: "",
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

const card = (fields: Partial<ButlerCard> & { id: string }): ButlerCard =>
	({
		kind: "butler-card",
		title: fields.id,
		state: "idle",
		updatedAt: now,
		x: 0,
		y: 0,
		...fields,
	}) as ButlerCard;

describe("workStateOf", () => {
	it("reads a session or card's activity as a work state", () => {
		assert.equal(workStateOf("working"), "progress");
		assert.equal(workStateOf("needs-you"), "aaron");
		assert.equal(workStateOf("failed"), "other");
		assert.equal(workStateOf("stopped"), "idle");
	});
});

describe("bandsOf", () => {
	it("keeps the loudest state in each slot and joins equal runs", () => {
		const bands = bandsOf(
			[
				{ from: now - 12 * hour, to: now - 6 * hour, state: "progress" },
				{ from: now - 9 * hour, to: now - 8 * hour, state: "aaron" },
			],
			now,
		);
		assert.deepEqual(
			bands.map((b) => b.state),
			["idle", "progress", "aaron", "progress", "idle"],
		);
		assert.equal(bands[0]?.from, 0);
		assert.equal(bands.at(-1)?.to, 1);
	});

	it("is one idle band with no work", () => {
		assert.deepEqual(bandsOf([], now), [{ from: 0, to: 1, state: "idle" }]);
	});
});

describe("graphOf", () => {
	const graph = {
		updatedAt: now - hour,
		nodes: [
			{
				id: "a",
				title: "A",
				sub: "",
				state: "done" as const,
				owner: null,
				ref: null,
			},
			{
				id: "b",
				title: "B",
				sub: "",
				state: "idle" as const,
				owner: null,
				ref: "20261101-101010-1",
			},
			{
				id: "c",
				title: "C",
				sub: "",
				state: "idle" as const,
				owner: null,
				ref: null,
			},
			{
				id: "d",
				title: "D",
				sub: "",
				state: "idle" as const,
				owner: null,
				ref: null,
			},
		],
		edges: [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "a", to: "d" },
		],
	};

	it("lays nodes out by longest path and finds the critical path", () => {
		const g = graphOf(project({ graph }), [], [], new Map());
		const byId = new Map(g.nodes.map((n) => [n.id, n]));
		assert.equal(byId.get("c")?.layer, 2);
		assert.equal(byId.get("d")?.layer, 1);
		assert.deepEqual(
			g.edges.filter((e) => e.critical).map((e) => `${e.from}>${e.to}`),
			["a>b", "b>c"],
		);
		assert.equal(g.best, "b");
		assert.equal(byId.get("d")?.ready, true);
		assert.equal(byId.get("c")?.ready, false);
	});

	it("takes a node's state live from the card its ref names", () => {
		const live = card({
			id: "selffix:x",
			selfFix: "20261101-101010-1",
			state: "working",
		});
		const g = graphOf(
			project({ graph }),
			[],
			[
				{
					id: live.id,
					kind: "card",
					title: "B work",
					activity: "working",
					state: "progress",
					status: "Writing tests",
					startedAt: null,
					finishedAt: null,
					updatedAt: now,
					link: null,
					via: null,
				},
			],
			new Map([[live.id, live]]),
		);
		const b = g.nodes.find((n) => n.id === "b");
		assert.equal(b?.state, "progress");
		assert.equal(b?.live, true);
		assert.equal(b?.sub, "Writing tests");
	});

	it("survives a loop in the edges", () => {
		const g = graphOf(
			project({
				graph: {
					...graph,
					edges: [
						{ from: "a", to: "b" },
						{ from: "b", to: "a" },
					],
				},
			}),
			[],
			[],
			new Map(),
		);
		assert.equal(g.nodes.length, 4);
	});

	it("falls back to sub-projects and work with no edges", () => {
		const g = graphOf(
			project({}),
			[project({ id: "kid", title: "Kid", stage: "live" })],
			[],
			new Map(),
		);
		assert.equal(g.authored, false);
		assert.deepEqual(
			g.nodes.map((n) => [n.id, n.state]),
			[["project:kid", "done"]],
		);
		assert.equal(g.best, null);
	});
});

describe("dashboardOf", () => {
	const garden = project({
		id: "garden",
		history: [{ at: now - 2 * hour, stage: "building", note: "Valves wired" }],
	});
	const thread = card({
		id: "thread-1",
		title: "Sensor pairing",
		state: "needs-you",
		thread: { id: "1", kind: "conversation" } as ButlerCard["thread"],
		history: [
			{ at: now - 3 * hour, state: "working" },
			{ at: now - hour, state: "needs-you" },
		],
	});
	const input = {
		project: garden,
		projects: [garden],
		owners: new Map([
			["thread-1", "garden"],
			["s1", "garden"],
		]),
		cards: [thread],
		sessions: [
			{
				id: "s1",
				short: null,
				name: "Soil",
				goal: null,
				activity: "working" as const,
				startedAt: now - 30 * 60_000,
				updatedAt: now,
				needs: null,
				doing: "Reading",
			},
		],
		approvals: [
			{
				thread: "1",
				title: "Sensor pairing",
				approval: { at: now - hour, headline: "Buy batteries" },
			},
		],
		now,
	};

	it("puts approvals on the project's thread cards under needs you, once", () => {
		const d = dashboardOf(input);
		assert.deepEqual(
			d.needs.map((n) => [n.kind, n.title]),
			[["approval", "Buy batteries"]],
		);
	});

	it("is moving while a session works, counting the day's activity", () => {
		const d = dashboardOf(input);
		assert.equal(d.movement.state, "moving");
		assert.equal(d.movement.working, 1);
		assert.equal(d.movement.activity, 4);
		assert.ok(d.movement.bands.some((b) => b.state === "aaron"));
		assert.deepEqual(
			d.movement.rows.map((r) => r.title),
			["Sensor pairing", "Soil"],
		);
	});

	it("is blocked on you once nothing works and something waits on you", () => {
		const d = dashboardOf({ ...input, sessions: [] });
		assert.equal(d.movement.state, "blocked");
		assert.equal(d.movement.on, "you");
	});

	it("is idling with nothing at all", () => {
		const d = dashboardOf({
			...input,
			project: project({ id: "thin", stage: "idea" }),
			projects: [],
			owners: new Map(),
			approvals: [],
		});
		assert.equal(d.movement.state, "idling");
		assert.deepEqual(d.needs, []);
		assert.deepEqual(d.graph.nodes, []);
	});

	it("tells the timeline's stage moves and starts apart, oldest first", () => {
		const d = dashboardOf(input);
		assert.deepEqual(
			d.timeline.map((e) => [e.kind, e.label]),
			[
				["start", "Sensor pairing"],
				["stage", "Valves wired"],
				["start", "Soil"],
			],
		);
	});
});

describe("neighboursIn", () => {
	const column = ["a", "b", "c"].map((id) => ({ project: project({ id }) }));
	it("names the projects either side and the position", () => {
		assert.deepEqual(neighboursIn(column, "b"), {
			index: 1,
			count: 3,
			previous: "a",
			next: "c",
		});
		assert.deepEqual(neighboursIn(column, "a").previous, null);
		assert.deepEqual(neighboursIn(column, "c").next, null);
	});
});
