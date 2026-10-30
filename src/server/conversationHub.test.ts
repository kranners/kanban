import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type {
	AskAnswer,
	AskQuestion,
	ConversationServerFrame,
} from "../shared/conversation.ts";
import type { Session } from "../shared/types.ts";
import type { AttachSocket } from "./attach.ts";
import type { AuditEvent } from "./audit.ts";
import { cloudTty } from "./cloud.ts";
import { applyConversationRecord, createLog } from "./conversation.ts";
import {
	createConversationHub,
	describeDialog,
	dialogOf,
	driveOf,
	parseConversationFrame,
	parseSince,
	promptId,
	promptRefusal,
} from "./conversationHub.ts";
import { type FakeTui, fakeTui } from "./fakeTui.ts";
import type { SessionTty } from "./terminals.ts";

const dir = mkdtempSync(join(tmpdir(), "kanban-hub-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const session = (changes: Partial<Session> = {}): Session => ({
	id: "11111111-2222-3333-4444-555555555555",
	short: null,
	pid: 202,
	name: "demo",
	cwd: "/work/demo",
	project: "demo",
	kind: "interactive",
	activity: "idle",
	doing: null,
	needs: null,
	goal: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: false,
	cmux: true,
	artifacts: [],
	tasks: [],
	steps: [],
	...changes,
});

const line = (record: object) =>
	`${JSON.stringify({ timestamp: "2026-10-24T10:00:00.000Z", ...record })}\n`;

const prompt = (text: string) =>
	line({ type: "user", message: { content: text } });

type FakeSocket = AttachSocket & {
	frames: ConversationServerFrame[];
	receive(frame: unknown): void;
	hangUp(): void;
};

const fakeSocket = (): FakeSocket => {
	const listeners: Record<string, ((data?: unknown) => void)[]> = {};
	const socket: FakeSocket = {
		readyState: 1,
		frames: [],
		send(data) {
			socket.frames.push(JSON.parse(String(data)));
		},
		close() {},
		on(event: string, listener: (data?: unknown) => void) {
			listeners[event] = [...(listeners[event] ?? []), listener];
			return socket;
		},
		receive(frame) {
			for (const listener of listeners.message ?? [])
				listener(JSON.stringify(frame));
		},
		hangUp() {
			for (const listener of listeners.close ?? []) listener();
		},
	};
	return socket;
};

