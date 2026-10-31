import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleMessage } from "./mcp.ts";
import { parseToolCall, toolDefinitions } from "./tools.ts";

describe("tool definitions", () => {
	it("are closed object schemas whose required fields exist", () => {
		const names = toolDefinitions.map((tool) => tool.name);
		assert.equal(new Set(names).size, names.length);
		for (const tool of toolDefinitions) {
			assert.match(tool.name, /^[a-z_]+$/);
			assert.ok(tool.description.length > 20, tool.name);
			assert.equal(tool.inputSchema.type, "object");
			assert.equal(tool.inputSchema.additionalProperties, false);
			for (const field of tool.inputSchema.required ?? []) {
				assert.ok(
					field in tool.inputSchema.properties,
					`${tool.name}.${field}`,
				);
			}
		}
	});

	it("accept every tool with minimal arguments", () => {
		const minimal: Record<string, unknown> = {
			board_snapshot: {},
			read_transcript: { session: "abcd1234" },
			ask_session: { session: "abcd1234", question: "What changed?" },
			send_prompt: { session: "abcd1234", text: "carry on" },
			announce: { text: "pull main" },
			answer_prompt: { session: "abcd1234" },
			finish_session: { session: "abcd1234" },
			start_session: { cwd: "/tmp", prompt: "hi" },
			put_note: { text: "# Hi", x: 0, y: 0 },
			put_sticker: { sticker: "check", x: 0, y: 0 },
			delete_annotations: { ids: ["n-1"] },
			find_stickers: {},
			arrange: { cards: [{ id: "abcd1234", x: 0, y: 0 }] },
			create_region: { cwd: "/tmp", x: 0, y: 0, w: 480, h: 336 },
			update_region: { id: "r-1", name: "Acme" },
			delete_region: { id: "r-1" },
		};
		for (const tool of toolDefinitions) {
			const call = parseToolCall(tool.name, minimal[tool.name]);
			assert.ok(!("error" in call), `${tool.name}: ${JSON.stringify(call)}`);
			assert.equal(call.tool, tool.name);
		}
	});
});

describe("parseToolCall", () => {
	const error = (name: string, args: unknown) => {
		const call = parseToolCall(name, args);
		return "error" in call ? call.error : null;
	};

	it("rejects unknown tools and arguments", () => {
		assert.equal(error("rm_rf", {}), "Unknown tool rm_rf");
		assert.equal(
			error("board_snapshot", { force: true }),
			"Unknown argument force",
		);
		assert.equal(
			error("finish_session", { session: "a", force: true }),
			"Unknown argument force",
		);
		assert.equal(error("board_snapshot", []), "Arguments must be an object");
	});

	it("checks types, ranges and pairs", () => {
		assert.match(
			error("read_transcript", { session: "a", limit: 500 }) ?? "",
			/limit/,
		);
		assert.match(
			error("read_transcript", { session: "a", limit: 2.5 }) ?? "",
			/integer/,
		);
		assert.match(
			error("ask_session", { session: "", question: "q" }) ?? "",
			/session/,
		);
		assert.match(
			error("send_prompt", { session: "a", text: "x".repeat(8001) }) ?? "",
			/8000/,
		);
		assert.match(
			error("start_session", { cwd: "/tmp", prompt: "p", x: 1 }) ?? "",
			/together/,
		);
		assert.match(
			error("put_note", { text: "no place" }) ?? "",
			/needs text, x and y/,
		);
		assert.match(error("put_note", { id: "n", color: "teal" }) ?? "", /color/);
		assert.match(
			error("put_note", { text: "t", x: Number.NaN, y: 0 }) ?? "",
			/finite/,
		);
		assert.match(
			error("put_sticker", { sticker: "check", x: 0 }) ?? "",
			/sticker, x and y/,
		);
		assert.match(error("delete_annotations", { ids: [] }) ?? "", /1 to 100/);
		assert.match(error("arrange", {}) ?? "", /Nothing to arrange/);
		assert.match(
			error("arrange", { cards: [{ id: "a", x: 0 }] }) ?? "",
			/y must/,
		);
		assert.match(
			error("arrange", { regions: [{ id: "r", x: 0, y: 0, w: 10, h: 200 }] }) ??
				"",
			/w must/,
		);
		assert.match(
			error("create_region", {
				cwd: "/tmp",
				x: 0,
				y: 0,
				w: 480,
				h: 336,
				colour: "mauve",
			}) ?? "",
			/colour/,
		);
		assert.match(error("update_region", { id: "r", x: 0 }) ?? "", /together/);
		assert.match(
			error("update_region", { id: "r" }) ?? "",
			/Nothing to change/,
		);
	});

	it("reads a prompt without answers and answers it with labels or free text", () => {
		assert.deepEqual(parseToolCall("answer_prompt", { session: "a" }), {
			tool: "answer_prompt",
			session: "a",
			reply: null,
		});
		assert.deepEqual(
			parseToolCall("answer_prompt", {
				session: "a",
				prompt: "0123abcd4567",
				answers: [{ selected: ["Yes, test then full"] }, { other: "Blue" }],
			}),
			{
				tool: "answer_prompt",
				session: "a",
				reply: {
					prompt: "0123abcd4567",
					answers: [
						{ selected: ["Yes, test then full"], other: null },
						{ selected: [], other: "Blue" },
					],
				},
			},
		);
		assert.match(
			error("answer_prompt", {
				session: "a",
				answers: [{ selected: ["Yes"] }],
			}) ?? "",
			/read the prompt first/,
		);
		assert.match(
			error("answer_prompt", { session: "a", prompt: "0123abcd4567" }) ?? "",
			/go together/,
		);
		assert.match(
			error("answer_prompt", { session: "a", prompt: "p", answers: [] }) ?? "",
			/1 to 8/,
		);
		assert.match(
			error("answer_prompt", { session: "a", prompt: "p", answers: [{}] }) ??
				"",
			/selected or other/,
		);
		assert.match(
			error("answer_prompt", {
				session: "a",
				prompt: "p",
				answers: [{ selected: "Yes" }],
			}) ?? "",
			/option labels/,
		);
		assert.match(
			error("answer_prompt", {
				session: "a",
				prompt: "p",
				answers: [{ selected: ["Yes"], force: true }],
			}) ?? "",
			/Unknown answer field force/,
		);
	});

	it("keeps only given optional fields and allows clearing a colour", () => {
		assert.deepEqual(
			parseToolCall("update_region", { id: "r", colour: null }),
			{
				tool: "update_region",
				id: "r",
				colour: null,
			},
		);
		assert.deepEqual(
			parseToolCall("put_note", { id: "n", text: "- [x] done" }),
			{
				tool: "put_note",
				id: "n",
				text: "- [x] done",
			},
		);
		assert.deepEqual(parseToolCall("read_transcript", { session: "a" }), {
			tool: "read_transcript",
			session: "a",
			limit: 40,
		});
	});
});

