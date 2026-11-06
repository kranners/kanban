import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ButlerCard, Session } from "../shared/types.ts";
import {
	archiveGraceMs,
	archiveKeptMs,
	compact,
	createArchiveStore,
	entryOfCard,
	keepsOnBoard,
	listArchive,
	loadArchive,
	parseArchiveQuery,
	sessionGoneMs,
} from "./archive.ts";

const card = (fields: Partial<ButlerCard> = {}): ButlerCard => ({
	id: "thread-11111111",
	kind: "butler-card",
	title: "Mail sweep",
	state: "done",
	status: "Archived",
	x: 0,
	y: 0,
	w: 312,
	h: 216,
	z: 1,
	updatedAt: 1000,
	finishedAt: 1000,
	thread: {
		id: "11111111",
		kind: "desk",
		link: "https://discord.com/channels/1/11111111",
		private: false,
	},
	...fields,
});

const session = (id: string, fields: Partial<Session> = {}): Session => ({
	id,
	short: null,
	pid: null,
	name: `s-${id}`,
	cwd: "/work/repo-a",
	project: "repo-a",
	kind: "background",
	activity: "done",
	doing: "Landed it",
	needs: null,
	goal: "Fix the build",
	startedAt: 100,
	updatedAt: 500,
	attachable: false,
	cmux: false,
	artifacts: [],
	tasks: [],
	steps: [],
	cloud: { url: "https://claude.ai/code/x" },
	...fields,
});

describe("The archive's rules", () => {
	it("archives only finished work, 30 minutes on", () => {
		assert.equal(
			keepsOnBoard(card(), 1000 + archiveGraceMs - 1),
			"finished lately",
		);
		assert.equal(keepsOnBoard(card(), 1000 + archiveGraceMs), null);
		for (const state of ["needs-you", "working", "idle", "failed"] as const) {
			assert.equal(keepsOnBoard(card({ state }), 1e12), state);
		}
		assert.equal(keepsOnBoard(card({ pinned: true }), 1e12), "pinned");
	});

	it("reads when a card finished from its timeline when the feed gave no time", () => {
		const c = card({
			finishedAt: undefined,
			updatedAt: 9000,
			history: [
				{ at: 100, state: "working" },
				{ at: 700, state: "done", status: "Finished" },
				{ at: 800, state: "done", status: "Archived" },
			],
		});
		assert.equal(keepsOnBoard(c, 700 + archiveGraceMs), null);
	});

	it("records what a card was, who asked and how it ended", () => {
		const entry = entryOfCard(
			card({
				parent: "thread-1",
				machines: ["pilot"],
				mission: { id: "m1", covers: "mail" },
			}),
			{
				project: "Butler",
				parent: { id: "thread-1", title: "DM" },
				log: [{ at: 5, kind: "reply", text: "All done" }],
			},
			"auto",
			5000,
		);
		assert.equal(entry.kind, "desk");
		assert.equal(entry.outcome, "done");
		assert.equal(entry.report, "All done");
		assert.equal(entry.parent?.title, "DM");
		assert.deepEqual(entry.machines, ["pilot"]);
		assert.equal(entry.mission?.id, "m1");
		const change = entryOfCard(
			card({
				id: "self-fix-20261106-141450-1",
				thread: undefined,
				selfFix: "20261106-141450-1",
				status: "archived",
				history: [{ at: 1, state: "working", status: "running" }],
				link: "https://claude.ai/code/session_1",
				summary: "Report",
			}),
			{ project: "Changes" },
			"closed",
			5000,
		);
		assert.equal(change.kind, "change");
		assert.equal(change.outcome, "superseded");
		assert.equal(change.session, "https://claude.ai/code/session_1");
	});

	it("compacts an entry to its summary after 90 days", () => {
		const entry = entryOfCard(card(), { project: "Butler" }, "auto", 0);
		assert.ok(entry.card);
		assert.equal(compact(entry, archiveKeptMs - 1), entry);
		const old = compact(entry, archiveKeptMs);
		assert.equal(old.compacted, true);
		assert.equal(old.card, undefined);
		assert.equal(old.discord, undefined);
		assert.equal(old.title, "Mail sweep");
	});
});

describe("The archive store", () => {
	it("keeps its entries across a restart", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-archive-"));
		const file = join(dir, "archive.json");
		const store = createArchiveStore({ file });
		store.add(entryOfCard(card(), { project: "Butler" }, "auto", Date.now()));
		await store.saved();
		const loaded = await loadArchive(file);
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0]?.card?.title, "Mail sweep");
	});

	it("archives a session once it has been gone from the board 10 minutes, not a moment", () => {
		let clock = 0;
		const store = createArchiveStore({ now: () => clock });
		store.observe([session("a"), session("b")]);
		clock = 1000;
		store.observe([session("b")]);
		clock = 1000 + sessionGoneMs - 1;
		assert.equal(store.observe([session("b")]), 0);
		clock = 1000 + sessionGoneMs;
		assert.equal(store.observe([]), 1);
		const entry = store.get("session:a");
		assert.equal(entry?.kind, "session");
		assert.equal(entry?.project, "repo-a");
		assert.equal(entry?.session, "https://claude.ai/code/x");
		// b dropped out only a moment ago.
		assert.equal(store.get("session:b"), undefined);
	});
});

describe("The archive's listing", () => {
	const entries = [
		entryOfCard(
			card({
				id: "thread-1",
				title: "Mail sweep",
				finishedAt: Date.parse("2026-11-05T10:00:00"),
			}),
			{ project: "Butler" },
			"auto",
			0,
		),
		entryOfCard(
			card({
				id: "thread-2",
				title: "Weekly job",
				state: "failed",
				finishedAt: Date.parse("2026-11-06T10:00:00"),
				thread: {
					id: "2",
					kind: "scheduled",
					link: "https://discord.com/channels/1/2",
					private: false,
				},
			}),
			{ project: "Jobs" },
			"closed",
			0,
		),
		entryOfCard(
			card({
				id: "thread-3",
				title: "Another sweep",
				finishedAt: Date.parse("2026-11-06T11:00:00"),
			}),
			{ project: "Butler" },
			"auto",
			0,
		),
	];

	it("lists newest first with counts per day", () => {
		const listing = listArchive(entries, {});
		assert.deepEqual(
			listing.entries.map((e) => e.id),
			["thread-3", "thread-2", "thread-1"],
		);
		assert.deepEqual(listing.days, [
			{ day: "2026-11-06", count: 2 },
			{ day: "2026-11-05", count: 1 },
		]);
		assert.deepEqual(listing.projects, ["Butler", "Jobs"]);
	});

	it("filters by words, kind, project, outcome and dates", () => {
		const ids = (url: string) =>
			listArchive(
				entries,
				parseArchiveQuery(new URL(url, "http://x")),
			).entries.map((e) => e.id);
		assert.deepEqual(ids("/api/archive?q=sweep"), ["thread-3", "thread-1"]);
		assert.deepEqual(ids("/api/archive?kind=job"), ["thread-2"]);
		assert.deepEqual(ids("/api/archive?project=Jobs"), ["thread-2"]);
		assert.deepEqual(ids("/api/archive?outcome=failed"), ["thread-2"]);
		assert.deepEqual(ids("/api/archive?from=2026-11-06T00:00:00"), [
			"thread-3",
			"thread-2",
		]);
		assert.deepEqual(ids("/api/archive?to=2026-11-05T23:00:00"), ["thread-1"]);
		assert.deepEqual(ids("/api/archive?kind=bogus"), [
			"thread-3",
			"thread-2",
			"thread-1",
		]);
	});
});
