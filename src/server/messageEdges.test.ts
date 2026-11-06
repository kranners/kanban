import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createMessageEdgeStore,
	edgeKeptMs,
	edgesFromAudit,
	keptEdgeMessages,
	loadEdges,
	maxEdgeText,
	parseDaemonEdges,
	parseEndKey,
	readAuditTail,
} from "./messageEdges.ts";

const desk = { kind: "thread", id: "111111" } as const;
const dm = { kind: "thread", id: "222222" } as const;
const session = { kind: "session", id: "session_abc" } as const;

const daemonEdge = (fields: Record<string, unknown> = {}) => ({
	from: "111111",
	to: "222222",
	via: "desk say",
	count: 3,
	lastAt: 1000,
	messages: [{ at: 900, kind: "user", text: "the report is ready" }],
	...fields,
});

describe("parseDaemonEdges", () => {
	it("takes thread-to-thread edges and their user messages", () => {
		const parsed = parseDaemonEdges([
			daemonEdge({
				messages: [
					{ at: 1, kind: "assistant", text: "not this" },
					{ at: 2, kind: "user", text: "  this  " },
				],
			}),
		]);
		assert.deepEqual(parsed, [
			{
				from: desk,
				to: dm,
				via: "desk say",
				count: 3,
				lastAt: 1000,
				messages: [{ at: 2, text: "this" }],
			},
		]);
	});

	it("drops entries that are not edges", () => {
		const parsed = parseDaemonEdges([
			daemonEdge({ from: "nope" }),
			daemonEdge({ to: "111111" }),
			daemonEdge({ count: 0 }),
			daemonEdge({ count: 1.5 }),
			daemonEdge({ via: "  " }),
			daemonEdge({ lastAt: -1 }),
			daemonEdge({ messages: "hello" }),
			"edge",
		]);
		assert.deepEqual(parsed, []);
	});

	it("refuses a payload that is not a list and takes none as empty", () => {
		assert.ok("error" in (parseDaemonEdges({}) as object));
		assert.deepEqual(parseDaemonEdges(undefined), []);
	});

	it("keeps the last five messages, each clipped", () => {
		const messages = Array.from({ length: 8 }, (_, i) => ({
			at: i,
			kind: "user",
			text: "x".repeat(maxEdgeText + 10),
		}));
		const [edge] = parseDaemonEdges([daemonEdge({ messages })]) as unknown as [
			{ messages: { at: number; text: string }[] },
		];
		assert.equal(edge.messages.length, keptEdgeMessages);
		assert.equal(edge.messages[0]?.at, 3);
		assert.equal(edge.messages[0]?.text.length, maxEdgeText);
	});
});

describe("parseEndKey", () => {
	it("reads thread and session ends and nothing else", () => {
		assert.deepEqual(parseEndKey("thread:111111"), desk);
		assert.deepEqual(parseEndKey("session:session_abc"), session);
		assert.equal(parseEndKey("thread:abc"), null);
		assert.equal(parseEndKey("note:1"), null);
		assert.equal(parseEndKey(null), null);
	});
});

