import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "../shared/types.ts";
import type { AuditEvent } from "./audit.ts";
import { createAutoAnswer, permissionsMode } from "./autoAnswer.ts";
import type { OpenPrompt } from "./boardTools.ts";
import { effectWhy } from "./cloud.ts";

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
			events.map((event) => event.action === "prompt-approve" && event.via),
			["safe set", "safe set"],
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

	it("says on a cloud card what the board allows and what it leaves for Aaron", () => {
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
			effectWhy([open("npm test"), open("git push origin main")], verdict),
			"Needs your yes: asks to use Bash, which pushes to main",
		);
		assert.equal(
			effectWhy([open("npm test")], verdict),
			"Asks to use Bash, which the board allows as safe",
		);
		assert.equal(effectWhy([], verdict), null);
	});
});
