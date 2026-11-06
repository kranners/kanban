import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { handoverPrompt } from "../shared/failover.ts";
import type {
	Board,
	ButlerCard,
	Note,
	Region,
	Session,
} from "../shared/types.ts";
import { createAnnotationStore } from "./annotations.ts";
import { snapshot } from "./boardTools.ts";
import {
	type CloudOverview,
	createButler,
	loadButlerState,
	orphanReport,
} from "./butler.ts";
import { createThreadLogStore, loadThreadLogs } from "./butlerThreads.ts";
import { createColourStore } from "./colours.ts";
import { createCommentStore } from "./comments.ts";
import { createLayoutStore } from "./layout.ts";
import { createRegionStore } from "./regions.ts";

const session = (id: string, parent?: string): Session => ({
	id,
	short: null,
	pid: null,
	name: `cloud-${id.slice(-3)}`,
	cwd: "/tmp",
	project: "tmp",
	kind: "background",
	activity: "working",
	doing: null,
	needs: null,
	goal: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: false,
	cmux: false,
	artifacts: [],
	tasks: [],
	steps: [],
	cloud: { url: `https://claude.ai/code/${id}` },
	...(parent
		? { parent: { thread: parent, title: "Parent", card: `thread-${parent}` } }
		: {}),
});

const setup = async (regions: Region[] = [], cloud?: CloudOverview) => {
	const dir = await mkdtemp(join(tmpdir(), "kanban-threads-"));
	const board: Board = {
		sessions: [session("session_abc", "11111111")],
		subagents: [],
		subagentCounts: {},
		subagentStates: {},
		workflowRuns: {},
		workflows: [],
		links: [],
		messages: [],
		generatedAt: 0,
	};
	const layout = createLayoutStore({
		file: join(dir, "l.json"),
		initial: {},
		onChange: () => {},
	});
	const annotations = createAnnotationStore({
		file: join(dir, "a.json"),
		initial: {},
		onChange: () => {},
	});
	const regionStore = createRegionStore({
		file: join(dir, "r.json"),
		initial: regions,
		onChange: () => {},
	});
	const comments = createCommentStore({
		file: join(dir, "c.json"),
		initial: [],
		onChange: () => {},
		onRemove: () => {},
	});
	const logsFile = join(dir, "butler-threads.json");
	const threads = createThreadLogStore({ file: logsFile });
	let clock = 10_000;
	let ids = 0;
	const file = join(dir, "butler.json");
	const butler = createButler({
		source: {
			board: () => board,
			transcript: async () => [],
			transcriptPath: () => null,
		},
		layout,
		annotations,
		regions: regionStore,
		tools: async (_thread, call) => ({ ok: true, text: `ran ${call.tool}` }),
		audit: () => {},
		file,
		initial: [],
		onChange: () => {},
		comments,
		threads,
		...(cloud ? { cloud: () => cloud } : {}),
		newId: () => `id${++ids}`,
		now: () => clock,
	});
	const colours = createColourStore({
		file: join(dir, "colours.json"),
		initial: {},
		onChange: () => {},
	});
	const sync = async (entries: unknown[]) => {
		const outcome = await butler.tool("butler_threads", { threads: entries });
		assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
		return outcome.text;
	};
	return {
		butler,
		board,
		annotations,
		threads,
		logsFile,
		file,
		dir,
		sync,
		snapshotOf: () =>
			snapshot(
				board,
				{ layout, annotations, colours, regions: regionStore },
				null,
			),
		tick: (ms: number) => {
			clock += ms;
		},
	};
};

const entry = (
	id: string,
	fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
	id,
	title: `Thread ${id}`,
	kind: "conversation",
	state: "working",
	status: "Searching mail",
	link: `https://discord.com/channels/1/${id}`,
	createdAt: Number(id.slice(-3)),
	lastActiveAt: 5000,
	private: true,
	events: [
		{ at: 100, kind: "user", text: "secret words from Aaron" },
		{ at: 200, kind: "tool", text: "mail search" },
	],
	approvals: [],
	...fields,
});

const cardOf = (
	annotations: { current(): Record<string, unknown> },
	id: string,
) => annotations.current()[id] as ButlerCard | undefined;

