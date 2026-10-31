import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { handleMessage } from "./mcp.ts";
import { docServer, docsCaller } from "./sessionMcp.ts";

type Sent = { url: string; headers: Record<string, string>; body: unknown };

const recorder = () => {
	const sent: Sent[] = [];
	const send = (async (url: string, init: RequestInit) => {
		sent.push({
			url,
			headers: init.headers as Record<string, string>,
			body: JSON.parse(String(init.body)),
		});
		return Response.json({ ok: true, text: "done" });
	}) as typeof fetch;
	return { sent, call: docsCaller("http://127.0.0.1:9", "sess-1", send) };
};

const callTool = (
	call: ReturnType<typeof recorder>["call"],
	name: string,
	args: unknown,
) =>
	handleMessage(
		{
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		},
		call,
		docServer,
	) as Promise<{ result: { content: { text: string }[]; isError: boolean } }>;

describe("session mcp", () => {
	it("lists the five doc tools under the name kanban", async () => {
		const { call } = recorder();
		const initialised = (await handleMessage(
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
			call,
			docServer,
		)) as { result: { serverInfo: { name: string } } };
		assert.equal(initialised.result.serverInfo.name, "kanban");
		const listed = (await handleMessage(
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			call,
			docServer,
		)) as { result: { tools: { name: string }[] } };
		assert.deepEqual(
			listed.result.tools.map((tool) => tool.name),
			["list_docs", "read_doc", "write_doc", "delete_doc", "put_doc_asset"],
		);
	});

	it("posts tool calls with the session header", async () => {
		const { sent, call } = recorder();
		const reply = await callTool(call, "write_doc", {
			path: "index.md",
			content: "# Hi",
		});
		assert.equal(reply.result.isError, false);
		assert.deepEqual(sent, [
			{
				url: "http://127.0.0.1:9/api/docs/tools/write_doc",
				headers: {
					"x-kanban-session": "sess-1",
					"content-type": "application/json",
				},
				body: { path: "index.md", content: "# Hi" },
			},
		]);
	});

	it("reads an asset and posts it as base64", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-asset-"));
		const file = join(dir, "flow.png");
		await writeFile(file, Buffer.from([137, 80, 78, 71]));
		const { sent, call } = recorder();
		const reply = await callTool(call, "put_doc_asset", {
			store: "d1",
			path: "assets/flow.png",
			file,
		});
		assert.equal(reply.result.isError, false);
		assert.deepEqual(
			sent.map((request) => request.body),
			[{ store: "d1", path: "assets/flow.png", data: "iVBORw==" }],
		);
	});

	it("refuses a mismatched extension or a missing file without sending", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-asset-"));
		const file = join(dir, "flow.jpg");
		await writeFile(file, "x");
		const { sent, call } = recorder();
		const mismatched = await callTool(call, "put_doc_asset", {
			path: "assets/flow.png",
			file,
		});
		assert.equal(mismatched.result.isError, true);
		const missing = await callTool(call, "put_doc_asset", {
			path: "assets/flow.png",
			file: join(dir, "gone.png"),
		});
		assert.equal(missing.result.isError, true);
		assert.match(missing.result.content[0]?.text ?? "", /isn't a file/);
		await mkdir(join(dir, "folder.png"));
		const folder = await callTool(call, "put_doc_asset", {
			path: "assets/x.png",
			file: join(dir, "folder.png"),
		});
		assert.equal(folder.result.isError, true);
		assert.deepEqual(sent, []);
	});
});