const until = async (check: () => boolean, ms = 2000) => {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

type FakeTty = SessionTty & {
	sent: string[];
	keysSent: string[];
	shows: string;
	opened: number;
};

const fakeTty = (): FakeTty => {
	const tty = {
		sent: [] as string[],
		keysSent: [] as string[],
		shows: "❯ \n  ⏵⏵ accept edits on",
		opened: 0,
		screen: async () => ({ ok: true as const, value: tty.shows }),
		keys: async (keys: string[]) => {
			tty.keysSent.push(...keys);
			return { ok: true as const, value: null };
		},
		paste: async () => ({ ok: true as const, value: null }),
		send: async (text: string) => {
			tty.sent.push(text);
			return { ok: true as const, value: null };
		},
		isOpen: () => false,
		close() {},
	};
	return tty as FakeTty;
};

const hub = (
	current: () => Session,
	tty = fakeTty(),
	windowSize = 3,
	transcriptPath: () => string | null = () => null,
	block: () => Record<string, unknown> | null = () => null,
) => {
	const events: AuditEvent[] = [];
	return {
		events,
		tty,
		hub: createConversationHub({
			session: () => current(),
			tty: () => {
				tty.opened += 1;
				return tty;
			},
			transcriptPath,
			block,
			audit: (event) => events.push(event),
			pollMs: 5,
			screenMs: 0,
			windowSize,
		}),
	};
};

const itemFrames = (socket: FakeSocket) =>
	socket.frames.filter(
		(frame): frame is Extract<ConversationServerFrame, { type: "items" }> =>
			frame.type === "items",
	);

describe("conversation stream", () => {
	it("sends recent history, then appends, then pages older items", async () => {
		const path = join(dir, "stream.jsonl");
		writeFileSync(path, ["a", "b", "c", "d", "e"].map(prompt).join(""));
		const { hub: conversations } = hub(() => session());
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: session(), path },
			null,
			"me",
		);
		const [history] = itemFrames(socket);
		assert.equal(history?.reset, true);
		assert.equal(history?.total, 5);
		assert.equal(history?.first, 2);
		assert.deepEqual(
			history?.items.map((item) => item.kind === "user" && item.text),
			["c", "d", "e"],
		);
		appendFileSync(path, prompt("f"));
		await until(() => itemFrames(socket).length === 2);
		const appended = itemFrames(socket)[1];
		assert.equal(appended?.reset, false);
		assert.deepEqual(
			appended?.items.map((item) => item.index),
			[5],
		);
		socket.receive({ type: "more", before: 2 });
		const older = socket.frames.find((frame) => frame.type === "older");
		assert.deepEqual(
			older?.type === "older" && older.items.map((item) => item.index),
			[0, 1],
		);
		await until(() => socket.frames.some((frame) => frame.type === "mode"));
		assert.deepEqual(
			socket.frames.find((frame) => frame.type === "mode"),
			{ type: "mode", mode: "accept edits" },
		);
		socket.hangUp();
	});

	it("resumes a reconnect from the revision it last saw", async () => {
		const path = join(dir, "resume.jsonl");
		writeFileSync(path, ["a", "b"].map(prompt).join(""));
		const { hub: conversations } = hub(() => session());
		const first = fakeSocket();
		const target = { kind: "session" as const, session: session(), path };
		conversations.open(first, target, null, null);
		const seen = itemFrames(first)[0];
		const second = fakeSocket();
		conversations.open(
			second,
			target,
			{ epoch: seen?.epoch ?? "", rev: seen?.rev ?? 0 },
			null,
		);
		assert.deepEqual(itemFrames(second)[0]?.items, []);
		assert.equal(itemFrames(second)[0]?.reset, false);
		first.hangUp();
		second.hangUp();
		const stale = fakeSocket();
		conversations.open(stale, target, { epoch: "other", rev: 1 }, null);
		assert.equal(itemFrames(stale)[0]?.reset, true);
		assert.equal(itemFrames(stale)[0]?.items.length, 2);
		stale.hangUp();
	});

	it("types prompts and keys into a drivable session and audits them without the text", async () => {
		const path = join(dir, "drive.jsonl");
		writeFileSync(path, prompt("a"));
		const { hub: conversations, tty, events } = hub(() => session());
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: session(), path },
			null,
			"me",
		);
		socket.receive({ type: "prompt", id: "p1", text: "/compact keep tests" });
		socket.receive({ type: "key", id: "k1", key: "Shift+Tab" });
		socket.receive({ type: "prompt", id: "p2", text: "bad\u0007" });
		await until(
			() => socket.frames.filter((frame) => frame.type === "done").length === 3,
		);
		assert.deepEqual(
			socket.frames.flatMap((frame) =>
				frame.type === "done" ? [[frame.id, frame.ok, frame.error]] : [],
			),
			[
				["p1", true, null],
				["k1", true, null],
				["p2", false, "A prompt cannot contain control characters"],
			],
		);
		assert.deepEqual(tty.sent, ["/compact keep tests"]);
		assert.deepEqual(tty.keysSent, ["Shift+Tab"]);
		const sends = events.filter((event) => event.action === "view-send");
		assert.equal(sends.length, 3);
		assert.ok(!JSON.stringify(events).includes("keep tests"));
		socket.hangUp();
	});

	it("sends a cloud session's prompts through its api and refuses keys", async () => {
		const path = join(dir, "cloud.jsonl");
		writeFileSync(path, prompt("a"));
		const sent: [string, string][] = [];
		const cloud = session({
			id: "session_01cloud",
			activity: "working",
			kind: "background",
			short: null,
			cmux: false,
			attachable: false,
			cloud: { url: "https://claude.ai/code/session_01cloud" },
		});
		const tty = {
			...fakeTty(),
			...cloudTty(
				{
					send: async (id, text) => {
						sent.push([id, text]);
						return { ok: true, value: null };
					},
				},
				cloud.id,
			),
		};
		const { hub: conversations } = hub(() => cloud, tty);
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: cloud, path },
			null,
			"me",
		);
		await until(() => socket.frames.some((frame) => frame.type === "drive"));
		assert.deepEqual(
			socket.frames.find((frame) => frame.type === "drive"),
			{ type: "drive", drive: { mode: "drive", via: "cloud" } },
		);
		socket.receive({ type: "prompt", id: "p1", text: "Run the tests" });
		socket.receive({ type: "key", id: "k1", key: "Escape" });
		await until(
			() => socket.frames.filter((frame) => frame.type === "done").length === 2,
		);
		assert.deepEqual(
			socket.frames.flatMap((frame) =>
				frame.type === "done" ? [[frame.id, frame.ok, frame.error]] : [],
			),
			[
				["p1", true, null],
				[
					"k1",
					false,
					"Open this cloud session's terminal view on the board, or open it on claude.ai, to answer prompts or switch mode",
				],
			],
		);
		assert.deepEqual(sent, [["session_01cloud", "Run the tests"]]);
		socket.hangUp();
	});

	it("refuses prompts and keys while the session waits on a prompt", async () => {
		const path = join(dir, "waiting.jsonl");
		writeFileSync(
			path,
			prompt("a") +
				line({
					type: "assistant",
					message: {
						id: "m1",
						content: [
							{
								type: "tool_use",
								id: "b1",
								name: "Bash",
								input: { command: "ls" },
							},
						],
					},
				}),
		);
		const waiting = session({ activity: "needs-you" });
		const { hub: conversations, tty } = hub(() => waiting);
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: waiting, path },
			null,
			null,
		);
		socket.receive({ type: "prompt", id: "p1", text: "hello" });
		socket.receive({ type: "key", id: "k1", key: "Escape" });
		await until(
			() => socket.frames.filter((frame) => frame.type === "done").length === 2,
		);
		assert.ok(
			socket.frames.every((frame) => frame.type !== "done" || !frame.ok),
		);
		assert.deepEqual(tty.sent, []);
		assert.deepEqual(tty.keysSent, []);
		socket.hangUp();
	});

	it("takes prompts from a background session that is blocked only on its next instruction", async () => {
		const path = join(dir, "blocked.jsonl");
		writeFileSync(path, prompt("a"));
		const blocked = session({ activity: "needs-you" });
		const { hub: conversations, tty } = hub(() => blocked);
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: blocked, path },
			null,
			null,
		);
		socket.receive({ type: "prompt", id: "p1", text: "carry on" });
		await until(() => socket.frames.some((frame) => frame.type === "done"));
		assert.deepEqual(tty.sent, ["carry on"]);
		socket.hangUp();
	});

	it("keeps subagents and sessions outside cmux read-only", async () => {
		const path = join(dir, "read.jsonl");
		writeFileSync(path, prompt("a"));
		const outside = session({ cmux: false });
		const { hub: conversations, tty } = hub(() => outside);
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: outside, path },
			null,
			null,
		);
		socket.receive({ type: "prompt", id: "p1", text: "hello" });
		const agent = fakeSocket();
		conversations.open(agent, { kind: "subagent", id: "a1", path }, null, null);
		agent.receive({ type: "prompt", id: "p2", text: "hello" });
		await until(
			() =>
				socket.frames.some((frame) => frame.type === "done") &&
				agent.frames.some((frame) => frame.type === "done"),
		);
		assert.deepEqual(tty.sent, []);
		assert.deepEqual(
			agent.frames.find((frame) => frame.type === "done"),
			{
				type: "done",
				id: "p2",
				ok: false,
				error: "Subagents can only be read",
			},
		);
		socket.hangUp();
		agent.hangUp();
	});
});