describe("MCP server", () => {
	const calls: [string, unknown][] = [];
	const call = async (name: string, args: unknown) => {
		calls.push([name, args]);
		return { text: `did ${name}`, isError: false };
	};

	it("initialises, lists tools and answers pings", async () => {
		assert.deepEqual(
			await handleMessage(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-06-18" },
				},
				call,
			),
			{
				jsonrpc: "2.0",
				id: 1,
				result: {
					protocolVersion: "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "kanban", version: "1.0.0" },
				},
			},
		);
		const listed = (await handleMessage(
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			call,
		)) as {
			result: { tools: unknown[] };
		};
		assert.equal(listed.result.tools.length, toolDefinitions.length);
		assert.equal(
			await handleMessage(
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				call,
			),
			null,
		);
		assert.deepEqual(
			await handleMessage({ jsonrpc: "2.0", id: 3, method: "ping" }, call),
			{
				jsonrpc: "2.0",
				id: 3,
				result: {},
			},
		);
		assert.deepEqual(
			await handleMessage({ jsonrpc: "2.0", id: 4, method: "nope" }, call),
			{
				jsonrpc: "2.0",
				id: 4,
				error: { code: -32601, message: "Method not found: nope" },
			},
		);
	});

	it("forwards valid calls to the board and refuses invalid ones locally", async () => {
		assert.deepEqual(
			await handleMessage(
				{
					jsonrpc: "2.0",
					id: 5,
					method: "tools/call",
					params: {
						name: "finish_session",
						arguments: { session: "abcd1234" },
					},
				},
				call,
			),
			{
				jsonrpc: "2.0",
				id: 5,
				result: {
					content: [{ type: "text", text: "did finish_session" }],
					isError: false,
				},
			},
		);
		assert.deepEqual(
			await handleMessage(
				{
					jsonrpc: "2.0",
					id: 6,
					method: "tools/call",
					params: {
						name: "finish_session",
						arguments: { session: "a", force: true },
					},
				},
				call,
			),
			{
				jsonrpc: "2.0",
				id: 6,
				result: {
					content: [{ type: "text", text: "Unknown argument force" }],
					isError: true,
				},
			},
		);
		assert.deepEqual(calls, [["finish_session", { session: "abcd1234" }]]);
	});
});
