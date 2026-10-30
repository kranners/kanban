import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ConversationItem,
	ToolResult,
} from "../../shared/conversation.ts";
import {
	activeToken,
	applyItems,
	backgroundTools,
	complete,
	connectionDropped,
	diffLines,
	diffStats,
	emptyWindow,
	exitCode,
	formatElapsed,
	formatTokens,
	matchCount,
	modeLabel,
	nextBatch,
	type Outgoing,
	prepend,
	promptHistory,
	replacementLines,
	settleSend,
	stepOutbox,
	stillQueued,
	type ToolItem,
	todos,
	toolDetail,
	toolState,
	toolTitle,
} from "./conversation.ts";

const result = (changes: Partial<ToolResult> = {}): ToolResult => ({
	text: "",
	isError: false,
	images: 0,
	truncated: false,
	patch: null,
	agentId: null,
	answers: null,
	interrupted: false,
	artifact: null,
	task: null,
	at: 0,
	...changes,
});

const tool = (
	name: string,
	input: Record<string, unknown>,
	outcome: ToolResult | null = null,
): ToolItem => ({
	kind: "tool",
	index: 0,
	rev: 1,
	at: 0,
	id: "t1",
	name,
	input,
	result: outcome,
});

const user = (index: number, text: string, at = 0): ConversationItem => ({
	kind: "user",
	index,
	rev: index + 1,
	at,
	text,
	images: 0,
	queued: false,
});

describe("tool blocks", () => {
	it("summarise each tool by what it touched", () => {
		assert.equal(
			toolDetail(tool("Bash", { command: "npm test\n--watch" })),
			"npm test",
		);
		assert.equal(
			toolDetail(tool("Bash", { command: "x", description: "Run the tests" })),
			"Run the tests",
		);
		assert.equal(
			toolDetail(tool("Read", { file_path: "/a.ts", offset: 10, limit: 5 })),
			"/a.ts · lines 10–14",
		);
		assert.equal(
			toolDetail(tool("Grep", { pattern: "todo", path: "src" })),
			"todo in src",
		);
		assert.equal(
			toolDetail(tool("Agent", { description: "Survey the code" })),
			"Survey the code",
		);
		assert.equal(
			toolDetail(
				tool("TodoWrite", {
					todos: [
						{ content: "a", status: "completed" },
						{ content: "b", status: "pending" },
					],
				}),
			),
			"1/2 done",
		);
		assert.equal(
			toolDetail(
				tool("AskUserQuestion", { questions: [{ question: "Colour?" }] }),
			),
			"Colour?",
		);
		assert.equal(
			toolDetail(tool("mcp__docs__search", { query: "cache" })),
			"cache",
		);
		assert.equal(toolTitle("mcp__claude_docs__search"), "claude docs · search");
		assert.equal(toolTitle("Bash"), "Bash");
	});

	it("reports running, failed and interrupted calls, exit codes and match counts", () => {
		assert.equal(toolState(tool("Bash", {})), "running");
		assert.equal(
			toolState(tool("Bash", {}, result({ isError: true }))),
			"error",
		);
		assert.equal(
			toolState(tool("Bash", {}, result({ interrupted: true }))),
			"interrupted",
		);
		assert.equal(
			toolState(
				tool(
					"Edit",
					{},
					result({
						isError: true,
						text: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
					}),
				),
			),
			"rejected",
		);
		const launched = (status: string | null) =>
			tool(
				"Workflow",
				{
					script:
						"export const meta = {\n  name: 'tidy',\n  description: 'Tidy the \\'docs\\'',\n}\n",
				},
				result({
					task: { id: "w1", runId: "wf_1", summary: null, status },
				}),
			);
		assert.equal(toolState(launched(null)), "background");
		assert.equal(toolState(launched("completed")), "done");
		assert.equal(toolState(launched("failed")), "error");
		assert.equal(toolDetail(launched(null)), "Tidy the 'docs'");
		assert.deepEqual(
			backgroundTools([launched(null), launched("completed")]).length,
			1,
		);
		assert.equal(
			exitCode(
				tool("Bash", {}, result({ text: "Exit code 2\nboom", isError: true })),
			),
			2,
		);
		assert.equal(exitCode(tool("Bash", {}, result({ text: "ok" }))), 0);
		assert.equal(exitCode(tool("Read", {}, result())), null);
		assert.equal(
			matchCount(tool("Grep", {}, result({ text: "Found 3 files\na\nb\nc" }))),
			3,
		);
		assert.equal(
			matchCount(tool("Glob", {}, result({ text: "a.ts\nb.ts\n" }))),
			2,
		);
		assert.equal(
			matchCount(tool("Glob", {}, result({ text: "No files found" }))),
			0,
		);
	});

	it("reads a todo list", () => {
		assert.deepEqual(
			todos({
				todos: [
					{ content: "Write tests", status: "in_progress" },
					{ content: "" },
					null,
				],
			}),
			[{ content: "Write tests", status: "in_progress" }],
		);
	});

	it("diffs edits from patches, replacements and new files", () => {
		const patched = tool(
			"Edit",
			{ old_string: "a", new_string: "b" },
			result({
				patch: [{ oldStart: 4, newStart: 4, lines: [" keep", "-old", "+new"] }],
			}),
		);
		assert.deepEqual(diffLines(patched), [
			{ kind: "hunk", text: "@@ -4 +4 @@" },
			{ kind: "ctx", text: "keep" },
			{ kind: "del", text: "old" },
			{ kind: "add", text: "new" },
		]);
		assert.deepEqual(replacementLines("a\nb\nc", "a\nB\nc"), [
			{ kind: "ctx", text: "a" },
			{ kind: "del", text: "b" },
			{ kind: "add", text: "B" },
			{ kind: "ctx", text: "c" },
		]);
		const written = diffLines(tool("Write", { content: "one\ntwo" }));
		assert.deepEqual(written && diffStats(written), { added: 2, removed: 0 });
		const multi = diffLines(
			tool("MultiEdit", { edits: [{ old_string: "x", new_string: "y" }] }),
		);
		assert.deepEqual(
			multi?.map((line) => line.kind),
			["hunk", "del", "add"],
		);
		assert.equal(diffLines(tool("Bash", { command: "ls" })), null);
	});
});