const bashCall = (id: string, command: string) =>
	line({
		type: "assistant",
		message: {
			id: `m-${id}`,
			content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
		},
	});

const bashResult = (id: string) =>
	line({
		type: "user",
		message: {
			content: [{ type: "tool_result", tool_use_id: id, content: "" }],
		},
	});

const permissionScreen = (command: string, cursor = 0) =>
	[
		"⏺ Running 1 shell command…",
		`  ⎿  $ touch first.txt`,
		"",
		"─".repeat(60),
		" Bash command",
		` ${command}`,
		" Do you want to proceed?",
		...["Yes", "No"].map(
			(option, at) => ` ${at === cursor ? "❯" : " "} ${at + 1}. ${option}`,
		),
		"",
		" Esc to cancel",
	].join("\n");

const replies = (socket: FakeSocket) =>
	socket.frames.flatMap((frame) =>
		frame.type === "done" ? [[frame.id, frame.ok]] : [],
	);

describe("guarding what reaches the session", () => {
	it("refuses a prompt while the screen shows a permission prompt the board has not caught up with", async () => {
		const path = join(dir, "guard-prompt.jsonl");
		writeFileSync(path, prompt("a") + bashCall("b1", "touch first.txt"));
		const working = session({ activity: "working" });
		const { hub: conversations, tty } = hub(() => working);
		tty.shows = permissionScreen("touch first.txt");
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: working, path },
			null,
			null,
		);
		socket.receive({ type: "prompt", id: "p1", text: "note" });
		socket.receive({ type: "key", id: "k1", key: "Shift+Tab" });
		await until(() => replies(socket).length === 2);
		assert.deepEqual(replies(socket), [
			["p1", false],
			["k1", false],
		]);
		assert.deepEqual(tty.sent, []);
		assert.deepEqual(tty.keysSent, []);
		socket.hangUp();
	});

	it("answers a permission prompt only while that tool's prompt is on screen", async () => {
		const path = join(dir, "guard-permission.jsonl");
		writeFileSync(path, prompt("a") + bashCall("b1", "touch first.txt"));
		const waiting = session({ activity: "needs-you" });
		const { hub: conversations, tty } = hub(() => waiting);
		tty.shows = permissionScreen("touch first.txt");
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: waiting, path },
			null,
			null,
		);
		socket.receive({
			type: "permission",
			id: "y1",
			toolUseId: "b1",
			choice: 0,
			label: "Yes",
		});
		await until(() => replies(socket).length === 1);
		assert.deepEqual(tty.keysSent, ["Enter"]);
		tty.shows = permissionScreen("touch second.txt");
		socket.receive({
			type: "permission",
			id: "y2",
			toolUseId: "b1",
			choice: 0,
			label: "Yes",
		});
		appendFileSync(path, bashResult("b1"));
		socket.receive({
			type: "permission",
			id: "y3",
			toolUseId: "b1",
			choice: 0,
			label: "Yes",
		});
		await until(() => replies(socket).length === 3);
		assert.deepEqual(replies(socket), [
			["y1", true],
			["y2", false],
			["y3", false],
		]);
		assert.deepEqual(tty.keysSent, ["Enter"]);
		appendFileSync(path, bashCall("b2", "touch second.txt"));
		socket.receive({
			type: "permission",
			id: "y5",
			toolUseId: "b2",
			choice: 0,
			label: "Yes",
		});
		await until(() => replies(socket).length === 4);
		assert.deepEqual(replies(socket).at(-1), ["y5", true]);
		socket.hangUp();
	});

	it("interrupts only a working session, and closes a menu with Esc", async () => {
		const path = join(dir, "guard-escape.jsonl");
		writeFileSync(path, prompt("a") + bashResult("none"));
		const idle = session();
		const { hub: conversations, tty } = hub(() => idle);
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: idle, path },
			null,
			null,
		);
		socket.receive({ type: "key", id: "k1", key: "Escape" });
		await until(() => replies(socket).length === 1);
		tty.shows = [
			"─".repeat(60),
			" Rewind",
			" ❯ (current)",
			" Enter to continue · Esc to cancel",
		].join("\n");
		socket.receive({ type: "prompt", id: "p1", text: "after" });
		socket.receive({ type: "key", id: "k2", key: "Escape" });
		await until(() => replies(socket).length === 3);
		assert.deepEqual(replies(socket), [
			["k1", false],
			["p1", false],
			["k2", true],
		]);
		assert.deepEqual(tty.keysSent, ["Escape"]);
		assert.deepEqual(tty.sent, []);
		await until(() =>
			socket.frames.some(
				(frame) => frame.type === "dialog" && frame.dialog?.kind === "menu",
			),
		);
		socket.hangUp();
	});

	it("never opens a terminal for input queued before the last viewer left", async () => {
		const path = join(dir, "guard-leave.jsonl");
		writeFileSync(path, prompt("a"));
		const background = session({
			kind: "background",
			attachable: true,
			short: "abcd1234",
			cmux: false,
		});
		const { hub: conversations, tty } = hub(() => background);
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: background, path },
			null,
			null,
		);
		assert.deepEqual(conversations.attached(), ["abcd1234"]);
		const opened = tty.opened;
		socket.receive({ type: "key", id: "k1", key: "Shift+Tab" });
		socket.receive({ type: "key", id: "k2", key: "Shift+Tab" });
		socket.hangUp();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(tty.keysSent, []);
		assert.equal(tty.opened, opened);
		assert.deepEqual(conversations.attached(), []);
	});

	it("opens a live session that has no transcript yet and picks it up once written", async () => {
		const path = join(dir, "guard-fresh.jsonl");
		let written: string | null = null;
		const fresh = session();
		const { hub: conversations, tty } = hub(
			() => fresh,
			fakeTty(),
			3,
			() => written,
		);
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: fresh, path: null },
			null,
			null,
		);
		socket.receive({ type: "prompt", id: "p1", text: "first" });
		await until(() => replies(socket).length === 1);
		assert.deepEqual(tty.sent, ["first"]);
		writeFileSync(path, prompt("first"));
		written = path;
		await until(() =>
			itemFrames(socket).some((frame) =>
				frame.items.some(
					(item) => item.kind === "user" && item.text === "first",
				),
			),
		);
		socket.hangUp();
	});

	it("shows and answers a background question that only the job state holds so far", async () => {
		const path = join(dir, "guard-block.jsonl");
		writeFileSync(path, prompt("ask me"));
		const asking = session({
			kind: "background",
			short: "aefe4be5",
			attachable: true,
			cmux: false,
			activity: "needs-you",
		});
		let block: Record<string, unknown> | null = {
			questions: [
				{
					question: "Colour?",
					options: [
						{ label: "Red", description: "warm" },
						{ label: "Blue", description: "cool" },
					],
				},
			],
		};
		const { hub: conversations, tty } = hub(
			() => asking,
			fakeTty(),
			3,
			() => path,
			() => block,
		);
		tty.shows =
			" ☐ Colour \nColour?\n❯ 1. Red\n  2. Blue\n  3. Type something.";
		const keys = tty.keys;
		tty.keys = (pressed) => {
			tty.shows = "❯ ";
			block = null;
			return keys(pressed);
		};
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: asking, path },
			null,
			null,
		);
		await until(() =>
			socket.frames.some(
				(frame) => frame.type === "dialog" && frame.answerable,
			),
		);
		const shown = socket.frames.find((frame) => frame.type === "dialog");
		assert.ok(shown?.type === "dialog" && shown.dialog?.kind === "question");
		assert.deepEqual(
			shown.dialog.questions.map(({ question, options }) => ({
				question,
				options: options.map(({ label }) => label),
			})),
			[{ question: "Colour?", options: ["Red", "Blue"] }],
		);
		socket.receive({
			type: "answer",
			id: "a1",
			toolUseId: shown.dialog.toolUseId,
			answers: [{ selected: ["Red"], other: null }],
		});
		await until(() => replies(socket).length === 1);
		assert.deepEqual(replies(socket), [["a1", true]]);
		assert.deepEqual(tty.keysSent, ["Enter"]);
		socket.hangUp();
	});
});

