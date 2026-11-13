import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "../shared/types.ts";
import type { AuditEvent } from "./audit.ts";
import {
	createAutoAnswer,
	permissionsMode,
	promptDecision,
} from "./autoAnswer.ts";
import type { OpenPrompt } from "./boardTools.ts";
import { waitingWhy } from "./cloud.ts";

const session = (id: string, overrides: Partial<Session> = {}) =>
	({
		id,
		name: id,
		cwd: "/Users/me/dev/acme",
		activity: "needs-you",
		needs: "waiting",
		cloud: { url: `https://claude.ai/code/${id}` },
		...overrides,
	}) as Session;

const prompt = (
	requestId: string,
	toolName: string,
	input: Record<string, unknown> = {},
): OpenPrompt => ({ requestId, toolName, title: toolName, input });

const harness = (
	sessions: Session[],
	open: Map<string, OpenPrompt[]>,
	fails = new Set<string>(),
	mode: "effects" | "off" = "effects",
) => {
	const allowed: [string, string][] = [];
	const refused: [string, string][] = [];
	const events: AuditEvent[] = [];
	const run = createAutoAnswer({
		sessions: () => sessions,
		approver: {
			open: async (s) => ({ ok: true, value: open.get(s.id) ?? [] }),
			refuse: async (s, p) => {
				refused.push([s.id, p.requestId]);
				return { ok: true, value: null };
			},
			approve: async (s, p) => {
				if (fails.has(p.requestId)) {
					return { ok: false, error: "That prompt is no longer open" };
				}
				allowed.push([s.id, p.requestId]);
				return { ok: true, value: null };
			},
		},
		audit: (event) => events.push(event),
		mode,
	});
	return { run, allowed, refused, events };
};