describe("conversation window", () => {
	it("replaces on reset, upserts later items and prepends older pages", () => {
		const fresh = applyItems(emptyWindow(), {
			type: "items",
			epoch: "e",
			rev: 3,
			total: 5,
			first: 3,
			reset: true,
			items: [user(3, "d"), user(4, "e")],
		});
		assert.equal(fresh.first, 3);
		const updated = applyItems(fresh, {
			type: "items",
			epoch: "e",
			rev: 5,
			total: 6,
			first: -1,
			reset: false,
			items: [user(1, "ignored"), user(4, "E"), user(5, "f")],
		});
		assert.deepEqual(
			updated.items.map((item) => item.kind === "user" && item.text),
			["d", "E", "f"],
		);
		const paged = prepend(updated, 1, [user(1, "b"), user(2, "c")]);
		assert.equal(paged.first, 1);
		assert.deepEqual(
			paged.items.map((item) => item.index),
			[1, 2, 3, 4, 5],
		);
		assert.equal(prepend(paged, 3, [user(3, "x")]), paged);
	});

	it("keeps queued prompts until the transcript shows them", () => {
		const queued = [
			{ id: "1", text: "also  update the docs", sentAt: 10_000 },
			{ id: "2", text: "/compact", sentAt: 10_000 },
		];
		const command: ConversationItem = {
			kind: "command",
			index: 1,
			rev: 2,
			at: 11_000,
			name: "/compact",
			args: "",
			output: "",
		};
		assert.deepEqual(
			stillQueued(queued, [user(0, "also update the docs", 12_000)]),
			[queued[1]],
		);
		assert.deepEqual(stillQueued(queued, [command]), [queued[0]]);
		assert.deepEqual(
			stillQueued(queued, [user(0, "also update the docs", 1000)]),
			queued,
		);
	});

	it("batches queued prompts up to the next command", () => {
		const entry = (
			id: string,
			text: string,
			state: Outgoing["state"] = "queued",
		): Outgoing => ({ id, text, state, sentAt: 0 });
		const plain = [entry("1", "fix it"), entry("2", "and test it")];
		assert.deepEqual(nextBatch(plain, 100), plain);
		assert.deepEqual(
			nextBatch([...plain, entry("3", "/compact"), entry("4", "then go")], 100),
			plain,
		);
		assert.deepEqual(nextBatch([entry("3", " /compact"), ...plain], 100), [
			entry("3", " /compact"),
		]);
		assert.deepEqual(nextBatch(plain, 18), plain);
		assert.deepEqual(nextBatch(plain, 17), [plain[0]]);
		assert.deepEqual(nextBatch([entry("0", "x", "echoed"), ...plain], 100), []);
		assert.deepEqual(nextBatch([], 100), []);
	});

	it("sends the next batch only once the session can take it", () => {
		const queued: Outgoing = {
			id: "1",
			text: "go",
			state: "queued",
			sentAt: 0,
		};
		const scene = {
			items: [],
			loaded: true,
			working: false,
			deliverable: false,
			maxText: 100,
			now: 5000,
		};
		const waiting = stepOutbox([queued], scene);
		assert.equal(waiting.sending, null);
		assert.deepEqual(waiting.outbox, [queued]);
		const ready = stepOutbox([queued], { ...scene, deliverable: true });
		assert.equal(ready.sending?.state, "sending");
		assert.deepEqual(ready.outbox, [ready.sending]);
	});

	it("waits for the echo from when the send was acknowledged", () => {
		const sending: Outgoing = {
			id: "1",
			text: "go",
			state: "sending",
			sentAt: 0,
		};
		const acked = settleSend([sending], "1", { ok: true, error: null }, 10_000);
		assert.deepEqual(acked.outbox, [
			{ ...sending, state: "sent", sentAt: 10_000 },
		]);
		const scene = {
			items: [],
			loaded: true,
			working: false,
			deliverable: false,
			maxText: 100,
			now: 12_000,
		};
		const early = stepOutbox(acked.outbox, scene);
		assert.equal(early.lost, false);
		assert.equal(early.due, 18_000);
		const late = stepOutbox(acked.outbox, { ...scene, now: 18_000 });
		assert.equal(late.lost, true);
		assert.equal(late.outbox[0]?.state, "held");
	});

	it("clears a held message once the transcript shows it after all", () => {
		const held: Outgoing = {
			id: "1",
			text: "go",
			state: "held",
			sentAt: 10_000,
		};
		const queued: Outgoing = {
			id: "2",
			text: "next",
			state: "queued",
			sentAt: 11_000,
		};
		const step = stepOutbox([held, queued], {
			items: [user(0, "go", 30_000)],
			loaded: true,
			working: true,
			deliverable: false,
			maxText: 100,
			now: 31_000,
		});
		assert.deepEqual(step.outbox, [queued]);
	});

	it("retries a failed send before holding it", () => {
		const sending: Outgoing = {
			id: "1",
			text: "go",
			state: "sending",
			sentAt: 0,
		};
		const failure = { ok: false, error: "Could not attach to the session" };
		const first = settleSend([sending], "1", failure, 1000);
		assert.equal(first.outbox[0]?.state, "queued");
		assert.equal(first.retryAt, 3000);
		assert.equal(first.problem, null);
		const last = settleSend([{ ...sending, tries: 2 }], "1", failure, 9000);
		assert.equal(last.outbox[0]?.state, "held");
		assert.equal(last.retryAt, null);
		assert.equal(last.problem, failure.error);
	});

	it("holds a failure that may have typed the text, rather than retrying it", () => {
		const sending: Outgoing = {
			id: "1",
			text: "go",
			state: "sending",
			sentAt: 0,
		};
		const typed = settleSend(
			[sending],
			"1",
			{ ok: false, error: "cmux paste timed out" },
			1000,
		);
		assert.equal(typed.outbox[0]?.state, "held");
		assert.equal(typed.retryAt, null);
	});

	it("keeps the send time when the connection drops mid-send", () => {
		const sending: Outgoing = {
			id: "1",
			text: "go",
			state: "sending",
			sentAt: 1000,
		};
		const dropped = settleSend(
			[sending],
			"1",
			{ ok: false, error: connectionDropped },
			40_000,
		);
		assert.deepEqual(dropped.outbox, [{ ...sending, state: "sent" }]);
		assert.equal(dropped.problem, null);
	});

	it("collects prompt history without repeats", () => {
		assert.deepEqual(
			promptHistory([
				user(0, "a"),
				user(1, "a"),
				user(2, "b"),
				{
					kind: "command",
					index: 3,
					rev: 4,
					at: 0,
					name: "/context",
					args: "",
					output: "",
				},
				{
					kind: "command",
					index: 4,
					rev: 5,
					at: 0,
					name: "!",
					args: "ls",
					output: "",
				},
			]),
			["a", "b", "/context", "!ls"],
		);
	});
});

