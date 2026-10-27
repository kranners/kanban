import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lineSplitter, parseStreamLine } from "./agentStream.ts";

const line = (value: object) => JSON.stringify(value);

describe("parseStreamLine", () => {
	it("reads the session id from init", () => {
		assert.deepEqual(
			parseStreamLine(
				line({ type: "system", subtype: "init", session_id: "s-1", tools: [] }),
			),
			[{ kind: "init", sessionId: "s-1" }],
		);
		assert.deepEqual(
			parseStreamLine(line({ type: "system", subtype: "hook" })),
			[],
		);
	});

	it("turns assistant blocks into text and tool starts, skipping thinking", () => {
		assert.deepEqual(
			parseStreamLine(
				line({
					type: "assistant",
					message: {
						content: [
							{ type: "thinking", thinking: "" },
							{ type: "text", text: "  On it.  " },
							{
								type: "tool_use",
								id: "t1",
								name: "mcp__kanban__arrange",
								input: { cards: [] },
							},
						],
					},
				}),
			),
			[
				{ kind: "text", text: "On it." },
				{
					kind: "tool-start",
					id: "t1",
					name: "mcp__kanban__arrange",
					input: { cards: [] },
				},
			],
		);
	});

	it("turns tool results into tool ends, joining text content", () => {
		assert.deepEqual(
			parseStreamLine(
				line({
					type: "user",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "t1",
								content: [{ type: "text", text: "Moved 6 cards" }],
							},
							{
								type: "tool_result",
								tool_use_id: "t2",
								content: "No region r",
								is_error: true,
							},
						],
					},
				}),
			),
			[
				{ kind: "tool-end", id: "t1", text: "Moved 6 cards", isError: false },
				{ kind: "tool-end", id: "t2", text: "No region r", isError: true },
			],
		);
	});

	it("reports the result and its errors", () => {
		assert.deepEqual(
			parseStreamLine(
				line({
					type: "result",
					subtype: "success",
					is_error: false,
					result: "Done",
				}),
			),
			[{ kind: "result", isError: false, text: "Done" }],
		);
		assert.deepEqual(
			parseStreamLine(line({ type: "result", subtype: "error_max_turns" })),
			[{ kind: "result", isError: true, text: "" }],
		);
	});

	it("ignores noise", () => {
		assert.deepEqual(parseStreamLine("not json"), []);
		assert.deepEqual(parseStreamLine(line({ type: "rate_limit_event" })), []);
	});
});

describe("lineSplitter", () => {
	it("emits whole lines across chunks", () => {
		const lines: string[] = [];
		const split = lineSplitter((text) => lines.push(text));
		split.push('{"a":');
		split.push('1}\n{"b"');
		split.push(":2}\n\n");
		split.push('{"c":3}');
		assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
		split.flush();
		assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
	});
});
