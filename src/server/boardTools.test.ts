import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PromptReply } from "../shared/conversation.ts";
import type { Board, Session } from "../shared/types.ts";
import { noteSizeFor } from "../web/notes.ts";
import { arrange, near, seedsOf, sessionSize } from "../web/placement.ts";
import { createAnnotationStore } from "./annotations.ts";
import type { AuditEvent } from "./audit.ts";
import { createBoardTools } from "./boardTools.ts";
import { createColourStore } from "./colours.ts";
import { createCommentStore } from "./comments.ts";
import { createLayoutStore } from "./layout.ts";
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
	const exits: [string, boolean, string | null][] = [];
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
	let ids = 0;
	const tools = createBoardTools({
		source: {
			board: () => shown,
			transcript: async () => [
				{ at: 0, role: "assistant", text: "Fixed the bug" },
			],
			transcriptPath: () => null,
		},
		layout,
		annotations,
		colours,
		regions,
		comments,
		launch: async () => ({ ok: true, short: "feedbeef" }),
		exit: (s, force, identity) => {
			exits.push([s.id, force, identity]);
			return Promise.resolve({
				ok: true,
				exited: false,
				reason: "Uncommitted work",
			});
		},
		ask: async () => ({ ok: true, answer: "12" }),
		prompt: async () => ({ ok: true, via: "claude attach" }),
		answer: async (s, reply) => {
			answered.push([s.id, reply]);
			return reply
				? { ok: true, value: `Answered ${s.name}'s prompt` }
				: { ok: false, error: `${s.name} is not waiting on a question` };
		},
		audit: (event) => events.push(event),
		newId: () => `n-${++ids}`,
	});
	return {
		tools,
		layout,
		annotations,
		regions,
		colours,
		events,
		exits,
		answered,
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
		});
		layout.observe({
			...board,
			sessions: [session("feedbeef-3", { short: "feedbeef" })],
		});
		const spot = layout.current()["session:feedbeef-3"];
		assert.ok(spot);
		assert.ok(!near({ ...spot, ...sessionSize }, note, 0));
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
		assert.deepEqual(exits, [["bbbbbbbb-2", false, "board-agent"]]);
		assert.equal(events.at(-1)?.action, "board-agent");
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
		});
		const pane = session("a", { kind: "interactive", cmux: true });
		assert.equal((await send(pane, "/exit")).ok, false);
		assert.equal((await send(session("aaaaaaaa"), "!rm -rf ~")).ok, false);
		assert.equal((await send(pane, "Run the tests")).ok, true);
		assert.deepEqual(pasted, ["Run the tests"]);
	});
});