describe("composer", () => {
	it("finds the slash command or file mention being typed", () => {
		assert.deepEqual(activeToken("/comp", 5), {
			kind: "slash",
			query: "comp",
			start: 0,
		});
		assert.equal(activeToken("say /comp", 9), null);
		assert.deepEqual(activeToken("look at @src/ap", 15), {
			kind: "mention",
			query: "src/ap",
			start: 8,
		});
		assert.deepEqual(activeToken("@", 1), {
			kind: "mention",
			query: "",
			start: 0,
		});
		assert.equal(activeToken("mail me@example", 15), null);
		assert.equal(activeToken("plain text", 10), null);
	});

	it("completes the token in place", () => {
		assert.deepEqual(
			complete(
				"look at @src/ap please",
				15,
				{ kind: "mention", query: "src/ap", start: 8 },
				"src/app.ts",
			),
			{ value: "look at @src/app.ts please", caret: 19 },
		);
		assert.deepEqual(
			complete("@sr", 3, { kind: "mention", query: "sr", start: 0 }, "src/"),
			{ value: "@src/", caret: 5 },
		);
		assert.deepEqual(
			complete(
				"/comp",
				5,
				{ kind: "slash", query: "comp", start: 0 },
				"compact",
			),
			{ value: "/compact ", caret: 9 },
		);
	});

	it("formats tokens, elapsed time and permission modes", () => {
		assert.equal(formatTokens(950), "950");
		assert.equal(formatTokens(52_340), "52.3k");
		assert.equal(formatTokens(200_000), "200k");
		assert.equal(formatTokens(1_250_000), "1.3M");
		assert.equal(formatElapsed(9_400), "9s");
		assert.equal(formatElapsed(184_000), "3m 04s");
		assert.equal(formatElapsed(3_720_000), "1h 02m");
		assert.equal(modeLabel("acceptEdits"), "Accept edits");
		assert.equal(modeLabel("accept edits"), "Accept edits");
		assert.equal(modeLabel("default"), "Manual");
		assert.equal(modeLabel("bypassPermissions"), "Bypass permissions");
		assert.equal(modeLabel(null), null);
	});
});