describe("Butler's thread cards", () => {
	it("makes one card per thread, keeping its events off the board", async () => {
		const { sync, annotations, threads, snapshotOf, butler } = await setup();
		const text = await sync([
			entry("11111111", { boardThread: "board-thread-1" }),
			{ id: "nope" },
			entry("22222222", { link: "https://evil.example/x" }),
		]);
		assert.match(text, /^1 thread card: 1 updated, 0 removed\n/);
		const card = cardOf(annotations, "thread-11111111");
		assert.ok(card);
		assert.equal(card.title, "Thread 11111111");
		assert.equal(card.status, "Searching mail");
		assert.equal(card.link, "https://discord.com/channels/1/11111111");
		assert.deepEqual(card.thread, {
			id: "11111111",
			kind: "conversation",
			link: "https://discord.com/channels/1/11111111",
			private: true,
		});
		assert.equal(card.boardThread, "board-thread-1");
		assert.equal(cardOf(annotations, "thread-22222222"), undefined);
		assert.equal(threads.shown("thread-11111111").events.length, 2);

		const shot = JSON.stringify(snapshotOf());
		assert.doesNotMatch(shot, /secret words/);
		const listed = snapshotOf().butlerCards.find(
			(c) => c.id === "thread-11111111",
		);
		assert.deepEqual(listed?.thread, {
			id: "11111111",
			kind: "conversation",
			link: "https://discord.com/channels/1/11111111",
		});
		assert.doesNotMatch(JSON.stringify(annotations.current()), /secret words/);
		const history = await butler.tool("board_history", {});
		assert.doesNotMatch(JSON.stringify(history), /secret words/);
	});

	it("puts a new card beside its parent, else in Butler's region, and keeps where it was moved", async () => {
		const butlerRegion: Region = {
			id: "r1",
			cwd: "/srv/butler",
			name: "Butler",
			x: 2400,
			y: 2400,
			w: 1200,
			h: 800,
		};
		const { sync, annotations } = await setup([butlerRegion]);
		await sync([entry("11111111")]);
		const parent = cardOf(annotations, "thread-11111111");
		assert.ok(parent);
		assert.equal(parent.x, 2424);
		assert.equal(parent.y, 2448);
		await sync([entry("11111111"), entry("22222222", { parent: "11111111" })]);
		const child = cardOf(annotations, "thread-22222222");
		assert.equal(child?.parent, "thread-11111111");
		assert.ok(child && child.x >= parent.x + parent.w, "to its parent's right");
		assert.equal(child?.y, parent.y);

		annotations.put({ ...parent, x: 96, y: 96 });
		await sync([
			entry("11111111", { status: "Replied" }),
			entry("22222222", { parent: "11111111" }),
		]);
		const moved = cardOf(annotations, "thread-11111111");
		assert.equal(moved?.x, 96);
		assert.equal(moved?.status, "Replied");
	});

	it("moves a card into the Done region once its thread ends, only then", async () => {
		const doneRegion: Region = {
			id: "r2",
			cwd: "/srv/done",
			name: "done",
			x: -4800,
			y: 0,
			w: 1200,
			h: 1200,
		};
		const { sync, annotations } = await setup([doneRegion]);
		await sync([entry("11111111")]);
		const working = cardOf(annotations, "thread-11111111");
		assert.ok(working && working.x > doneRegion.x + doneRegion.w);
		await sync([entry("11111111", { state: "done", endedAt: 6000 })]);
		const finished = cardOf(annotations, "thread-11111111");
		assert.equal(finished?.x, -4776);
		assert.equal(finished?.y, 48);
		assert.ok(finished);
		annotations.put({ ...finished, x: 960, y: 960 });
		await sync([
			entry("11111111", { state: "done", status: "Archived", endedAt: 6000 }),
		]);
		assert.equal(cardOf(annotations, "thread-11111111")?.x, 960);
	});

	it("takes a card off, with its notes and log, once the daemon stops listing its thread", async () => {
		const { sync, annotations, threads, butler } = await setup();
		await sync([entry("11111111")]);
		const noted = await butler.tool("note", {
			target: "thread-11111111",
			text: "Looking into it",
		});
		assert.ok(noted.ok);
		annotations.put({
			id: "mine",
			kind: "note",
			text: "Aaron's",
			color: "yellow",
			x: 0,
			y: 0,
			w: 120,
			h: 120,
			z: 1,
		} as Note);
		const text = await sync([]);
		assert.match(text, /^0 thread cards: 0 updated, 1 removed\n/);
		assert.equal(cardOf(annotations, "thread-11111111"), undefined);
		assert.equal(
			Object.values(annotations.current()).filter(
				(a) => a.kind === "note" && a.author === "butler",
			).length,
			0,
		);
		assert.ok(annotations.current().mine, "Aaron's own note stays");
		assert.equal(threads.get("thread-11111111"), undefined);
	});

	it("keeps a closed card closed until its thread is active again", async () => {
		const { sync, annotations, butler, tick, file } = await setup();
		await sync([entry("11111111")]);
		tick(1000);
		const closed = await butler.tool("close_card", { id: "thread-11111111" });
		assert.ok(closed.ok);
		await butler.saved();
		const saved = await loadButlerState(file);
		assert.deepEqual(saved.initialDismissedThreads, { "11111111": 11_000 });
		await sync([entry("11111111", { lastActiveAt: 11_000 })]);
		assert.equal(cardOf(annotations, "thread-11111111"), undefined);
		await sync([entry("11111111", { lastActiveAt: 12_000 })]);
		assert.ok(cardOf(annotations, "thread-11111111"));

		// Aaron deleting it from the page closes it the same way.
		tick(2000);
		const deleted = butler.closeThreadCard("thread-11111111");
		assert.ok(deleted.ok);
		await sync([entry("11111111", { lastActiveAt: 12_000 })]);
		assert.equal(cardOf(annotations, "thread-11111111"), undefined);
	});

	it("refuses to make or rewrite a thread card with put_card", async () => {
		const { sync, butler, annotations } = await setup();
		const made = await butler.tool("put_card", {
			id: "thread-33333333",
			title: "Fake",
		});
		assert.equal(made.ok, false);
		await sync([entry("11111111")]);
		const renamed = await butler.tool("put_card", {
			id: "thread-11111111",
			title: "Renamed",
		});
		assert.equal(renamed.ok, false);
		const moved = await butler.tool("put_card", {
			id: "thread-11111111",
			x: 480,
			y: 480,
		});
		assert.ok(moved.ok);
		assert.equal(
			cardOf(annotations, "thread-11111111")?.title,
			"Thread 11111111",
		);
	});

	it("links a change card to the thread that started it, beside its card", async () => {
		const { sync, butler, annotations } = await setup();
		await sync([entry("11111111")]);
		const parent = cardOf(annotations, "thread-11111111");
		assert.ok(parent);
		const fixes = await butler.tool("changes", {
			fixes: [
				{
					id: "20261106-114814-3087181",
					state: "running",
					title: "Thread cards",
					thread: "11111111",
				},
			],
		});
		assert.ok(fixes.ok);
		const change = cardOf(annotations, "self-fix-20261106-114814-3087181");
		assert.equal(change?.parent, "thread-11111111");
		assert.ok(change && change.x >= parent.x + parent.w);
		assert.equal(change?.y, parent.y);
		// The thread sync never removes change cards, nor the other way round.
		await butler.tool("changes", { fixes: [] });
		assert.ok(cardOf(annotations, "thread-11111111"));

		const view = butler.threadView("11111111");
		assert.deepEqual(
			view?.children.map((c) => `${c.kind} ${c.id}`),
			["session session_abc"],
		);
	});

	it("lists a thread's children: changes, threads and sessions it started", async () => {
		const { sync, butler } = await setup();
		await sync([entry("11111111"), entry("22222222", { parent: "11111111" })]);
		await butler.tool("changes", {
			fixes: [
				{
					id: "20261106-114814-3087181",
					state: "running",
					thread: "11111111",
				},
			],
		});
		const view = butler.threadView("11111111");
		assert.deepEqual(view?.children.map((c) => `${c.kind} ${c.id}`).sort(), [
			"change 20261106-114814-3087181",
			"session session_abc",
			"thread 22222222",
		]);
		assert.equal(butler.threadView("99999999"), null);
	});

	it("keeps Aaron's replies until the daemon reports them, and keeps logs across restarts", async () => {
		const { sync, butler, threads, logsFile } = await setup();
		await sync([entry("11111111")]);
		assert.deepEqual(butler.sendToThread("11111111", "pay it"), { ok: true });
		assert.equal(
			threads.shown("thread-11111111").events.at(-1)?.text,
			"pay it",
		);
		await sync([entry("11111111")]);
		assert.equal(
			threads.shown("thread-11111111").events.at(-1)?.text,
			"pay it",
			"the daemon has not seen it yet",
		);
		await sync([
			entry("11111111", {
				events: [
					{ at: 100, kind: "user", text: "secret words from Aaron" },
					{ at: 20_000, kind: "user", text: "pay it" },
				],
			}),
		]);
		assert.deepEqual(
			threads.shown("thread-11111111").events.map((e) => e.text),
			["secret words from Aaron", "pay it"],
		);
		await threads.saved();
		const loaded = await loadThreadLogs(logsFile);
		assert.equal(loaded["thread-11111111"]?.events.length, 2);
		const written = await readFile(logsFile, "utf8");
		assert.match(written, /pay it/);
	});
});

describe("The orphan report", () => {
	it("counts the board's cloud sessions by whether a Butler thread asked for them", async () => {
		const cloud: CloudOverview = {
			records: [
				{ prompt: "do it", parent: { thread: "11111111" } },
				{ prompt: "Context pack: board\n\nfix the thing" },
				{ prompt: "Context from Butler: x" },
				{
					prompt: handoverPrompt(
						{ name: "old", goal: null, doing: null },
						null,
						[],
					),
				},
				{ prompt: "started by hand" },
				{},
			],
			reachable: true,
		};
		const { sync } = await setup([], cloud);
		const text = await sync([]);
		assert.equal(
			text.split("\n")[1],
			"Cloud sessions on the board: 6; linked to a Butler thread: 1; unlinked: 5 (Butler start_session without a parent: 2, failover handover: 1, started on the board: 2); cloud API: reachable",
		);
		assert.match(
			orphanReport({ records: [], reachable: false }),
			/cloud API: unreachable$/,
		);
		assert.match(orphanReport(undefined), /cloud API: unknown$/);
	});
});