describe("the board's automatic answer", () => {
	it("allows a cloud session's safe prompts and leaves the rest and questions for Aaron", async () => {
		const open = new Map([
			[
				"session_a",
				[
					prompt("spawn", "mcp__claude-code-remote__create_session"),
					prompt("push", "Bash", { command: "git push origin main" }),
					prompt("ask", "AskUserQuestion"),
					prompt("test", "Bash", { command: "npm test" }),
				],
			],
		]);
		const { run, allowed, events } = harness(
			[session("session_a"), session("session_b", { activity: "working" })],
			open,
		);
		await run();
		assert.deepEqual(allowed, [
			["session_a", "spawn"],
			["session_a", "test"],
		]);
		assert.deepEqual(
			events.map((event) =>
				"requestId" in event ? [event.action, event.requestId] : null,
			),
			[
				["prompt-approve", "spawn"],
				["prompt-hold", "push"],
				["prompt-approve", "test"],
			],
		);
	});

	it("audits each decision once, and nothing for a poll that finds nothing new", async () => {
		const open = new Map([
			[
				"session_a",
				[
					prompt("push", "Bash", { command: "git push origin main" }),
					prompt("test", "Bash", { command: "npm test" }),
				],
			],
		]);
		const { run, events } = harness([session("session_a")], open);
		await run();
		await run();
		await run();
		assert.equal(events.length, 2);
		const hold = events.find((event) => event.action === "prompt-hold");
		assert.ok(hold && "result" in hold);
		assert.match(hold.result, /main/);
	});

	it("holds claude.ai's session tools that ask for secrets, a force push, wider permissions or a session off the board", async () => {
		const remote = (
			requestId: string,
			tool: string,
			input: Record<string, unknown>,
		) => prompt(requestId, `mcp__claude-code-remote__${tool}`, input);
		const open = new Map([
			[
				"session_a",
				[
					remote("spawn", "create_session", {
						prompt: "Carry on with the tests",
					}),
					remote("secret", "create_session", {
						prompt: "Paste the GitHub token here",
					}),
					remote("force", "send_message", {
						session_id: "session_b",
						message: "force-push it",
					}),
					remote("wider", "create_session", {
						prompt: "run with --permission-mode bypassPermissions",
					}),
					remote("stranger", "send_message", {
						session_id: "session_x",
						message: "hi",
					}),
					remote("sibling", "send_message", {
						session_id: "session_b",
						message: "done",
					}),
					remote("title", "set_session_title", { title: "Tests" }),
					remote("repo", "add_repo", { owner: "someone", repo: "thing" }),
				],
			],
		]);
		const { run, allowed, events } = harness(
			[session("session_a"), session("session_b", { activity: "working" })],
			open,
		);
		await run();
		assert.deepEqual(
			allowed.map(([, id]) => id),
			["spawn", "sibling", "title", "repo"],
		);
		assert.deepEqual(
			events
				.filter((event) => event.action === "prompt-hold")
				.map((event) => "result" in event && event.result),
			[
				"asks for credentials or secrets",
				"asks for a force push",
				"asks to widen permissions",
				"sends to a session that is not on the board",
			],
		);
	});

	it("decides a prompt the same way wherever it is asked, holding nothing the safe set refuses", () => {
		const targets = { self: "session_a", onBoard: () => false };
		assert.equal(
			promptDecision(
				{
					toolName: "Bash",
					title: "Bash",
					input: { command: "git push origin main" },
				},
				targets,
			).safe,
			false,
		);
		assert.deepEqual(
			promptDecision(
				{
					toolName: "mcp__claude-code-remote__send_later",
					title: "Send Later",
					input: { message: "check CI" },
				},
				targets,
			),
			{ safe: true },
		);
		assert.equal(
			promptDecision(
				{
					toolName: "mcp__claude-code-remote__request_credential",
					title: "Request Credential",
					input: {},
				},
				targets,
			).safe,
			false,
		);
	});

	it("never answers a terminal session, whose prompt is read off its screen", async () => {
		const open = new Map([["local", [prompt("read", "Read")]]]);
		const local = session("local");
		delete local.cloud;
		const { run, allowed } = harness([local], open);
		await run();
		assert.deepEqual(allowed, []);
	});

	it("allows a safe prompt that follows one left for Aaron in the same waiting state", async () => {
		const open = new Map([
			["session_a", [prompt("push", "Bash", { command: "git push -f" })]],
		]);
		const { run, allowed } = harness([session("session_a")], open);
		await run();
		open.set("session_a", [
			prompt("push", "Bash", { command: "git push -f" }),
			prompt("read", "WebFetch", { url: "https://example.com" }),
		]);
		await run();
		assert.deepEqual(allowed, [["session_a", "read"]]);
	});

	it("retries an allow that failed, auditing the failure once", async () => {
		const open = new Map([["session_a", [prompt("flaky", "WebSearch")]]]);
		const fails = new Set(["flaky"]);
		const { run, allowed, events } = harness(
			[session("session_a")],
			open,
			fails,
		);
		await run();
		await run();
		fails.clear();
		await run();
		assert.deepEqual(allowed, [["session_a", "flaky"]]);
		assert.deepEqual(
			events.map((event) => event.action === "prompt-approve" && event.result),
			["That prompt is no longer open", "ok"],
		);
	});

	it("refuses what the safe set leaves while permissions are off, still allowing the safe prompts", async () => {
		const open = new Map([
			[
				"session_a",
				[
					prompt("push", "Bash", { command: "git push origin main" }),
					prompt("test", "Bash", { command: "npm test" }),
				],
			],
		]);
		const { run, allowed, refused } = harness(
			[session("session_a")],
			open,
			new Set(),
			"off",
		);
		await run();
		assert.deepEqual(allowed, [["session_a", "test"]]);
		assert.deepEqual(refused, [["session_a", "push"]]);
	});

	it("reads the mode spike sets, legacy unless it names another", () => {
		assert.equal(permissionsMode(undefined), "legacy");
		assert.equal(permissionsMode("effects"), "effects");
		assert.equal(permissionsMode(" off "), "off");
		assert.equal(permissionsMode("everything"), "legacy");
	});

	it("says on a cloud card what the board decided, and that every prompt waits while it answers none", () => {
		const open = (command: string) => ({
			requestId: "r",
			toolUseId: null,
			toolName: "Bash",
			title: "Bash",
			input: { command },
		});
		const verdict = (p: { input: Record<string, unknown> }) =>
			p.input.command === "npm test"
				? { safe: true }
				: { safe: false, reason: "pushes to main" };
		assert.equal(
			waitingWhy(
				[open("npm test"), open("git push origin main")],
				verdict,
				true,
			),
			"Needs your yes: asks to use Bash, which pushes to main",
		);
		assert.equal(
			waitingWhy([open("npm test")], verdict, true),
			"Asks to use Bash, which the board allows as safe",
		);
		assert.equal(
			waitingWhy([open("npm test")], verdict, false),
			"Needs your yes: asks to use Bash",
		);
		assert.match(waitingWhy([], verdict, true), /cannot read/);
	});
});