describe("conversation rules", () => {
	it("parses resume points and client frames strictly", () => {
		assert.deepEqual(parseSince("ab-1:42"), { epoch: "ab-1", rev: 42 });
		assert.equal(parseSince("nope"), null);
		assert.equal(parseSince(null), null);
		const parse = (frame: unknown) =>
			parseConversationFrame(JSON.stringify(frame));
		assert.deepEqual(parse({ type: "more", before: 3 }), {
			type: "more",
			before: 3,
		});
		assert.equal(parse({ type: "key", id: "a", key: "Ctrl+C" }), null);
		assert.equal(parse({ type: "prompt", id: "a b", text: "x" }), null);
		assert.deepEqual(
			parse({
				type: "answer",
				id: "a",
				toolUseId: "t",
				answers: [{ selected: ["x"], other: null }],
			}),
			{
				type: "answer",
				id: "a",
				toolUseId: "t",
				answers: [{ selected: ["x"], other: null }],
			},
		);
		assert.equal(
			parse({
				type: "answer",
				id: "a",
				toolUseId: "t",
				answers: [{ selected: [1], other: null }],
			}),
			null,
		);
		assert.deepEqual(
			parse({
				type: "permission",
				id: "a",
				toolUseId: null,
				choice: 1,
				label: "No",
			}),
			{ type: "permission", id: "a", toolUseId: null, choice: 1, label: "No" },
		);
		assert.equal(parseConversationFrame("junk"), null);
	});

	it("allows the user's own commands but not control characters or long text", () => {
		assert.equal(promptRefusal("/compact", false), null);
		assert.match(promptRefusal("hello", true) ?? "", /Answer it first/);
		assert.equal(promptRefusal("!ls", false), null);
		assert.equal(promptRefusal("# note", false), null);
		assert.equal(promptRefusal("line one\nline two\tend", false), null);
		assert.match(
			promptRefusal("x\u001b[201~", false) ?? "",
			/control characters/,
		);
		assert.match(promptRefusal("x".repeat(16_001), false) ?? "", /at most/);
		assert.match(promptRefusal("   ", false) ?? "", /Type something/);
	});

	it("drives background sessions by attach and cmux sessions by cmux", () => {
		assert.deepEqual(
			driveOf(
				session({
					kind: "background",
					attachable: true,
					short: "abcd1234",
					cmux: false,
					artifacts: [],
					tasks: [],
					steps: [],
				}),
			),
			{ mode: "drive", via: "attach" },
		);
		assert.deepEqual(driveOf(session()), { mode: "drive", via: "cmux" });
		assert.equal(driveOf(session({ cmux: false })).mode, "read");
		assert.equal(
			driveOf(session({ kind: "background", attachable: false })).mode,
			"read",
		);
		assert.deepEqual(
			driveOf(
				session({
					kind: "background",
					attachable: false,
					cloud: { url: "https://claude.ai/code/session_01a" },
				}),
			),
			{ mode: "drive", via: "cloud" },
		);
	});

	it("finds the question or permission prompt a session waits on", () => {
		const log = createLog("/nowhere.jsonl");
		applyConversationRecord(log, {
			type: "assistant",
			message: {
				id: "m1",
				content: [
					{
						type: "tool_use",
						id: "q1",
						name: "AskUserQuestion",
						input: {
							questions: [
								{
									question: "Colour?",
									header: "Colour",
									multiSelect: false,
									options: [{ label: "Red", description: "warm" }],
								},
							],
						},
					},
				],
			},
		});
		const waiting = session({ activity: "needs-you" });
		assert.deepEqual(dialogOf(log, waiting, null), {
			dialog: {
				kind: "question",
				toolUseId: "q1",
				questions: [
					{
						question: "Colour?",
						header: "Colour",
						multiSelect: false,
						options: [{ label: "Red", description: "warm" }],
					},
				],
			},
			answerable: false,
		});
		const asking = " ☐ Colour \nColour?\n❯ 1. Red\n  2. Type something.";
		assert.equal(dialogOf(log, waiting, asking).answerable, true);
		const bash = createLog("/nowhere.jsonl");
		applyConversationRecord(bash, {
			type: "assistant",
			message: {
				id: "m2",
				content: [
					{
						type: "tool_use",
						id: "b1",
						name: "Bash",
						input: { command: "ls" },
					},
				],
			},
		});
		const prompt =
			" Bash command\n ls\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel";
		assert.deepEqual(dialogOf(bash, waiting, prompt), {
			dialog: {
				kind: "permission",
				toolUseId: "b1",
				title: "Bash",
				context: null,
				question: "Do you want to proceed?",
				options: ["Yes", "No"],
				complete: true,
			},
			answerable: true,
		});
		assert.equal(dialogOf(bash, waiting, "❯ ").answerable, false);
		assert.equal(dialogOf(bash, waiting, "❯ ").dialog?.kind, "permission");
		assert.equal(dialogOf(bash, session(), "❯ ").dialog, null);
		assert.equal(dialogOf(createLog("/x"), session(), prompt).dialog, null);
	});
});

