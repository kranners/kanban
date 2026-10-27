import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ConversationServerFrame } from "../shared/conversation.ts";
import type { Session } from "../shared/types.ts";
import type { AttachSocket } from "./attach.ts";
import type { AuditEvent } from "./audit.ts";
import { applyConversationRecord, createLog } from "./conversation.ts";
import {
	createConversationHub,
	dialogOf,
	driveOf,
	parseConversationFrame,
	parseSince,
	promptRefusal,
} from "./conversationHub.ts";
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
	startedAt: 0,
	updatedAt: 0,
	attachable: false,
	cmux: true,
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

const fakeTty = (): SessionTty & { sent: string[]; keysSent: string[] } => {
	const tty = {
		sent: [] as string[],
		keysSent: [] as string[],
		screen: async () => ({
			ok: true as const,
			value: "❯ \n  ⏵⏵ accept edits on",
		}),
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
	return tty as SessionTty & { sent: string[]; keysSent: string[] };
};

const hub = (current: () => Session, tty = fakeTty(), windowSize = 3) => {
	const events: AuditEvent[] = [];
	return {
		events,
		tty,
		hub: createConversationHub({
			session: () => current(),
			tty: () => tty,
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
			" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel";
		assert.deepEqual(dialogOf(bash, waiting, prompt), {
			dialog: {
				kind: "permission",
				toolUseId: "b1",
				title: "Bash",
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
