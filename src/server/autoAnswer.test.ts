import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "../shared/types.ts";
import type { AuditEvent } from "./audit.ts";
import { createAutoAnswer } from "./autoAnswer.ts";
import type { OpenPrompt } from "./boardTools.ts";

const session = (id: string, overrides: Partial<Session> = {}) =>
	({
		id,
		name: id,
		cwd: "/Users/me/dev/acme",
		activity: "needs-you",
		needs: "waiting",
		...overrides,
	}) as Session;

const prompt = (
	requestId: string,
	toolName: string,
	input: Record<string, unknown> = {},
): OpenPrompt => ({ requestId, toolName, title: toolName, input });

const harness = (sessions: Session[], open: Map<string, OpenPrompt[]>) => {
	const allowed: [string, string][] = [];
	const reads: string[] = [];
	const events: AuditEvent[] = [];
	const run = createAutoAnswer({
		sessions: () => sessions,
		approver: {
			open: async (s) => {
				reads.push(s.id);
				return { ok: true, value: open.get(s.id) ?? [] };
			},
			approve: async (s, p) => {
				allowed.push([s.id, p.requestId]);
				return { ok: true, value: null };
			},
		},
		audit: (event) => events.push(event),
	});
	return { run, allowed, reads, events };
};

describe("the board's automatic answer", () => {
	it("allows harmless prompts and leaves serious ones and questions for Aaron", async () => {
		const open = new Map([
			[
				"a",
				[
					prompt("spawn", "mcp__claude-code-remote__create_session"),
					prompt("push", "Bash", { command: "git push origin main" }),
					prompt("ask", "AskUserQuestion"),
					prompt("test", "Bash", { command: "npm test" }),
				],
			],
		]);
		const { run, allowed, events } = harness(
			[session("a"), session("b", { activity: "working" })],
			open,
		);
		await run();
		assert.deepEqual(allowed, [
			["a", "spawn"],
			["a", "test"],
		]);
		assert.deepEqual(
			events.map((event) => event.action === "prompt-approve" && event.via),
			["harmless", "harmless"],
		);
	});

	it("reads a waiting state left only for Aaron once, until it changes", async () => {
		const open = new Map([
			["a", [prompt("push", "Bash", { command: "git push -f" })]],
		]);
		const sessions = [session("a")];
		const { run, reads, allowed } = harness(sessions, open);
		await run();
		await run();
		assert.deepEqual(reads, ["a"]);
		sessions[0] = session("a", { needs: "something new" });
		open.set("a", [prompt("read", "Read", { file_path: "x" })]);
		await run();
		assert.deepEqual(reads, ["a", "a"]);
		assert.deepEqual(allowed, [["a", "read"]]);
	});
});