const betfair: AskQuestion = {
	question: "Run against Betfair?",
	header: "Betfair",
	multiSelect: false,
	options: [
		{ label: "Yes, test then full", description: "recommended" },
		{ label: "Test call only", description: "" },
		{ label: "No Betfair calls", description: "" },
	],
};

const venue: AskQuestion = {
	question: "Where should the party be?",
	header: "Venue",
	multiSelect: false,
	options: [
		{ label: "Hall", description: "indoors" },
		{ label: "Park", description: "outdoors" },
	],
};

const snacks: AskQuestion = {
	question: "Which snacks should we buy?",
	header: "Snacks",
	multiSelect: true,
	options: [
		{ label: "Chips", description: "salty" },
		{ label: "Fruit", description: "fresh" },
		{ label: "Cookies", description: "sweet" },
	],
};

const jobBlock = (questions: AskQuestion[]) => ({
	questions: questions.map(({ question, options }) => ({ question, options })),
});

const askCall = (id: string, questions: AskQuestion[]) =>
	line({
		type: "assistant",
		message: {
			id: `m-${id}`,
			content: [
				{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } },
			],
		},
	});

const drivable = (tui: FakeTui) => {
	const tty = Object.assign(tui, {
		closed: 0,
		send: async () => ({ ok: true as const, value: null }),
		isOpen: () => true,
		close() {
			tty.closed += 1;
		},
	});
	return tty;
};

