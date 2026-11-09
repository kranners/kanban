import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cloudSubagents } from "./cloudAgents.ts";
import { applyRecord, createFacts } from "./records.ts";

const at = (minute: number) =>
	`2026-11-09T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ms = (minute: number) => Date.parse(at(minute));

const agentCall = (id: string, description: string, parent?: string) => ({
	type: "assistant",
	...(parent ? { parent_tool_use_id: parent } : {}),
	message: {
		content: [
			{
				type: "tool_use",
				id,
				name: "Agent",
				input: { description, subagent_type: "general-purpose", prompt: "go" },
			},
		],
	},
});

const agentResult = (id: string, parent?: string) => ({
	type: "user",
	...(parent ? { parent_tool_use_id: parent } : {}),
	message: {
		content: [{ type: "tool_result", tool_use_id: id, content: "done" }],
	},
});

const said = (parent: string) => ({
	type: "assistant",
	parent_tool_use_id: parent,
	message: { content: [{ type: "text", text: "working on it" }] },
});

/** A cloud session's mirrored transcript: two subagents, the first running two of its own, one of which runs one more. */
function nestedTranscript() {
	const facts = createFacts();
	const records: [number, object][] = [
		[0, agentCall("top-a", "Merge main into the PRs")],
		[0, agentCall("top-b", "Release the collector")],
		[1, agentCall("child-a1", "Fix the first conflict", "top-a")],
		[1, agentCall("child-a2", "Fix the second conflict", "top-a")],
		[2, agentCall("grand-a2", "Run the slow tests", "child-a2")],
		[3, said("grand-a2")],
		[4, agentResult("child-a1", "top-a")],
		[5, agentResult("top-b")],
	];
	for (const [minute, record] of records) {
		applyRecord(facts, { timestamp: at(minute), ...record }, () => null);
	}
	return facts;
}

describe("cloud subagents", () => {
	test("a subagent's own subagents are nested under it, at every depth", () => {
		const subagents = cloudSubagents(
			"session_x",
			nestedTranscript(),
			"working",
			ms(6),
		);
		const byId = new Map(subagents.map((s) => [s.id, s]));
		assert.deepEqual([...byId.keys()].sort(), [
			"child-a1",
			"child-a2",
			"grand-a2",
			"top-a",
			"top-b",
		]);
		assert.equal(byId.get("top-a")?.parentAgentId, null);
		assert.equal(byId.get("child-a1")?.parentAgentId, "top-a");
		assert.equal(byId.get("child-a2")?.parentAgentId, "top-a");
		assert.equal(byId.get("grand-a2")?.parentAgentId, "child-a2");
		assert.equal(byId.get("child-a1")?.done, true);
		assert.equal(byId.get("top-b")?.done, true);
		assert.equal(byId.get("grand-a2")?.done, false);
		assert.equal(byId.get("grand-a2")?.updatedAt, ms(3));
	});

	test("a finished subagent stays an hour after it ended, then leaves", () => {
		const facts = nestedTranscript();
		const at50 = cloudSubagents("session_x", facts, "idle", ms(50));
		assert.ok(at50.some((s) => s.id === "top-b" && s.done));
		const later = cloudSubagents(
			"session_x",
			facts,
			"idle",
			ms(5) + 61 * 60_000,
		);
		assert.ok(!later.some((s) => s.id === "top-b"));
		// One that never reported back stays, idle, while the session is on the board.
		assert.ok(later.some((s) => s.id === "grand-a2" && !s.done && !s.live));
	});

	test("once the session ends its subagents count as ended then, not when they last wrote", () => {
		const facts = nestedTranscript();
		applyRecord(
			facts,
			{
				timestamp: at(40),
				type: "assistant",
				message: { content: [{ type: "text", text: "all done" }] },
			},
			() => null,
		);
		const ended = cloudSubagents(
			"session_x",
			facts,
			"done",
			ms(40) + 59 * 60_000,
		);
		const grand = ended.find((s) => s.id === "grand-a2");
		assert.equal(grand?.done, true);
		assert.equal(grand?.updatedAt, ms(40));
		assert.equal(
			cloudSubagents("session_x", facts, "done", ms(40) + 61 * 60_000).some(
				(s) => s.id === "grand-a2",
			),
			false,
		);
	});
});
