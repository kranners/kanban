import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PromptReply } from "../shared/conversation.ts";
import type { Board, NewSessionRequest, Session } from "../shared/types.ts";
import { noteSizeFor } from "../web/notes.ts";
import { arrange, near, seedsOf, sessionSize } from "../web/placement.ts";
import { createAnnotationStore } from "./annotations.ts";
import type { AuditEvent } from "./audit.ts";
import {
	createBoardTools,
	createPromptApprover,
	type OpenPrompt,
} from "./boardTools.ts";
import { localRemovalNote } from "./cloud.ts";
import { createColourStore } from "./colours.ts";
import { createCommentStore } from "./comments.ts";
import { TranscriptUnreadable } from "./ingest/tail.ts";
import { createLayoutStore } from "./layout.ts";
import type { EdgeRecord } from "./messageEdges.ts";
import {
	blockedReason,
	createPromptSender,
	unsafeTextReason,
} from "./prompts.ts";
import { createRegionStore } from "./regions.ts";

const session = (id: string, extra: Partial<Session> = {}): Session => ({
	id,
	short: `${id.slice(0, 7)}0`,
	pid: 1,
	name: `acme-${id.slice(0, 3)}`,
	cwd: "/tmp",
	project: "tmp",
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
	...extra,
});

const board: Board = {
	sessions: [session("aaaaaaaa-1"), session("bbbbbbbb-2")],
	subagents: [],
	subagentCounts: {},
	subagentStates: {},
	workflowRuns: {},
	workflows: [],
	links: [],
	messages: [],
	generatedAt: 0,
};

const setup = async (shown: Board = board) => {
	const dir = await mkdtemp(join(tmpdir(), "kanban-tools-"));
	const events: AuditEvent[] = [];
	const exits: [string, boolean, string | null, string?][] = [];
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
	const regions = createRegionStore({
		file: join(dir, "r.json"),
		initial: [],
		onChange: () => {},
		newId: () => "r-1",
	});
	const colours = createColourStore({
		file: join(dir, "c.json"),
		initial: {},
		onChange: () => {},
	});
	const comments = createCommentStore({
		file: join(dir, "m.json"),
		initial: [],
		onChange: () => {},
		onRemove: () => {},
	});
	const answered: [string, PromptReply | null][] = [];
	const prompts = new Map<string, OpenPrompt[]>();
	const approvals: [string, string][] = [];
	let ids = 0;
	const launched: NewSessionRequest[] = [];
	const recorded: EdgeRecord[] = [];
	const tools = createBoardTools({
		source: {
			board: () => shown,
			transcript: async (id) => {
				if (id === "eeeeeeee-5") {
					throw new TranscriptUnreadable("Cannot create a string longer", [
						{ at: 0, role: "assistant", text: "Got this far" },
					]);
				}
				return [{ at: 0, role: "assistant", text: "Fixed the bug" }];
			},
			transcriptPath: () => null,
		},
		layout,
		annotations,
		colours,
		regions,
		comments,
		launch: async (request) => {
			launched.push(request);
			return request.runsOn === "cloud"
				? { ok: true, id: "session_01cloud" }
				: { ok: true, short: "feedbeef" };
		},
		exit: (s, force, identity, ownerMessage) => {
			exits.push(
				ownerMessage
					? [s.id, force, identity, ownerMessage]
					: [s.id, force, identity],
			);
			if (s.cloud) {
				return Promise.resolve({
					ok: true,
					exited: true,
					note: localRemovalNote("Cloud API unreachable: offline"),
				});
			}
			return Promise.resolve(
				force
					? { ok: true, exited: true }
					: { ok: true, exited: false, reason: "Uncommitted work" },
			);
		},
		limited: (s) => s.doing?.startsWith("You've hit") ?? false,
		ask: async () => ({ ok: true, answer: "12" }),
		prompt: async () => ({ ok: true, via: "claude attach" }),
		announce: async (text) =>
			text === "nobody"
				? { ok: false, error: "There are no live sessions to announce to" }
				: {
						ok: true,
						deliveries: [
							{ id: "aaaaaaaa-1", name: "acme-aaa", ok: true, error: null },
							{
								id: "bbbbbbbb-2",
								name: "acme-bbb",
								ok: false,
								error: "Waiting on a prompt",
							},
						],
					},
		answer: async (s, reply) => {
			answered.push([s.id, reply]);
			return reply
				? { ok: true, value: `Answered ${s.name}'s prompt` }
				: { ok: false, error: `${s.name} is not waiting on a question` };
		},
		approver: {
			open: async (s) =>
				s.id === "dddddddd-4"
					? { ok: false, error: "The session cannot be driven from here" }
					: { ok: true, value: prompts.get(s.id) ?? [] },
			approve: async (s, prompt) => {
				if (prompt.requestId === "fails") {
					return { ok: false, error: "That prompt is no longer open" };
				}
				approvals.push([s.id, prompt.requestId]);
				prompts.set(
					s.id,
					(prompts.get(s.id) ?? []).filter(
						(open) => open.requestId !== prompt.requestId,
					),
				);
				return { ok: true, value: null };
			},
		},
		audit: (event) => events.push(event),
		edges: { record: (entry) => recorded.push(entry) },
		history: async (since) => `history since ${new Date(since).toISOString()}`,
		now: () => Date.UTC(2026, 10, 1),
		newId: () => `n-${++ids}`,
	});
	return {
		tools,
		recorded,
		layout,
		annotations,
		regions,
		colours,
		comments,
		events,
		exits,
		answered,
		prompts,
		approvals,
		launched,
	};
};

