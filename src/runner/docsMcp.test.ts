import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	docsMcpFlag,
	runnerDocsArgs,
	runnerDocsCaller,
	runnerDocsEndpoint,
} from "./docsMcp.ts";

describe("runner docs", () => {
	it("hands each session the board's doc tools, pre-approved, without the token", () => {
		const args = runnerDocsArgs(
			"/usr/bin/node",
			"/cache/runner.js",
			"https://board.example",
		);
		assert.equal(args.length, 2);
		assert.equal(args[1], "--allowedTools=mcp__kanban");
		const config = JSON.parse(
			(args[0] ?? "").slice("--mcp-config=".length),
		) as {
			mcpServers: Record<
				string,
				{ command: string; args: string[]; env: object }
			>;
		};
		assert.deepEqual(config.mcpServers.kanban, {
			type: "stdio",
			command: "/usr/bin/node",
			args: ["/cache/runner.js", docsMcpFlag],
			env: { KANBAN_RUNNER_HUB: "https://board.example" },
		});
		assert.doesNotMatch(args.join(" "), /Bearer|TOKEN=/);
	});

	it("posts each tool to the hub with the runner token and the session", async () => {
		const sent: { url: string; init: RequestInit }[] = [];
		const send = (async (url: string, init: RequestInit) => {
			sent.push({ url, init });
			return new Response(JSON.stringify({ ok: true, text: "2 stores" }), {
				status: 200,
			});
		}) as typeof fetch;
		const call = runnerDocsCaller(
			"https://board.example/",
			"t".repeat(40),
			"sess-1",
			send,
		);
		assert.deepEqual(await call("list_doc_stores", {}), {
			text: "2 stores",
			isError: false,
		});
		assert.equal(
			sent[0]?.url,
			"https://board.example/api/runners/docs/list_doc_stores",
		);
		const headers = sent[0]?.init.headers as Record<string, string>;
		assert.equal(headers.authorization, `Bearer ${"t".repeat(40)}`);
		assert.equal(headers["x-kanban-session"], "sess-1");
		assert.equal(
			runnerDocsEndpoint("https://board.example"),
			"https://board.example/api/runners/docs",
		);
	});

	it("says plainly when the hub refuses the token", async () => {
		const send = (async () =>
			new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
			})) as typeof fetch;
		const reply = await runnerDocsCaller(
			"https://board.example",
			"t".repeat(40),
			"sess-1",
			send,
		)("list_doc_stores", {});
		assert.equal(reply.isError, true);
		assert.equal(reply.text, "Forbidden");
	});
});
