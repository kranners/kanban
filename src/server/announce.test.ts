import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Board, Session } from "../shared/types.ts";
import {
	announceRefusal,
	createAnnouncer,
	describeDeliveries,
} from "./announce.ts";
import type { AuditEvent } from "./audit.ts";

const session = (id: string, extra: Partial<Session> = {}): Session => ({
	id,
	short: `${id}0000000`.slice(0, 8),
	pid: 1,
	name: `name-${id}`,
	cwd: "/tmp",
	project: "tmp",
	kind: "background",
	activity: "working",
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

const boardOf = (sessions: Session[]): Board => ({
	sessions,
	subagents: [],
	subagentCounts: {},
	subagentStates: {},
	workflowRuns: {},
	workflows: [],
	links: [],
	messages: [],
	generatedAt: 0,
});

describe("announce", () => {
	it("refuses empty, oversized and command text", () => {
		assert.match(announceRefusal("  ") ?? "", /Type something/);
		assert.match(announceRefusal("/clear") ?? "", /cannot start with/);
		assert.match(announceRefusal("x".repeat(100_000)) ?? "", /at most/);
		assert.equal(announceRefusal("Pull main and rebase"), null);
	});

	it("types into every live session, working or not, and skips the rest", async () => {
		const events: AuditEvent[] = [];
		const typed: [string, string][] = [];
		const announce = createAnnouncer({
			board: () =>
				boardOf([
					session("a"),
					session("b", { activity: "idle", cloud: { url: "x" } }),
					session("c", { activity: "needs-you" }),
					session("d", { activity: "stopped" }),
					session("e", { kind: "interactive", cmux: false, activity: "idle" }),
					session("f", { kind: "interactive", cmux: true, activity: "idle" }),
				]),
			prompt: async (target, text) => {
				typed.push([target.id, text]);
				return target.id === "f"
					? { ok: false, error: "pane is gone" }
					: { ok: true };
			},
			audit: (event) => events.push(event),
		});
		const result = await announce("Pull main", "me@example.com");
		assert.ok(result.ok);
		assert.deepEqual(typed, [
			["a", "Pull main"],
			["b", "Pull main"],
			["f", "Pull main"],
		]);
		assert.deepEqual(
			result.deliveries.map(({ id, ok }) => [id, ok]),
			[
				["a", true],
				["b", true],
				["c", false],
				["e", false],
				["f", false],
			],
		);
		assert.equal(events.length, 5);
		assert.deepEqual(
			events.find(
				(event) => event.action === "announce" && event.sessionId === "a",
			),
			{
				action: "announce",
				sessionId: "a",
				chars: 9,
				identity: "me@example.com",
				result: "sent",
			},
		);
		assert.match(
			describeDeliveries(result.deliveries),
			/^Announced to 2 of 5 sessions\n- name-c: Waiting on a question/,
		);
	});

	it("says so when nothing is live", async () => {
		const announce = createAnnouncer({
			board: () => boardOf([session("a", { activity: "stopped" })]),
			prompt: async () => ({ ok: true }),
			audit: () => {},
		});
		assert.deepEqual(await announce("hi", null), {
			ok: false,
			error: "There are no live sessions to announce to",
		});
	});
});