describe("createMessageEdgeStore", () => {
	it("counts what the board records and keeps the words apart from the summaries", () => {
		const changes: unknown[] = [];
		const store = createMessageEdgeStore({
			now: () => 5000,
			onChange: (edges) => changes.push(edges),
		});
		store.record({ from: desk, to: session, via: "prompt", text: "a", at: 1 });
		store.record({ from: desk, to: session, via: "prompt", text: "b", at: 2 });
		assert.deepEqual(store.summaries(), [
			{ from: desk, to: session, via: "prompt", count: 2, lastAt: 2 },
		]);
		assert.deepEqual(store.messages(desk, session), [
			{ at: 1, via: "prompt", text: "a" },
			{ at: 2, via: "prompt", text: "b" },
		]);
		assert.deepEqual(store.messages(session, desk), []);
		assert.equal(changes.length, 2);
		assert.ok(!JSON.stringify(changes).includes('"a"'));
	});

	it("replaces the daemon's edges on each sync", () => {
		const store = createMessageEdgeStore({ now: () => 5000 });
		store.syncDaemon(parseDaemonEdges([daemonEdge()]) as never);
		store.syncDaemon(
			parseDaemonEdges([daemonEdge({ from: "333333", count: 1 })]) as never,
		);
		assert.deepEqual(
			store.summaries().map((e) => [e.from.id, e.count]),
			[["333333", 1]],
		);
	});

	it("forgets edges after a day", () => {
		let clock = 1000;
		const store = createMessageEdgeStore({ now: () => clock });
		store.record({
			from: desk,
			to: session,
			via: "prompt",
			text: "a",
			at: 1000,
		});
		clock = 1000 + edgeKeptMs;
		assert.deepEqual(store.summaries(), []);
		assert.deepEqual(store.messages(desk, session), []);
	});

	it("seeds only edges it does not hold, and only from the last day", () => {
		const store = createMessageEdgeStore({ now: () => edgeKeptMs + 100 });
		store.record({
			from: desk,
			to: session,
			via: "prompt",
			text: "live",
			at: edgeKeptMs + 50,
		});
		const seeded = store.seed([
			{
				from: desk,
				to: session,
				via: "prompt",
				text: "again",
				at: edgeKeptMs + 40,
			},
			{
				from: desk,
				to: session,
				via: "start",
				text: "go",
				at: edgeKeptMs + 10,
			},
			{
				from: desk,
				to: session,
				via: "start",
				text: "go 2",
				at: edgeKeptMs + 20,
			},
			{ from: dm, to: session, via: "prompt", text: "old", at: 50 },
		]);
		assert.equal(seeded, 2);
		assert.deepEqual(
			store.summaries().map((e) => [e.via, e.count]),
			[
				["start", 2],
				["prompt", 1],
			],
		);
		assert.equal(
			store.seed([
				{
					from: desk,
					to: session,
					via: "start",
					text: "go",
					at: edgeKeptMs + 10,
				},
			]),
			0,
		);
	});

	it("persists and loads its edges", async () => {
		const dir = await mkdtemp(join(tmpdir(), "edges-"));
		const file = join(dir, "edges.json");
		const store = createMessageEdgeStore({ file, now: () => 10 });
		store.record({ from: desk, to: session, via: "prompt", text: "a", at: 5 });
		await store.saved();
		assert.match(await readFile(file, "utf8"), /"prompt"/);
		const loaded = await loadEdges(file);
		assert.equal(loaded.board.length, 1);
		assert.deepEqual((await loadEdges(join(dir, "missing.json"))).board, []);
	});
});

describe("edgesFromAudit", () => {
	const line = (fields: Record<string, unknown>) =>
		JSON.stringify({
			at: "2026-11-06T10:00:00.000Z",
			action: "board-agent",
			thread: "butler",
			...fields,
		});

	it("reads Butler's prompts and starts that name a parent thread", () => {
		const text = [
			line({
				tool: "send_prompt",
				parent: "111111",
				target: "session_abc",
				input: "carry on",
				result: "Sent a prompt",
			}),
			line({
				tool: "start_session",
				parent: "111111",
				target: "/work",
				input: "build it",
				result: "Started a session in /work (cloud session session_new)",
			}),
			line({
				tool: "start_session",
				parent: "111111",
				target: "/work",
				input: "local",
				result: "Started a session in /work (short id ab12cd34)",
			}),
			line({
				tool: "send_prompt",
				target: "session_abc",
				input: "no parent",
				result: "ok",
			}),
			line({
				tool: "send_prompt",
				parent: "111111",
				target: "x",
				input: "failed",
				result: "error: nope",
			}),
			"not json",
		].join("\n");
		const at = Date.parse("2026-11-06T10:00:00.000Z");
		assert.deepEqual(edgesFromAudit(text), [
			{ from: desk, to: session, via: "prompt", text: "carry on", at },
			{
				from: desk,
				to: { kind: "session", id: "session_new" },
				via: "start",
				text: "build it",
				at,
			},
			{
				from: desk,
				to: { kind: "session", id: "ab12cd34" },
				via: "start",
				text: "local",
				at,
			},
		]);
	});

	it("reads only the end of a long log, from a whole line", async () => {
		const dir = await mkdtemp(join(tmpdir(), "audit-"));
		const file = join(dir, "audit.jsonl");
		await writeFile(file, `${"a".repeat(100)}\nsecond\nthird\n`);
		assert.equal(await readAuditTail(file, 16), "second\nthird\n");
		assert.equal(await readAuditTail(join(dir, "missing")), "");
	});
});