describe("board tools", () => {
	it("snapshots sessions with their cards", async () => {
		const { tools, events } = await setup();
		const result = await tools("t", { tool: "board_snapshot" });
		assert.ok(result.ok);
		const [summary, json] = result.text.split("\n");
		assert.equal(summary, "Board: 2 sessions, 0 regions, 0 notes, 0 stickers");
		const view = JSON.parse(json ?? "");
		assert.equal(view.sessions[0].card.w, 312);
		assert.equal(view.gridSize, 24);
		assert.deepEqual(events, [], "reads are not audited");
	});

	it("reads history from a day ago by default, without auditing", async () => {
		const { tools, events } = await setup();
		assert.deepEqual(await tools("t", { tool: "board_history", since: null }), {
			ok: true,
			text: "history since 2026-10-31T00:00:00.000Z",
		});
		const since = Date.UTC(2026, 9, 31, 21);
		assert.deepEqual(await tools("t", { tool: "board_history", since }), {
			ok: true,
			text: "history since 2026-10-31T21:00:00.000Z",
		});
		assert.deepEqual(events, []);
	});

	it("tells a button's thread it has no place on the board", async () => {
		const { tools, comments } = await setup();
		const thisComment = async (id: string) => {
			const result = await tools(id, { tool: "board_snapshot" });
			assert.ok(result.ok);
			return JSON.parse(result.text.split("\n")[1] ?? "{}").thisComment;
		};
		const pin = comments.create({ x: 30, y: 40, text: "pin" });
		assert.ok(pin);
		assert.deepEqual(await thisComment(pin.id), { x: 30, y: 40 });
		assert.equal(await thisComment("butler"), null);
	});

	it("moves cards by id or short id, pinned and snapped, all or nothing", async () => {
		const { tools, layout, events } = await setup();
		assert.deepEqual(
			await tools("t", {
				tool: "arrange",
				cards: [
					{ id: "aaaaaaa0", x: 50, y: 0 },
					{ id: "nope", x: 0, y: 0 },
				],
				regions: [],
				annotations: [],
			}),
			{ ok: false, error: "No card nope on the board" },
		);
		assert.deepEqual(layout.current(), {});
		const moved = await tools("t", {
			tool: "arrange",
			cards: [
				{ id: "aaaaaaa0", x: 50, y: 0 },
				{ id: "bbbbbbbb-2", x: 400, y: 0, w: 480 },
			],
			regions: [],
			annotations: [],
		});
		assert.deepEqual(moved, { ok: true, text: "Moved 2 cards" });
		assert.deepEqual(layout.current(), {
			"session:aaaaaaaa-1": { x: 48, y: 0, pinned: true },
			"session:bbbbbbbb-2": { x: 408, y: 0, pinned: true, w: 480, h: 240 },
		});
		assert.deepEqual(events.at(-1), {
			action: "board-agent",
			thread: "t",
			tool: "arrange",
			target: null,
			input: null,
			result: "Moved 2 cards",
		});
	});

	it("writes and edits markdown notes and validates stickers", async () => {
		const { tools, annotations } = await setup();
		const created = await tools("t", {
			tool: "put_note",
			text: "## Report\n- done",
			x: 0,
			y: 0,
			w: 384,
		});
		assert.deepEqual(created, {
			ok: true,
			text: `Created note '## Report' (id n-1) at ${annotations.current()["n-1"]?.x},${annotations.current()["n-1"]?.y}`,
		});
		assert.equal(annotations.current()["n-1"]?.w, 384);
		await tools("t", { tool: "put_note", id: "n-1", color: "blue" });
		const note = annotations.current()["n-1"];
		assert.equal(note?.kind === "note" && note.color, "blue");
		assert.equal(note?.kind === "note" && note.text, "## Report\n- done");
		const report = "## Report\n\n- line\n".repeat(40);
		await tools("t", { tool: "put_note", text: report, x: 0, y: 0 });
		const sized = annotations.current()["n-2"];
		assert.deepEqual(sized && { w: sized.w, h: sized.h }, noteSizeFor(report));
		assert.deepEqual(
			await tools("t", {
				tool: "put_sticker",
				sticker: "not-a-sticker",
				x: 0,
				y: 0,
			}),
			{
				ok: false,
				error: "sticker must be one of the board's stickers",
			},
		);
		assert.deepEqual(
			await tools("t", { tool: "put_note", id: "missing", text: "x" }),
			{ ok: false, error: "No note missing" },
		);
	});

	it("puts new notes and stickers clear of cards and each other, but moves edits as asked", async () => {
		const { tools, annotations } = await setup();
		await tools("t", { tool: "put_note", text: "one", x: 0, y: 0 });
		await tools("t", { tool: "put_note", text: "two", x: 0, y: 0 });
		await tools("t", { tool: "put_sticker", sticker: "rocket", x: 0, y: 0 });
		const cards = [
			...arrange(board, {}, seedsOf(board), new Map()).nodes.values(),
		];
		const added = Object.values(annotations.current());
		assert.equal(added.length, 3);
		for (const a of added) {
			for (const other of [...cards, ...added]) {
				if (other !== a)
					assert.ok(!near(a, other, 0), `${a.id} covers something`);
			}
		}
		await tools("t", { tool: "put_note", id: "n-1", x: 0, y: 0 });
		const moved = annotations.current()["n-1"];
		assert.deepEqual([moved?.x, moved?.y], [0, 0]);
	});

	it("starts an agent's session clear of a note at the spot it asked for", async () => {
		const { tools, annotations, layout } = await setup();
		await tools("t", { tool: "put_note", text: "here", x: 2400, y: 2400 });
		const note = annotations.current()["n-1"];
		assert.ok(note);
		await tools("t", {
			tool: "start_session",
			cwd: "/tmp",
			prompt: "go",
			x: note.x,
			y: note.y,
			runsOn: "local",
		});
		layout.observe({
			...board,
			sessions: [session("feedbeef-3", { short: "feedbeef" })],
		});
		const spot = layout.current()["session:feedbeef-3"];
		assert.ok(spot);
		assert.ok(!near({ ...spot, ...sessionSize }, note, 0));
	});

	it("starts a cloud session unless asked for this Mac and names it in the reply", async () => {
		const { tools, events } = await setup();
		const cwd = tmpdir();
		assert.deepEqual(
			await tools("t", {
				tool: "start_session",
				cwd,
				prompt: "go",
			}),
			{
				ok: true,
				text: `Started a session in ${cwd} (cloud session session_01cloud)`,
			},
		);
		assert.deepEqual(
			await tools("t", {
				tool: "start_session",
				cwd,
				prompt: "go",
				runsOn: "local",
			}),
			{ ok: true, text: `Started a session in ${cwd} (short id feedbeef)` },
		);
		assert.deepEqual(
			events.flatMap((event) =>
				event.action === "session-create" ? [[event.runsOn, event.result]] : [],
			),
			[
				["cloud", "session_01cloud"],
				["local", "feedbeef"],
			],
		);
	});

	it("starts a session a Butler thread asked for beside that thread's card, keeping its parent", async () => {
		const { tools, annotations, launched } = await setup();
		annotations.put({
			id: "thread-11111111",
			kind: "butler-card",
			title: "Dentist",
			state: "working",
			x: 4800,
			y: 2400,
			w: 312,
			h: 216,
			z: 1,
			updatedAt: 0,
			thread: {
				id: "11111111",
				kind: "conversation",
				link: "https://discord.com/channels/1/11111111",
				private: false,
			},
		});
		const cwd = tmpdir();
		const started = await tools("t", {
			tool: "start_session",
			cwd,
			prompt: "go",
			parent: { thread: "11111111", title: "Dentist", desk: "1106-2" },
		});
		assert.ok(started.ok);
		const request = launched.at(-1);
		assert.deepEqual(request?.parent, {
			thread: "11111111",
			title: "Dentist",
			desk: "1106-2",
		});
		assert.deepEqual(request?.at, { x: 5160, y: 2400 });
		// A parent with no card yet leaves the session where the board puts it.
		await tools("t", {
			tool: "start_session",
			cwd,
			prompt: "go",
			parent: { thread: "22222222" },
		});
		assert.equal(launched.at(-1)?.at, undefined);
		assert.deepEqual(launched.at(-1)?.parent, { thread: "22222222" });
	});

	it("draws regions with a colour and finishes sessions without forcing", async () => {
		const { tools, regions, colours, exits, events } = await setup();
		const region = await tools("t", {
			tool: "create_region",
			cwd: "/tmp",
			name: "Scratch",
			colour: "teal",
			x: 0,
			y: 0,
			w: 480,
			h: 336,
		});
		assert.ok(region.ok);
		assert.equal(regions.current()[0]?.name, "Scratch");
		assert.equal(Object.values(colours.current())[0], "teal");
		const finished = await tools("t", {
			tool: "finish_session",
			session: "bbbbbbb0",
		});
		assert.deepEqual(finished, {
			ok: true,
			text: "acme-bbb is not ready to finish: Uncommitted work",
		});
		assert.deepEqual(exits, [["bbbbbbbb-2", false, "butler"]]);
		assert.equal(events.at(-1)?.action, "board-agent");
	});

	it("finishes a rate-limited session or a duplicate without asking it, and nothing else", async () => {
		const limited = session("cccccccc-3", {
			doing: "You've hit your weekly limit · resets Nov 6 at 10pm",
		});
		const { tools, exits } = await setup({
			...board,
			sessions: [
				...board.sessions,
				limited,
				session("dddddddd-4", { cwd: "/elsewhere" }),
			],
		});
		assert.deepEqual(
			await tools("t", {
				tool: "finish_session",
				session: "aaaaaaa0",
				force: true,
			}),
			{
				ok: false,
				error:
					"acme-aaa isn't stopped on a usage limit, so it is asked before it finishes; finish it without force",
			},
		);
		await tools("t", {
			tool: "finish_session",
			session: "ccccccc0",
			force: true,
		});
		await tools("t", {
			tool: "finish_session",
			session: "bbbbbbb0",
			duplicateOf: "aaaaaaa0",
		});
		const elsewhere = await tools("t", {
			tool: "finish_session",
			session: "ddddddd0",
			duplicateOf: "aaaaaaa0",
		});
		assert.equal(elsewhere.ok, false);
		assert.deepEqual(exits, [
			["cccccccc-3", true, "butler"],
			["bbbbbbbb-2", true, "butler"],
		]);
	});

	it("force-finishes any session that is not busy on Aaron's message", async () => {
		const { tools, exits } = await setup({
			...board,
			sessions: [
				session("aaaaaaaa-1", { activity: "needs-you" }),
				session("bbbbbbbb-2", { activity: "working" }),
				session("cccccccc-3", { activity: "watching" }),
				session("dddddddd-4", { activity: "done" }),
			],
		});
		const force = (ref: string) =>
			tools("t", {
				tool: "finish_session",
				session: ref,
				force: true,
				ownerMessage: "1234567890123456789",
			});
		assert.deepEqual(await force("aaaaaaa0"), {
			ok: true,
			text: "Force-finished acme-aaa on Aaron's message 1234567890123456789",
		});
		assert.ok((await force("ddddddd0")).ok);
		assert.deepEqual(await force("bbbbbbb0"), {
			ok: false,
			error:
				"acme-bbb is working right now, so it cannot be force-finished; wait until it stops",
		});
		assert.equal((await force("ccccccc0")).ok, false);
		assert.deepEqual(exits, [
			["aaaaaaaa-1", true, "butler", "1234567890123456789"],
			["dddddddd-4", true, "butler", "1234567890123456789"],
		]);
	});

	it("says when a cloud session only left the board, forced or not", async () => {
		const cloud = (id: string, activity: Session["activity"]) =>
			session(id, {
				short: null,
				pid: null,
				activity,
				cloud: { url: `https://claude.ai/code/${id}` },
			});
		const { tools, exits } = await setup({
			...board,
			sessions: [
				cloud("session_01idle", "idle"),
				cloud("session_02done", "done"),
			],
		});
		const note =
			"removed from the board only: the cloud session was not ended on claude.ai (Cloud API unreachable: offline)";
		assert.deepEqual(
			await tools("t", { tool: "finish_session", session: "session_01idle" }),
			{ ok: true, text: `Removed acme-ses: ${note}` },
		);
		assert.deepEqual(
			await tools("t", {
				tool: "finish_session",
				session: "session_02done",
				force: true,
				ownerMessage: "1234567890123456789",
			}),
			{ ok: true, text: `Removed acme-ses: ${note}` },
		);
		assert.deepEqual(exits, [
			["session_01idle", false, "butler"],
			["session_02done", true, "butler", "1234567890123456789"],
		]);
	});

	it("reads what it can of a transcript too large to read whole", async () => {
		const { tools } = await setup({
			...board,
			sessions: [...board.sessions, session("eeeeeeee-5")],
		});
		const read = await tools("t", {
			tool: "read_transcript",
			session: "eeeeeee0",
			limit: 40,
		});
		assert.ok(read.ok);
		assert.match(read.text, /^acme-eee's transcript could not be read whole/);
		assert.match(read.text, /Read 1 entry from acme-eee\n.*Got this far/);
	});

	it("draws a new region clear of the projects already on the board", async () => {
		const { tools, regions } = await setup();
		const draft = { tool: "create_region", cwd: "/tmp", x: 0, y: 0 } as const;
		await tools("t", { ...draft, w: 480, h: 336 });
		const second = await tools("t", { ...draft, w: 240, h: 240 });
		const [first, placed] = regions.current();
		assert.ok(first && placed);
		assert.deepEqual(second, {
			ok: true,
			text: `Created region '${placed.cwd}' (id r-1) at ${placed.x},${placed.y}`,
		});
		const snapshot = await tools("t", { tool: "board_snapshot" });
		assert.ok(snapshot.ok);
		const view = JSON.parse(snapshot.text.split("\n")[1] ?? "{}");
		const frame = view.regions[0].frame;
		assert.ok(!near(placed, frame, 24));
	});

	it("draws a region over its own directory's sessions where asked", async () => {
		const cwd = await realpath("/tmp");
		const { tools, regions, layout } = await setup({
			...board,
			sessions: board.sessions.map((s) => ({ ...s, cwd })),
		});
		layout.setMany([
			{ key: "session:aaaaaaaa-1", placement: { x: 0, y: 0, pinned: true } },
			{ key: "session:bbbbbbbb-2", placement: { x: 336, y: 0, pinned: true } },
		]);
		const created = await tools("t", {
			tool: "create_region",
			cwd: "/tmp",
			x: -48,
			y: -48,
			w: 768,
			h: 384,
		});
		assert.ok(created.ok);
		assert.deepEqual(
			{ x: regions.current()[0]?.x, y: regions.current()[0]?.y },
			{ x: -48, y: -48 },
		);
	});

	it("answers a session's prompt by its short id and audits the answers", async () => {
		const { tools, events, answered } = await setup();
		const reply = {
			prompt: "0123abcd4567",
			answers: [{ selected: ["Yes, test then full"], other: null }],
		};
		assert.deepEqual(
			await tools("t", { tool: "answer_prompt", session: "aaaaaaa0", reply }),
			{ ok: true, text: "Answered acme-aaa's prompt" },
		);
		assert.deepEqual(
			await tools("t", {
				tool: "answer_prompt",
				session: "bbbbbbbb-2",
				reply: null,
			}),
			{ ok: false, error: "acme-bbb is not waiting on a question" },
		);
		assert.deepEqual(answered, [
			["aaaaaaaa-1", reply],
			["bbbbbbbb-2", null],
		]);
		assert.deepEqual(
			events.map((event) =>
				event.action === "board-agent" ? event.input : null,
			),
			[JSON.stringify(reply), "null"],
		);
	});

	it("approves a session's safe prompts and leaves the rest for Aaron", async () => {
		const shown: Board = {
			...board,
			sessions: [
				session("aaaaaaaa-1", {
					cloud: { url: "https://claude.ai/code/session_01acme" },
					activity: "needs-you",
				}),
				session("bbbbbbbb-2", {
					activity: "needs-you",
					cwd: "/Users/me/dev/acme-api",
				}),
				session("cccccccc-3", { activity: "idle" }),
				session("dddddddd-4", { activity: "needs-you" }),
			],
		};
		const { tools, prompts, approvals, events } = await setup(shown);
		prompts.set("aaaaaaaa-1", [
			{
				requestId: "r-title",
				toolName: "mcp__claude-code-remote__set_session_title",
				title: "Set session title",
				input: { title: "Fix it" },
			},
			{
				requestId: "r-push",
				toolName: "Bash",
				title: "Bash",
				input: { command: "git push origin main" },
			},
			{
				requestId: "fails",
				toolName: "Read",
				title: "Read",
				input: { file_path: "/tmp/x" },
			},
		]);
		const answered = await tools("t", {
			tool: "answer_prompt",
			session: "aaaaaaa0",
			reply: null,
			allowSafe: true,
		});
		assert.deepEqual(answered, {
			ok: true,
			text: [
				"Approved 1, left 2 for Aaron",
				"acme-aaa: approved Set session title (mcp__claude-code-remote__set_session_title, request r-title)",
				"acme-aaa: left for Aaron Bash (Bash, request r-push): pushes to main (git push origin main)",
				"acme-aaa: left for Aaron Read (Read, request fails): approving failed: That prompt is no longer open",
			].join("\n"),
		});
		assert.deepEqual(approvals, [["aaaaaaaa-1", "r-title"]]);
		assert.deepEqual(
			events.filter((event) => event.action === "prompt-approve"),
			[
				{
					action: "prompt-approve",
					sessionId: "aaaaaaaa-1",
					tool: "mcp__claude-code-remote__set_session_title",
					requestId: "r-title",
					via: "safe set",
					identity: "butler",
					result: "ok",
				},
				{
					action: "prompt-approve",
					sessionId: "aaaaaaaa-1",
					tool: "Read",
					requestId: "fails",
					via: "safe set",
					identity: "butler",
					result: "That prompt is no longer open",
				},
			],
		);
		assert.deepEqual(
			events.flatMap((event) =>
				event.action === "board-agent" ? [event.input] : [],
			),
			["allow_safe"],
		);

		prompts.set("bbbbbbbb-2", [
			{
				requestId: "p-edit",
				toolName: "Edit",
				title: "Edit",
				input: { file_path: "/Users/me/dev/acme-api/src/a.ts" },
			},
		]);
		prompts.set("cccccccc-3", [
			{
				requestId: "p-idle",
				toolName: "Read",
				title: "Read",
				input: { file_path: "src/a.ts" },
			},
		]);
		const all = await tools("t", {
			tool: "approve_safe_prompts",
			sessions: null,
		});
		assert.deepEqual(all, {
			ok: true,
			text: [
				"acme-aaa: left for Aaron Bash (Bash, request r-push): pushes to main (git push origin main)",
				"acme-aaa: left for Aaron Read (Read, request fails): approving failed: That prompt is no longer open",
				"acme-bbb: approved Edit (Edit, request p-edit)",
				"acme-ddd: could not read its prompts: The session cannot be driven from here",
				"Approved 1, left 2 for Aaron",
			].join("\n"),
		});
		assert.deepEqual(approvals.at(-1), ["bbbbbbbb-2", "p-edit"]);
		assert.deepEqual(
			await tools("t", {
				tool: "approve_safe_prompts",
				sessions: ["cccccccc-3", "zzzz"],
			}),
			{
				ok: true,
				text: [
					"zzzz: no session zzzz on the board",
					"acme-ccc: approved Read (Read, request p-idle)",
					"Approved 1, left 0 for Aaron",
				].join("\n"),
			},
		);
		assert.deepEqual(
			await tools("t", {
				tool: "answer_prompt",
				session: "bbbbbbbb-2",
				reply: null,
				allowSafe: true,
			}),
			{
				ok: true,
				text: "Approved 0, left 0 for Aaron\nacme-bbb: no open permission prompt",
			},
		);
	});

	it("approves through claude.ai for cloud sessions and the terminal's Yes for others", async () => {
		const sent: [string, string][] = [];
		const replies: [string, PromptReply | null][] = [];
		const approver = createPromptApprover({
			cloud: {
				prompts: (id) => [
					{
						requestId: `req-${id}`,
						toolName: "Read",
						title: "Read",
						input: { file_path: "src/a.ts" },
					},
				],
				approveSafe: async (id, requestId) => {
					sent.push([id, requestId]);
					return { ok: true, value: null };
				},
			},
			terminal: {
				waiting: async () => ({ ok: true, value: [] }),
				respond: async (s, reply) => {
					replies.push([s.id, reply]);
					return { ok: true, value: "Answered" };
				},
			},
		});
		const cloudSession = session("aaaaaaaa-1", {
			cloud: { url: "https://claude.ai/code/session_01acme" },
		});
		const local = session("bbbbbbbb-2");
		assert.deepEqual(await approver.open(cloudSession), {
			ok: true,
			value: [
				{
					requestId: "req-aaaaaaaa-1",
					toolName: "Read",
					title: "Read",
					input: { file_path: "src/a.ts" },
				},
			],
		});
		assert.deepEqual(await approver.open(local), { ok: true, value: [] });
		const prompt = {
			requestId: "abc123",
			toolName: "Read",
			title: "Read",
			input: { file_path: "src/a.ts" },
		};
		assert.deepEqual(await approver.approve(cloudSession, prompt), {
			ok: true,
			value: null,
		});
		assert.deepEqual(await approver.approve(local, prompt), {
			ok: true,
			value: null,
		});
		assert.deepEqual(sent, [["aaaaaaaa-1", "abc123"]]);
		assert.deepEqual(replies, [
			[
				"bbbbbbbb-2",
				{ prompt: "abc123", answers: [{ selected: ["Yes"], other: null }] },
			],
		]);
	});

	it("announces to every session and lists the ones it missed", async () => {
		const { tools, events } = await setup();
		assert.deepEqual(
			await tools("t", { tool: "announce", text: "Pull main" }),
			{
				ok: true,
				text: "Announced to 1 of 2 sessions\n- acme-bbb: Waiting on a prompt",
			},
		);
		assert.deepEqual(await tools("t", { tool: "announce", text: "nobody" }), {
			ok: false,
			error: "There are no live sessions to announce to",
		});
		const audited = events.flatMap((event) =>
			event.action === "board-agent" ? [[event.tool, event.input]] : [],
		);
		assert.deepEqual(audited, [
			["announce", "Pull main"],
			["announce", "nobody"],
		]);
	});

	it("records what the agent typed, asked or started in the audit log", async () => {
		const { tools, events } = await setup();
		await tools("t", {
			tool: "send_prompt",
			session: "aaaaaaa0",
			text: "Run the tests",
		});
		await tools("t", {
			tool: "ask_session",
			session: "aaaaaaa0",
			question: "What changed?",
		});
		assert.deepEqual(
			events.map((event) =>
				event.action === "board-agent" ? [event.tool, event.input] : null,
			),
			[
				["send_prompt", "Run the tests"],
				["ask_session", "What changed?"],
			],
		);
	});
});

describe("message edges", () => {
	it("records a Butler thread's prompts and starts, and audits the thread they came from", async () => {
		const { tools, recorded, events } = await setup();
		await tools("t", {
			tool: "send_prompt",
			session: "aaaaaaa0",
			text: "Run the tests",
			parent: { thread: "11111111" },
		});
		await tools("t", {
			tool: "send_prompt",
			session: "aaaaaaa0",
			text: "no thread",
		});
		await tools("t", {
			tool: "start_session",
			cwd: tmpdir(),
			prompt: "go",
			runsOn: "cloud",
			parent: { thread: "11111111" },
		});
		const at = Date.UTC(2026, 10, 1);
		const from = { kind: "thread", id: "11111111" };
		assert.deepEqual(recorded, [
			{
				from,
				to: { kind: "session", id: "aaaaaaaa-1" },
				via: "prompt",
				text: "Run the tests",
				at,
			},
			{
				from,
				to: { kind: "session", id: "session_01cloud" },
				via: "start",
				text: "go",
				at,
			},
		]);
		assert.deepEqual(
			events.flatMap((e) =>
				e.action === "board-agent" ? [e.parent ?? null] : [],
			),
			["11111111", null, "11111111"],
		);
	});
});

describe("prompt safety", () => {
	it("never types into a prompt waiting on the user, an attached session, or an unreachable one", () => {
		assert.match(
			blockedReason(session("a", { activity: "needs-you" }), []) ?? "",
			/question or permission prompt.*answer_prompt/,
		);
		assert.match(
			blockedReason(session("aaaaaaaa"), ["aaaaaaa0"]) ?? "",
			/open on the board/,
		);
		assert.match(
			blockedReason(session("a", { kind: "interactive", cmux: false }), []) ??
				"",
			/not in a cmux pane/,
		);
		assert.equal(
			blockedReason(session("a", { kind: "interactive", cmux: true }), []),
			null,
		);
		assert.equal(blockedReason(session("aaaaaaaa"), []), null);
		assert.equal(
			blockedReason(
				session("session_01a", {
					short: null,
					attachable: false,
					cloud: { url: "https://claude.ai/code/session_01a" },
				}),
				[],
			),
			null,
		);
		assert.equal(
			blockedReason(
				session("session_01a", {
					activity: "needs-you",
					cloud: { url: "https://claude.ai/code/session_01a" },
				}),
				[],
			),
			null,
		);
	});

	it("sends a cloud session's prompt through the cloud api", async () => {
		const sent: [string, string][] = [];
		const send = createPromptSender({
			spawnPty: () => assert.fail("attached to a session"),
			attached: () => [],
			cmux: {} as never,
			resolve: async () => assert.fail("resolved a cmux pane"),
			cloudSend: async (id, text) => {
				sent.push([id, text]);
				return { ok: true, value: null };
			},
		});
		const cloud = session("session_01a", {
			short: null,
			attachable: false,
			cloud: { url: "https://claude.ai/code/session_01a" },
		});
		assert.deepEqual(await send(cloud, "Run the tests"), {
			ok: true,
			via: "cloud api",
		});
		assert.equal((await send(cloud, "/exit")).ok, false);
		assert.deepEqual(sent, [["session_01a", "Run the tests"]]);
	});

	it("refuses text the session would run as a command or that escapes the paste", () => {
		for (const text of [
			"!touch /tmp/x",
			"  /exit",
			"# remember this",
			"hi\x1b[201~\r!touch /tmp/x\r",
			"one\rtwo",
		]) {
			assert.ok(unsafeTextReason(text), JSON.stringify(text));
		}
		assert.equal(unsafeTextReason("Run the tests\n\tthen /exit"), null);
	});

	it("never pastes command text into a session", async () => {
		const pasted: string[] = [];
		const send = createPromptSender({
			spawnPty: () => assert.fail("attached to a session"),
			attached: () => [],
			cmux: {
				paste: async (_target: unknown, text: string) => {
					pasted.push(text);
					return { ok: true, value: null };
				},
			} as never,
			resolve: async () => ({ ok: true, value: {} as never }),
			cloudSend: async () => assert.fail("sent to the cloud"),
		});
		const pane = session("a", { kind: "interactive", cmux: true });
		assert.equal((await send(pane, "/exit")).ok, false);
		assert.equal((await send(session("aaaaaaaa"), "!rm -rf ~")).ok, false);
		assert.equal((await send(pane, "Run the tests")).ok, true);
		assert.deepEqual(pasted, ["Run the tests"]);
	});
});
