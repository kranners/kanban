import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { handoverPrompt } from "../shared/failover.ts";
import type { Project } from "../shared/projects.ts";
import type {
	Board,
	ButlerCard,
	Note,
	Region,
	Session,
} from "../shared/types.ts";
import { createAnnotationStore } from "./annotations.ts";
import { createArchiveStore } from "./archive.ts";
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
import { createMessageEdgeStore } from "./messageEdges.ts";
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

const setup = async (
	regions: Region[] = [],
	cloud?: CloudOverview,
	projects: Project[] | null = [],
) => {
	const audits: unknown[] = [];
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
	const archive = createArchiveStore({ now: () => clock });
	const edges = createMessageEdgeStore({ now: () => clock });
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
		audit: (entry: unknown) => {
			audits.push(entry);
		},
		file,
		initial: [],
		onChange: () => {},
		comments,
		threads,
		edges,
		...(cloud ? { cloud: () => cloud } : {}),
		projects: () => projects,
		archive,
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
		audits,
		butler,
		board,
		annotations,
		archive,
		regionStore,
		threads,
		edges,
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

	it("keeps Aaron's queued replies to a thread off the snapshot and history too", async () => {
		const { sync, annotations, snapshotOf, butler } = await setup();
		await sync([entry("11111111")]);
		assert.deepEqual(butler.sendToThread("11111111", "private reply words"), {
			ok: true,
		});
		assert.doesNotMatch(JSON.stringify(snapshotOf()), /private reply words/);
		assert.doesNotMatch(
			JSON.stringify(annotations.current()),
			/private reply words/,
		);
		const history = await butler.tool("board_history", {});
		assert.doesNotMatch(JSON.stringify(history), /private reply words/);
		const snapshot = await butler.tool("board_snapshot", {});
		assert.doesNotMatch(JSON.stringify(snapshot), /private reply words/);
	});

	it("keeps when the daemon last saw the thread active, without touching the card's update time", async () => {
		const { sync, annotations, tick } = await setup();
		await sync([entry("11111111", { lastActiveAt: 5000 })]);
		const first = cardOf(annotations, "thread-11111111");
		assert.equal(first?.lastActiveAt, 5000);
		tick(60_000);
		await sync([entry("11111111", { lastActiveAt: 9000 })]);
		const later = cardOf(annotations, "thread-11111111");
		assert.equal(later?.lastActiveAt, 9000);
		assert.equal(later?.updatedAt, first?.updatedAt);
		assert.equal(later?.x, first?.x);
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

	it("archives a finished thread's card 30 minutes after it ended, and keeps it off until the thread is active again", async () => {
		const { sync, annotations, archive, butler, tick } = await setup();
		await sync([entry("11111111")]);
		await sync([entry("11111111", { state: "done", endedAt: 9000 })]);
		const finished = cardOf(annotations, "thread-11111111");
		assert.equal(finished?.finishedAt, 9000);
		assert.equal(finished?.outcome, "done");
		// Inside its grace it stays on the board.
		assert.match((butler.tidy() as { text: string }).text, /0 cards archived/);
		assert.ok(cardOf(annotations, "thread-11111111"));
		tick(31 * 60_000);
		assert.match((butler.tidy() as { text: string }).text, /1 card archived/);
		assert.equal(cardOf(annotations, "thread-11111111"), undefined);
		const kept = archive.get("thread-11111111");
		assert.equal(kept?.kind, "conversation");
		assert.equal(kept?.outcome, "done");
		assert.equal(kept?.finishedAt, 9000);
		assert.equal(kept?.discord, "https://discord.com/channels/1/11111111");
		assert.equal(kept?.reason, "auto");
		// The daemon still lists it: it stays archived.
		await sync([entry("11111111", { state: "done", endedAt: 9000 })]);
		assert.equal(cardOf(annotations, "thread-11111111"), undefined);
		// Active again, it comes back and leaves the archive.
		await sync([entry("11111111", { lastActiveAt: 10_000_000 })]);
		assert.ok(cardOf(annotations, "thread-11111111"));
		assert.equal(archive.get("thread-11111111"), undefined);
	});

	it("never archives a card needing Aaron, working, idle, failed or pinned", async () => {
		const { sync, annotations, archive, butler, tick } = await setup();
		await sync([
			entry("11111101", { state: "needs-you" }),
			entry("11111102", { state: "working" }),
			entry("11111103", { state: "idle" }),
			entry("11111104", { state: "failed" }),
			entry("11111105", { state: "done", endedAt: 100 }),
		]);
		const pinned = cardOf(annotations, "thread-11111105");
		assert.ok(pinned);
		annotations.put({ ...pinned, pinned: true });
		tick(24 * 60 * 60_000);
		butler.tidy();
		for (const id of ["01", "02", "03", "04", "05"]) {
			assert.ok(cardOf(annotations, `thread-111111${id}`), id);
		}
		assert.equal(archive.current().length, 0);
		// Pinned survives a sync.
		await sync([entry("11111105", { state: "done", endedAt: 100 })]);
		assert.equal(cardOf(annotations, "thread-11111105")?.pinned, true);
	});

	it("archives a card at once when it is closed, a failed one as acknowledged", async () => {
		const { sync, annotations, archive, butler } = await setup();
		await sync([
			entry("11111111", { state: "failed" }),
			entry("11111112", { state: "working" }),
		]);
		assert.ok((await butler.tool("close_card", { id: "thread-11111111" })).ok);
		assert.ok(butler.closeThreadCard("thread-11111112").ok);
		assert.equal(archive.get("thread-11111111")?.outcome, "failed");
		assert.equal(archive.get("thread-11111111")?.reason, "closed");
		assert.equal(archive.get("thread-11111112")?.outcome, "superseded");
		assert.equal(cardOf(annotations, "thread-11111111"), undefined);
	});

	it("backfills cards Aaron closed before the archive from the daemon's entries", async () => {
		const { sync, archive, butler } = await setup();
		await sync([entry("11111111", { state: "done", endedAt: 4000 })]);
		// Closed the old way, before this board kept an archive.
		assert.ok(butler.closeThreadCard("thread-11111111").ok);
		archive.remove("thread-11111111");
		await sync([entry("11111111", { state: "done", endedAt: 4000 })]);
		const back = archive.get("thread-11111111");
		assert.equal(back?.reason, "closed");
		assert.equal(back?.title, "Thread 11111111");
		assert.equal(back?.log?.length, 2);
	});

	it("restores an archived card to the board, pinned", async () => {
		const { sync, annotations, archive, butler, tick } = await setup();
		await sync([entry("11111111", { state: "done", endedAt: 9000 })]);
		tick(31 * 60_000);
		butler.tidy();
		assert.equal(cardOf(annotations, "thread-11111111"), undefined);
		assert.ok(butler.restore("thread-11111111").ok);
		assert.equal(cardOf(annotations, "thread-11111111")?.pinned, true);
		assert.equal(archive.get("thread-11111111"), undefined);
		assert.equal(butler.restore("thread-11111111").ok, false);
	});

	it("lays out every card in its project's region, children after their parent, without overlaps", async () => {
		const projects = [
			project("ritual", {
				links: [{ kind: "thread", ref: "11111111", url: null }],
			}),
			project("fox", {
				links: [{ kind: "change", ref: "20261106-141450-402386", url: null }],
			}),
		];
		const { sync, annotations, regionStore, butler } = await setup(
			[],
			undefined,
			projects,
		);
		await sync([
			entry("11111111", { kind: "conversation" }),
			entry("11111112", { kind: "desk", parent: "11111111" }),
			entry("11111113", { kind: "scheduled" }),
			entry("11111114", { state: "needs-you" }),
			entry("11111115", { kind: "dm", createdAt: 40 }),
			entry("11111116", { kind: "desk", parent: "11111115", createdAt: 50 }),
		]);
		assert.ok(
			(
				await butler.tool("changes", {
					fixes: [
						{ id: "20261106-141450-402386", state: "running", title: "Tidy" },
					],
				})
			).ok,
		);
		const outcome = butler.tidy();
		assert.ok(outcome.ok);
		const regions = regionStore.current();
		const named = (name: string) => regions.find((r) => r.name === name);
		const inside = (id: string, name: string) => {
			const card = cardOf(annotations, id);
			const region = named(name);
			assert.ok(card && region, `${id} in ${name}`);
			assert.ok(
				card.x >= region.x &&
					card.y >= region.y &&
					card.x + card.w <= region.x + region.w &&
					card.y + card.h <= region.y + region.h,
				`${id} inside ${name}`,
			);
		};
		inside("thread-11111111", "ritual");
		inside("thread-11111112", "ritual");
		inside("thread-11111113", "Unsorted");
		inside("thread-11111114", "Waiting on you");
		// The DM has no card; a card it started is Unsorted until a project links it.
		assert.equal(cardOf(annotations, "thread-11111115"), undefined);
		inside("thread-11111116", "Unsorted");
		inside("self-fix-20261106-141450-402386", "fox");
		// Waiting on you is the strip across the top.
		const strip = named("Waiting on you");
		assert.ok(strip);
		for (const name of ["ritual", "fox", "Unsorted"]) {
			assert.ok((named(name)?.y ?? 0) > strip.y, name);
		}
		// The child sits right after its parent in the grid.
		const parent = cardOf(annotations, "thread-11111111");
		const child = cardOf(annotations, "thread-11111112");
		assert.ok(parent && child);
		assert.equal(child.y, parent.y);
		assert.ok(child.x > parent.x);
		// A note of Aaron's left inside one of Tidy's regions never pushes them further left.
		const ritual = named("ritual");
		assert.ok(ritual);
		annotations.put({
			id: "aarons",
			kind: "note",
			text: "mine",
			color: "yellow",
			x: ritual.x + 24,
			y: ritual.y + ritual.h - 120,
			w: 96,
			h: 96,
			z: 1,
		} as Note);
		butler.tidy();
		assert.equal(named("ritual")?.x, ritual.x);
		// A second tidy of a tidy board moves nothing.
		assert.match(
			(butler.tidy() as { text: string }).text,
			/0 moved, 0 regions resized/,
		);
	});

	it("lays nothing out until Butler's projects have been read, so a slow read never folds them into Unsorted", async () => {
		const { sync, regionStore, butler } = await setup([], undefined, null);
		await sync([entry("11111111", { kind: "conversation" })]);
		const outcome = butler.tidy();
		assert.ok(outcome.ok);
		assert.match((outcome as { text: string }).text, /not read yet/);
		assert.deepEqual(regionStore.current(), []);
	});

	it("keeps a region Aaron resized as he left it until his own Tidy hands it back", async () => {
		const projects = [
			project("ritual", {
				links: [{ kind: "thread", ref: "11111111", url: null }],
			}),
		];
		const { sync, regionStore, butler } = await setup([], undefined, projects);
		await sync([entry("11111111", { kind: "conversation" })]);
		butler.tidy();
		const region = regionStore.current().find((r) => r.name === "ritual");
		assert.ok(region);
		regionStore.update(region.id, { w: 2400, h: 1200, manual: true });
		butler.tidy();
		assert.equal(
			regionStore.current().find((r) => r.id === region.id)?.w,
			2400,
		);
		butler.tidy({ sessions: true });
		const handed = regionStore.current().find((r) => r.id === region.id);
		assert.notEqual(handed?.w, 2400);
		assert.ok(!handed?.manual);
	});

	it("tidies on its own a little after a burst of syncs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-tidy-"));
		const runs: (() => void)[] = [];
		const annotations = createAnnotationStore({
			file: join(dir, "a.json"),
			initial: {},
			onChange: () => {},
		});
		const butler = createButler({
			source: {
				board: () => ({
					sessions: [],
					subagents: [],
					subagentCounts: {},
					subagentStates: {},
					workflowRuns: {},
					workflows: [],
					links: [],
					messages: [],
					generatedAt: 0,
				}),
				transcript: async () => [],
				transcriptPath: () => null,
			},
			layout: createLayoutStore({
				file: join(dir, "l.json"),
				initial: {},
				onChange: () => {},
			}),
			annotations,
			regions: createRegionStore({
				file: join(dir, "r.json"),
				initial: [],
				onChange: () => {},
			}),
			tools: async () => ({ ok: true, text: "" }),
			audit: () => {},
			file: join(dir, "b.json"),
			initial: [],
			onChange: () => {},
			schedule: (run) => {
				runs.push(run);
			},
		});
		await butler.tool("butler_threads", { threads: [entry("11111111")] });
		await butler.tool("butler_threads", {
			threads: [entry("11111111"), entry("11111112")],
		});
		assert.equal(runs.length, 1);
		runs[0]?.();
		const card = annotations.current()["thread-11111111"];
		assert.ok(card && card.x < 0, "laid out left of the sessions");
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

	it("draws the DM as Butler's face, not a card, and serves its log and replies", async () => {
		const { sync, annotations, butler, threads } = await setup();
		// A DM card from before the face goes, unarchived.
		annotations.put({
			id: "thread-11111111",
			kind: "butler-card",
			title: "Direct messages",
			state: "idle",
			x: 0,
			y: 0,
			w: 240,
			h: 120,
			z: 1,
			updatedAt: 1,
			thread: {
				id: "11111111",
				kind: "dm",
				link: "https://discord.com/channels/@me/11111111",
				private: true,
			},
		} as ButlerCard);
		const text = await sync([
			entry("11111111", {
				kind: "dm",
				title: "Direct messages",
				state: "needs-you",
				status: "Waiting on your yes",
				mood: "pondering",
				approvals: [{ at: 300, headline: "Send it?", code: "ab12" }],
			}),
			entry("22222222", { parent: "11111111" }),
			entry("33333333", { kind: "dm", mood: "sulky" }),
		]);
		assert.match(text, /^3 thread cards: /);
		assert.equal(cardOf(annotations, "thread-11111111"), undefined);
		assert.ok(cardOf(annotations, "thread-22222222"));
		const { dm } = butler.current();
		assert.deepEqual(dm, {
			thread: "11111111",
			state: "needs-you",
			status: "Waiting on your yes",
			link: "https://discord.com/channels/1/11111111",
			waiting: 1,
			updatedAt: 5000,
			mood: "pondering",
		});
		assert.doesNotMatch(JSON.stringify(butler.current()), /secret words/);
		const view = butler.threadView("11111111");
		assert.equal(view?.card.id, "thread-11111111");
		assert.equal(view?.card.thread.kind, "dm");
		assert.equal(view?.events.length, 2);
		assert.equal(view?.approvals[0]?.headline, "Send it?");
		assert.deepEqual(
			view?.children.map((c) => `${c.kind} ${c.id}`),
			["thread 22222222", "session session_abc"],
		);
		assert.deepEqual(butler.sendToThread("11111111", "yes, send"), {
			ok: true,
		});
		const { messages } = JSON.parse(
			(
				(await butler.tool("board_inbox", {})) as {
					text: string;
				}
			).text,
		);
		assert.equal(messages[0].thread, "card-11111111");
		assert.equal(messages[0].target, "11111111");
		assert.ok(
			(
				await butler.tool("board_reply", {
					thread: "card-11111111",
					message: messages[0].id,
					text: "Sent.",
				})
			).ok,
		);
		assert.equal(threads.shown("thread-11111111").events.at(-1)?.text, "Sent.");
		// A mood not on the list is dropped.
		await sync([entry("33333333", { kind: "dm", mood: "sulky" })]);
		assert.equal(butler.current().dm?.mood, undefined);
		// Once the daemon lists no DM, the face goes.
		await sync([entry("22222222")]);
		assert.equal(butler.current().dm, undefined);
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

	it("shows a thread's mission and machines, dropping what is not one, and keeps them off the snapshot", async () => {
		const { sync, annotations, snapshotOf } = await setup();
		await sync([
			entry("11111111", {
				mission: { id: "m87245d", covers: "mac on\npiggys-MBP  for 24 hours" },
				machines: ["piggys-MBP", "browser", "bad host!", "piggys-MBP"],
			}),
			entry("22222222", { mission: { id: "has space", covers: "x" } }),
		]);
		const card = cardOf(annotations, "thread-11111111");
		assert.deepEqual(card?.mission, {
			id: "m87245d",
			covers: "mac on piggys-MBP for 24 hours",
		});
		assert.deepEqual(card?.machines, ["piggys-MBP", "browser"]);
		const other = cardOf(annotations, "thread-22222222");
		assert.ok(other);
		assert.equal(other.mission, undefined);
		assert.equal(other.machines, undefined);
		assert.doesNotMatch(JSON.stringify(snapshotOf()), /24 hours/);

		// The mission ending changes the card.
		const text = await sync([
			entry("11111111", { machines: ["piggys-MBP", "browser"] }),
			entry("22222222"),
		]);
		assert.match(text, /^2 thread cards: 1 updated, 0 removed\n/);
		assert.equal(cardOf(annotations, "thread-11111111")?.mission, undefined);
	});

	it("shows a thread's subagents, dropping a list that is not one, and updates on subagents alone", async () => {
		const { sync, annotations, snapshotOf } = await setup();
		const subagent = (id: string, state: string, parent?: string) => ({
			id,
			description: `Look into ${id}`,
			type: "general-purpose",
			state,
			...(parent ? { parent } : {}),
			startedAt: 100,
			updatedAt: 200,
		});
		await sync([
			entry("11111111", {
				desk: { id: "1105-3", task: "Drive upload", state: "working" },
				subagents: [
					subagent("toolu_a", "working"),
					subagent("toolu_b", "idle", "toolu_a"),
				],
			}),
			entry("22222222", {
				subagents: [{ ...subagent("toolu_c", "working"), state: "lost" }],
			}),
			entry("33333333", { subagents: [] }),
		]);
		assert.deepEqual(cardOf(annotations, "thread-11111111")?.subagents, [
			subagent("toolu_a", "working"),
			subagent("toolu_b", "idle", "toolu_a"),
		]);
		const invalid = cardOf(annotations, "thread-22222222");
		assert.ok(invalid);
		assert.equal(invalid.subagents, undefined);
		assert.equal(cardOf(annotations, "thread-33333333")?.subagents, undefined);
		assert.doesNotMatch(JSON.stringify(snapshotOf()), /Look into/);

		const text = await sync([
			entry("11111111", {
				desk: { id: "1105-3", task: "Drive upload", state: "working" },
				subagents: [
					subagent("toolu_a", "done"),
					subagent("toolu_b", "done", "toolu_a"),
				],
			}),
			entry("22222222", {
				subagents: [{ ...subagent("toolu_c", "working"), state: "lost" }],
			}),
			entry("33333333", { subagents: [] }),
		]);
		assert.match(text, /^3 thread cards: 1 updated, 0 removed\n/);
		assert.deepEqual(
			cardOf(annotations, "thread-11111111")?.subagents?.map((s) => s.state),
			["done", "done"],
		);
	});

	it("marks a thread whose question may be stale until a sync drops it", async () => {
		const { sync, annotations } = await setup();
		await sync([
			entry("11111111", {
				state: "idle",
				status: "This question may be stale: Butler will check",
				stale: true,
			}),
			entry("22222222", { stale: "yes" }),
		]);
		const card = cardOf(annotations, "thread-11111111");
		assert.ok(card);
		assert.equal(card.stale, true);
		assert.equal(card.state, "idle");
		assert.equal(cardOf(annotations, "thread-22222222")?.stale, undefined);

		await sync([entry("11111111", { state: "idle" }), entry("22222222")]);
		assert.equal(cardOf(annotations, "thread-11111111")?.stale, undefined);
	});
});

describe("Closed and dropped thread cards", () => {
	it("keeps a closed card closed through a sync that lists nothing, and in the archive after", async () => {
		const { sync, annotations, archive, butler, tick } = await setup();
		await sync([entry("11111111")]);
		const closed = await butler.tool("close_card", { id: "thread-11111111" });
		assert.ok(closed.ok);
		await sync([]);
		await sync([entry("11111111")]);
		assert.equal(cardOf(annotations, "thread-11111111"), undefined);
		tick(3 * 24 * 60 * 60_000);
		await sync([]);
		await sync([entry("11111111")]);
		assert.equal(
			cardOf(annotations, "thread-11111111"),
			undefined,
			"the archive keeps it off once its closing is forgotten",
		);
		assert.equal(archive.get("thread-11111111")?.reason, "closed");
	});

	it("still hands spike Aaron's reply when the card drops off the board", async () => {
		const { sync, butler, threads } = await setup();
		await sync([entry("11111111")]);
		assert.deepEqual(butler.sendToThread("11111111", "go ahead"), { ok: true });
		await sync([]);
		assert.equal(threads.shown("thread-11111111").events.length, 0);
		const inbox = await butler.tool("board_inbox", {});
		assert.ok(inbox.ok);
		const { messages } = JSON.parse(inbox.text) as {
			messages: { thread: string; target?: string; text: string }[];
		};
		assert.deepEqual(
			messages.map(({ thread, target, text }) => ({ thread, target, text })),
			[{ thread: "card-11111111", target: "11111111", text: "go ahead" }],
		);
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

describe("Approving Butler's requests from the board", () => {
	const NONCE = "0123456789abcdef0123456789abcdef";
	const safeCard =
		"**Goal:** Tidy\n### ⚪ Needs your approval\nNo critical permissions\n### Limits\n- 24 hours";
	const critCard =
		"**Goal:** Pay\n### 🔴 Needs your approval\n- `$` **Make payments**\n-# dentist\n### Limits\n- 24 hours";
	const waiting = (code: string, extra: Record<string, unknown> = {}) => ({
		at: 300,
		headline: `Request ${code}`,
		code,
		kind: "desk",
		nonce: NONCE,
		...extra,
	});
	const presses = async (
		butler: Awaited<ReturnType<typeof setup>>["butler"],
	) => {
		const inbox = await butler.tool("board_inbox", {});
		assert.ok(inbox.ok);
		return (
			JSON.parse(inbox.text) as {
				messages: {
					id: string;
					target?: string;
					approval?: Record<string, unknown>;
				}[];
			}
		).messages.filter((m) => m.approval);
	};

	it("never shows the page a request's nonce, only that it is answerable", async () => {
		const { butler, sync } = await setup();
		await sync([
			entry("11111111", {
				state: "needs-you",
				approvals: [waiting("abcde", { body: safeCard })],
			}),
		]);
		const view = butler.threadView("11111111");
		assert.equal(view?.approvals[0]?.nonce, undefined);
		assert.equal(view?.approvals[0]?.answerable, true);
		const [listed] = butler.approvalsWaiting();
		assert.equal(listed?.approval.nonce, undefined);
		assert.equal(listed?.approval.body, safeCard);
		assert.equal(
			JSON.stringify(butler.approvalsWaiting()).includes(NONCE),
			false,
		);
	});

	it("queues a press for spike with the nonce only the board holds, once", async () => {
		const { butler, sync } = await setup();
		await sync([
			entry("11111111", { state: "needs-you", approvals: [waiting("abcde")] }),
		]);
		const first = butler.answerApproval("11111111", "abcde", "approve", {
			device: "ipad",
		});
		assert.ok("ok" in first);
		const again = butler.answerApproval("11111111", "abcde", "approve", {});
		assert.ok("error" in again);
		assert.equal(again.status, 409);
		assert.match(again.error, /^Already approved from the board on ipad at /);
		const [press] = await presses(butler);
		assert.equal(press?.target, "11111111");
		assert.deepEqual(press?.approval, {
			code: "abcde",
			nonce: NONCE,
			decision: "approve",
			device: "ipad",
		});
		// Acked by spike, it leaves the queue.
		await butler.tool("board_ack", { ids: [press?.id] });
		assert.equal((await presses(butler)).length, 0);
	});

	it("needs the hold to approve anything critical", async () => {
		const { butler, sync } = await setup();
		await sync([
			entry("11111111", {
				state: "needs-you",
				approvals: [waiting("paydn", { body: critCard, critical: true })],
			}),
		]);
		const tapped = butler.answerApproval("11111111", "paydn", "approve", {});
		assert.ok("error" in tapped);
		assert.equal(tapped.status, 400);
		assert.equal((await presses(butler)).length, 0);
		const held = butler.answerApproval("11111111", "paydn", "approve", {
			held: true,
		});
		assert.ok("ok" in held);
		assert.equal((await presses(butler))[0]?.approval?.held, true);
	});

	it("approves every request, critical ones included, at once and lists what it left", async () => {
		const { butler, sync } = await setup();
		await sync([
			entry("11111111", {
				state: "needs-you",
				approvals: [
					waiting("safee", { body: safeCard }),
					waiting("paydn", { body: critCard, critical: true }),
					waiting("plain", { kind: "call" }),
					{ at: 1, headline: "No buttons", code: "nonce" },
				],
			}),
		]);
		const { approved, left } = butler.approveAll("ipad");
		assert.deepEqual(
			approved.map((w) => w.approval.code),
			["safee", "paydn", "plain"],
		);
		assert.deepEqual(
			left.map((w) => [w.approval.code, w.why]),
			[["nonce", "answer it in Discord"]],
		);
		const queued = await presses(butler);
		assert.deepEqual(
			queued.map((m) => m.approval?.code),
			["safee", "paydn", "plain"],
		);
		assert.ok(queued.every((m) => m.approval?.bulk === true));
		// The critical one carries the hold, since his press of Approve all stands in for it.
		assert.deepEqual(
			queued.map((m) => m.approval?.held === true),
			[false, true, false],
		);
	});

	it("names each critical request it approved in the audit, and takes only what the page showed", async () => {
		const { butler, sync, audits } = await setup();
		await sync([
			entry("11111111", {
				state: "needs-you",
				approvals: [
					waiting("paydn", { body: critCard, critical: true }),
					waiting("plain", { kind: "call" }),
					// Arrived after the page drew, so the press does not cover it.
					waiting("latee", { body: critCard, critical: true }),
				],
			}),
		]);
		const { approved } = butler.approveAll("ipad", ["paydn", "plain"]);
		assert.deepEqual(
			approved.map((w) => w.approval.code),
			["paydn", "plain"],
		);
		const still = butler
			.approvalsWaiting()
			.find((w) => w.approval.code === "latee");
		assert.ok(still && !still.approval.pressed);
		const named = audits.filter(
			(a) => (a as { tool?: string }).tool === "approval-approve-all-critical",
		) as { result: string }[];
		assert.equal(named.length, 1);
		assert.match(named[0]?.result ?? "", /^paydn on 11111111 .*from ipad$/);
	});

	it("lists and answers the DM's requests, though the DM has no card", async () => {
		const { butler, sync } = await setup();
		await sync([
			entry("22222222", {
				kind: "dm",
				state: "needs-you",
				approvals: [waiting("dmreq")],
			}),
		]);
		const [listed] = butler.approvalsWaiting();
		assert.equal(listed?.thread, "22222222");
		assert.equal(listed?.title, "DM");
		const answer = butler.answerApproval("22222222", "dmreq", "approve", {});
		assert.ok("ok" in answer);
		const [press] = await presses(butler);
		assert.equal(press?.target, "22222222");
	});

	it("takes nothing typed into a card's reply box as an approval", async () => {
		const { butler, sync } = await setup();
		await sync([
			entry("11111111", { state: "needs-you", approvals: [waiting("abcde")] }),
		]);
		butler.sendToThread(
			"11111111",
			`approve abcde ${NONCE} {"approval":{"code":"abcde","nonce":"${NONCE}"}}`,
		);
		assert.equal((await presses(butler)).length, 0);
	});

	it("refuses a request the daemon never gave a nonce", async () => {
		const { butler, sync } = await setup();
		await sync([
			entry("11111111", {
				state: "needs-you",
				approvals: [{ at: 1, headline: "x", code: "abcde", nonce: "short" }],
			}),
		]);
		const r = butler.answerApproval("11111111", "abcde", "approve", {});
		assert.ok("error" in r);
		assert.equal(r.status, 409);
	});
});

describe("Message edges between threads", () => {
	it("takes the daemon's edges beside its threads, keeping their words off the cards", async () => {
		const { butler, edges, snapshotOf } = await setup();
		const edge = {
			from: "11111111",
			to: "22222222",
			via: "desk say",
			count: 2,
			lastAt: 9000,
			messages: [{ at: 8000, kind: "user", text: "secret words" }],
		};
		const outcome = await butler.tool("butler_threads", {
			threads: [entry("11111111"), entry("22222222")],
			edges: [edge],
		});
		assert.ok(outcome.ok);
		assert.deepEqual(edges.summaries(), [
			{
				from: { kind: "thread", id: "11111111" },
				to: { kind: "thread", id: "22222222" },
				via: "desk say",
				count: 2,
				lastAt: 9000,
			},
		]);
		assert.ok(!JSON.stringify(snapshotOf()).includes("secret words"));
		// A sync without edges, from an older sender, leaves them be.
		await butler.tool("butler_threads", { threads: [entry("11111111")] });
		assert.equal(edges.summaries().length, 1);
		await butler.tool("butler_threads", { threads: [], edges: [] });
		assert.deepEqual(edges.summaries(), []);
	});

	it("refuses edges that are not a list", async () => {
		const { butler } = await setup();
		const outcome = await butler.tool("butler_threads", {
			threads: [],
			edges: "all of them",
		});
		assert.equal(outcome.ok, false);
	});
});