const answering = (
	tui: FakeTui,
	path: string | null,
	current: Session,
	block: Record<string, unknown> | null = null,
) => {
	const tty = drivable(tui);
	const conversations = createConversationHub({
		session: () => current,
		tty: () => tty,
		transcriptPath: () => path,
		block: () => (tui.state ? block : null),
		audit: () => {},
		pollMs: 5,
		screenMs: 0,
	});
	return { conversations, tty };
};

const idOf = (
	read: { ok: true; value: string } | { ok: false; error: string },
) => (read.ok ? read.value : read.error).match(/Prompt id: (\w+)/)?.[1] ?? "";

const readAndAnswer = async (
	conversations: ReturnType<typeof createConversationHub>,
	current: Session,
	answers: AskAnswer[],
) => {
	const prompt = idOf(await conversations.respond(current, null));
	return conversations.respond(current, { prompt, answers });
};

describe("answering a prompt for the board agent", () => {
	const waiting = session({ activity: "needs-you" });

	it("reads the open question with its options, then picks the one asked for", async () => {
		const path = join(dir, "agent-question.jsonl");
		writeFileSync(path, prompt("check betfair") + askCall("q1", [betfair]));
		const tui = fakeTui({ questions: [betfair] });
		const { conversations, tty } = answering(tui, path, waiting);
		const read = await conversations.respond(waiting, null);
		const question = {
			kind: "question" as const,
			toolUseId: "q1",
			questions: [betfair],
		};
		assert.deepEqual(read, {
			ok: true,
			value: describeDialog("demo", question),
		});
		assert.match(
			read.ok ? read.value : "",
			/"Yes, test then full": recommended/,
		);
		assert.equal(tui.submitted, null, "reading answers nothing");
		const picked = await conversations.respond(waiting, {
			prompt: promptId("demo", question),
			answers: [{ selected: ["Yes, test then full"], other: null }],
		});
		assert.deepEqual(picked, {
			ok: true,
			value: `Answered demo's prompt with "Yes, test then full"`,
		});
		assert.deepEqual(tui.submitted, {
			"Run against Betfair?": "Yes, test then full",
		});
		assert.equal(tty.closed, 2, "the terminal is let go after each call");
		assert.deepEqual(conversations.attached(), []);
	});

	it("answers a background question that only the job state holds so far", async () => {
		const path = join(dir, "agent-block.jsonl");
		writeFileSync(path, prompt("check betfair"));
		const background = session({
			kind: "background",
			short: "f8afa14b",
			attachable: true,
			cmux: false,
			activity: "needs-you",
		});
		const tui = fakeTui({ questions: [betfair] });
		const { conversations } = answering(tui, path, background, {
			questions: [betfair],
		});
		const picked = await readAndAnswer(conversations, background, [
			{ selected: ["Yes, test then full"], other: null },
		]);
		assert.equal(picked.ok, true);
		assert.deepEqual(tui.submitted, {
			"Run against Betfair?": "Yes, test then full",
		});
	});

	it("reads a background question's types off the screen, since the job state leaves them out", async () => {
		const path = join(dir, "agent-block-shapes.jsonl");
		writeFileSync(path, prompt("plan the party"));
		const background = session({
			kind: "background",
			short: "73585ae6",
			attachable: true,
			cmux: false,
			activity: "needs-you",
		});
		const tui = fakeTui({ questions: [venue, snacks] });
		const { conversations } = answering(
			tui,
			path,
			background,
			jobBlock([venue, snacks]),
		);
		const picked = await readAndAnswer(conversations, background, [
			{ selected: ["Park"], other: null },
			{ selected: ["Chips", "Fruit"], other: "Pretzels" },
		]);
		assert.equal(picked.ok, true);
		assert.deepEqual(tui.submitted, {
			"Where should the party be?": "Park",
			"Which snacks should we buy?": "Chips, Fruit, Pretzels",
		});
	});

	it("shows a viewer a background question's checkboxes and headers, then answers it", async () => {
		const path = join(dir, "view-block-shapes.jsonl");
		writeFileSync(path, prompt("plan the party"));
		const background = session({
			kind: "background",
			short: "f549d3f9",
			attachable: true,
			cmux: false,
			activity: "needs-you",
		});
		const tui = fakeTui({ questions: [venue, snacks] });
		const { conversations } = answering(
			tui,
			path,
			background,
			jobBlock([venue, snacks]),
		);
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: background, path },
			null,
			null,
		);
		await until(() =>
			socket.frames.some(
				(frame) => frame.type === "dialog" && frame.answerable,
			),
		);
		const shown = socket.frames.findLast((frame) => frame.type === "dialog");
		assert.ok(shown?.type === "dialog" && shown.dialog?.kind === "question");
		assert.deepEqual(
			shown.dialog.questions.map(({ header, multiSelect }) => ({
				header,
				multiSelect,
			})),
			[
				{ header: "Venue", multiSelect: false },
				{ header: "Snacks", multiSelect: true },
			],
		);
		socket.receive({
			type: "answer",
			id: "a1",
			toolUseId: shown.dialog.toolUseId,
			answers: [
				{ selected: [], other: "The roof" },
				{ selected: ["Cookies"], other: "Pretzels" },
			],
		});
		await until(() => tui.submitted !== null);
		assert.deepEqual(tui.submitted, {
			"Where should the party be?": "The roof",
			"Which snacks should we buy?": "Cookies, Pretzels",
		});
		socket.hangUp();
	});

	it("types a free-text answer where the question takes one", async () => {
		const path = join(dir, "agent-other.jsonl");
		writeFileSync(path, prompt("check") + askCall("q1", [betfair]));
		const tui = fakeTui({ questions: [betfair] });
		const { conversations } = answering(tui, path, waiting);
		const typed = await readAndAnswer(conversations, waiting, [
			{ selected: [], other: "Only the read-only endpoints" },
		]);
		assert.equal(typed.ok, true);
		assert.deepEqual(tui.submitted, {
			"Run against Betfair?": "Only the read-only endpoints",
		});
	});

	it("refuses an answer that is not one of the options and shows the options again", async () => {
		const path = join(dir, "agent-wrong.jsonl");
		writeFileSync(path, prompt("check") + askCall("q1", [betfair]));
		const tui = fakeTui({ questions: [betfair] });
		const { conversations } = answering(tui, path, waiting);
		const wrong = await readAndAnswer(conversations, waiting, [
			{ selected: ["Yes"], other: null },
		]);
		assert.equal(wrong.ok, false);
		assert.match(wrong.ok ? "" : wrong.error, /not one of the choices/);
		assert.match(wrong.ok ? "" : wrong.error, /"Test call only"/);
		assert.equal(tui.submitted, null);
		assert.equal(tui.state?.kind, "ask");
	});

	it("chooses a permission prompt's option by its exact label", async () => {
		const options = ["Yes, and auto-accept edits", "Yes", "No"];
		const tui = fakeTui({ permission: options });
		const { conversations } = answering(tui, null, waiting);
		const read = await conversations.respond(waiting, null);
		assert.equal(
			read.ok ? read.value : read.error,
			[
				"demo asks permission for Claude Code:",
				"Bash command",
				" echo hi > out.txt",
				"Do you want to proceed?",
				...options.map((option) => `- "${option}"`),
				`Prompt id: ${idOf(read)}`,
			].join("\n"),
		);
		const answer = (selected: string[]) =>
			conversations.respond(waiting, {
				prompt: idOf(read),
				answers: [{ selected, other: null }],
			});
		const twice = await answer(["Yes", "No"]);
		assert.match(twice.ok ? "" : twice.error, /exactly one of its choices/);
		const partial = await answer(["Yes, and"]);
		assert.match(partial.ok ? "" : partial.error, /not one of the choices/);
		assert.equal((await answer(["yes"])).ok, true);
		assert.equal(tui.chosen, "Yes");
	});

	it("declines with No", async () => {
		const tui = fakeTui({ permission: ["Yes", "No"] });
		const { conversations } = answering(tui, null, waiting);
		const declined = await readAndAnswer(conversations, waiting, [
			{ selected: ["No"], other: null },
		]);
		assert.equal(declined.ok, true);
		assert.equal(tui.chosen, "No");
	});

	it("refuses to answer a prompt other than the one it read", async () => {
		const tui = fakeTui({ permission: ["Yes", "No"] });
		const { conversations } = answering(tui, null, waiting);
		const read = await conversations.respond(waiting, null);
		tui.state = {
			kind: "permission",
			options: ["Yes", "Yes, allow all edits", "No"],
			cursor: 0,
		};
		const changed = await conversations.respond(waiting, {
			prompt: idOf(read),
			answers: [{ selected: ["Yes"], other: null }],
		});
		assert.match(
			changed.ok ? "" : changed.error,
			/not the one you read[\s\S]*"Yes, allow all edits"/,
		);
		assert.equal(tui.chosen, null);
		assert.notEqual(idOf(changed), idOf(read));
	});

	it("refuses when nothing is waiting or the session cannot be driven", async () => {
		const idle = fakeTui({});
		const { conversations } = answering(idle, null, session());
		const nothing = await conversations.respond(session(), null);
		assert.match(nothing.ok ? "" : nothing.error, /not waiting on a question/);
		const outside = session({ activity: "needs-you", cmux: false });
		const { conversations: unreachable } = answering(
			fakeTui({ permission: ["Yes"] }),
			null,
			outside,
		);
		const refused = await unreachable.respond(outside, null);
		assert.match(refused.ok ? "" : refused.error, /outside cmux/);
	});

	it("shares the terminal and the queue with someone viewing the session", async () => {
		const path = join(dir, "agent-viewed.jsonl");
		writeFileSync(path, prompt("check") + askCall("q1", [betfair]));
		const tui = fakeTui({ questions: [betfair] });
		const { conversations, tty } = answering(tui, path, waiting);
		const socket = fakeSocket();
		conversations.open(
			socket,
			{ kind: "session", session: waiting, path },
			null,
			null,
		);
		const picked = await readAndAnswer(conversations, waiting, [
			{ selected: ["Test call only"], other: null },
		]);
		assert.equal(picked.ok, true);
		assert.equal(tty.closed, 0, "the viewer keeps the terminal");
		socket.hangUp();
		await until(() => tty.closed === 1);
	});

	it("hands a viewer who reloads mid-answer a fresh view, and keeps the terminal", async () => {
		const path = join(dir, "agent-reload.jsonl");
		writeFileSync(path, prompt("check") + askCall("q1", [betfair]));
		const tui = fakeTui({ questions: [betfair] });
		const { conversations, tty } = answering(tui, path, waiting);
		let release = () => {};
		const pressing = new Promise<void>((resolve) => {
			release = resolve;
		});
		const keys = tui.keys;
		tui.keys = async (pressed) => {
			await pressing;
			return keys(pressed);
		};
		const target = { kind: "session" as const, session: waiting, path };
		const first = fakeSocket();
		const second = fakeSocket();
		try {
			conversations.open(first, target, null, null);
			await until(() => first.frames.some((frame) => frame.type === "dialog"));
			const read = idOf(await conversations.respond(waiting, null));
			const answered = conversations.respond(waiting, {
				prompt: read,
				answers: [{ selected: ["No Betfair calls"], other: null }],
			});
			first.hangUp();
			conversations.open(second, target, null, null);
			await until(() =>
				second.frames.some(
					(frame) =>
						frame.type === "dialog" && frame.dialog?.kind === "question",
				),
			);
			release();
			assert.equal((await answered).ok, true);
			assert.equal(tty.closed, 0, "the reloaded view still holds the terminal");
		} finally {
			release();
			first.hangUp();
			second.hangUp();
		}
		await until(() => tty.closed === 1);
	});
});
