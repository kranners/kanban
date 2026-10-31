import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Board, Relation, Session } from "../shared/types.ts";
import { pruneAfterMs } from "./layout.ts";
import {
	createRelationStore,
	loadRelations,
	parseRelationDraft,
	parseRelations,
} from "./relations.ts";

const session = (id: string, short: string | null = null): Session => ({
	id,
	short,
	pid: 1,
	name: id,
	cwd: "/Users/me/dev/acme-api",
	project: "acme-api",
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
});

const boardOf = (...sessions: Session[]): Board => ({
	sessions,
	subagents: [],
	subagentCounts: {},
	subagentStates: {},
	workflowRuns: {},
	workflows: [],
	links: [],
	messages: [],
	generatedAt: 0,
});

const api = { kind: "session", id: "api" } as const;
const web = { kind: "session", id: "web" } as const;
const guide = { kind: "docs", id: "guide" } as const;

const storeAt = async (clock = { now: 0 }, initial: Relation[] = []) => {
	const file = join(
		await mkdtemp(join(tmpdir(), "kanban-relations-")),
		"r.json",
	);
	const changes: Relation[][] = [];
	let count = 0;
	const store = createRelationStore({
		file,
		initial,
		onChange: (next) => changes.push(next),
		newId: () => `rel-${++count}`,
		now: () => clock.now,
	});
	return { store, file, changes, clock };
};

describe("parseRelationDraft", () => {
	it("takes a session and a session or doc store", () => {
		assert.deepEqual(parseRelationDraft({ from: api, to: web, extra: 1 }), {
			from: api,
			to: web,
		});
		assert.deepEqual(parseRelationDraft({ from: guide, to: api }), {
			from: guide,
			to: api,
		});
	});

	it("refuses self links, doc-to-doc links and malformed ends", () => {
		for (const body of [
			null,
			{ from: api },
			{ from: api, to: api },
			{ from: guide, to: { kind: "docs", id: "other" } },
			{ from: api, to: { kind: "subagent", id: "a1" } },
			{ from: api, to: { kind: "session", id: "../x" } },
		]) {
			assert.ok("error" in parseRelationDraft(body), JSON.stringify(body));
		}
	});
});

describe("parseRelations", () => {
	it("drops malformed rows and repeated pairs either way round", () => {
		const kept = parseRelations([
			{ id: "r1", from: api, to: web, createdAt: 1 },
			{ id: "r2", from: web, to: api, createdAt: 2 },
			{ id: "r3", from: api, to: api, createdAt: 3 },
			{ id: "r4", from: api, to: guide },
			{ id: "r5", from: api, to: guide, createdAt: 5 },
		]);
		assert.deepEqual(
			kept.map((relation) => relation.id),
			["r1", "r5"],
		);
		assert.deepEqual(parseRelations({ r1: {} }), []);
	});
});

describe("createRelationStore", () => {
	it("creates, refuses repeats, removes and persists relations", async () => {
		const { store, file, changes } = await storeAt();
		const created = store.create({ from: api, to: web });
		assert.deepEqual(created, {
			id: "rel-1",
			from: api,
			to: web,
			createdAt: 0,
		});
		assert.deepEqual(store.create({ from: web, to: api }), {
			error: "These two are already linked",
		});
		store.create({ from: api, to: guide });
		assert.equal(store.remove("rel-1"), true);
		assert.equal(store.remove("rel-1"), false);
		assert.equal(changes.length, 3);
		await store.saved();
		assert.deepEqual(await loadRelations(file), [
			{ id: "rel-2", from: api, to: guide, createdAt: 0 },
		]);
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), store.current());
	});

	it("drops every relation touching a removed end", async () => {
		const { store, changes } = await storeAt();
		store.create({ from: api, to: guide });
		store.create({ from: web, to: guide });
		store.create({ from: api, to: web });
		store.removeEnd(guide);
		assert.deepEqual(
			store.current().map((relation) => relation.id),
			["rel-3"],
		);
		store.removeEnd(guide);
		assert.equal(changes.length, 4);
	});

	it("links a spawned session to its doc stores once it lands", async () => {
		const { store } = await storeAt();
		const settle = store.expect([guide]);
		store.observe(boardOf(session("api")));
		assert.deepEqual(store.current(), []);
		settle({ short: "feedbeef" });
		store.observe(boardOf(session("api"), session("new", "feedbeef")));
		assert.deepEqual(store.current(), [
			{
				id: "rel-1",
				from: { kind: "session", id: "new" },
				to: guide,
				createdAt: 0,
			},
		]);
		store.observe(boardOf(session("new", "feedbeef")));
		assert.equal(store.current().length, 1);
	});

	it("forgets a spawn that failed or never landed", async () => {
		const { store, clock } = await storeAt();
		store.expect([guide])(null);
		const lost = store.expect([guide]);
		lost({ id: "session_01lost" });
		clock.now = 11 * 60_000;
		store.observe(boardOf());
		clock.now += 1;
		store.observe(boardOf(session("session_01lost")));
		assert.deepEqual(store.current(), []);
	});

	it("prunes relations to sessions gone for a day", async () => {
		const { store, clock } = await storeAt();
		store.create({ from: api, to: web });
		store.create({ from: web, to: guide });
		store.observe(boardOf(session("web")));
		clock.now = pruneAfterMs;
		store.observe(boardOf(session("web")));
		assert.equal(store.current().length, 2);
		clock.now = pruneAfterMs + 1;
		store.observe(boardOf(session("web")));
		assert.deepEqual(
			store.current().map((relation) => relation.id),
			["rel-2"],
		);
	});
});
