import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maxDocTextBytes } from "../shared/docPaths.ts";
import {
	docToolDefinitions,
	parseDocToolCall,
	parseDocToolInput,
} from "./docTools.ts";

describe("doc tool definitions", () => {
	it("are closed objects for every doc tool", () => {
		assert.deepEqual(
			docToolDefinitions.map((tool) => tool.name),
			[
				"list_docs",
				"read_doc",
				"write_doc",
				"delete_doc",
				"put_doc_asset",
				"find_doc_stores",
				"create_doc_store",
				"join_doc_store",
				"leave_doc_store",
				"share_doc_store",
			],
		);
		for (const tool of docToolDefinitions) {
			assert.equal(tool.inputSchema.type, "object");
			assert.equal(tool.inputSchema.additionalProperties, false);
			assert.ok(tool.description.length > 0);
		}
	});
});

describe("parseDocToolInput", () => {
	it("parses each tool", () => {
		assert.deepEqual(parseDocToolInput("list_docs", undefined), {
			tool: "list_docs",
		});
		assert.deepEqual(parseDocToolInput("list_docs", { store: "d1" }), {
			tool: "list_docs",
			store: "d1",
		});
		assert.deepEqual(parseDocToolInput("read_doc", { path: "a/b.md" }), {
			tool: "read_doc",
			path: "a/b.md",
		});
		assert.deepEqual(
			parseDocToolInput("write_doc", {
				store: "d1",
				path: "index.md",
				content: "",
			}),
			{ tool: "write_doc", store: "d1", path: "index.md", content: "" },
		);
		assert.deepEqual(parseDocToolInput("delete_doc", { path: "x.png" }), {
			tool: "delete_doc",
			path: "x.png",
		});
		assert.deepEqual(
			parseDocToolInput("put_doc_asset", {
				path: "assets/flow.png",
				file: "/tmp/flow.PNG",
			}),
			{ tool: "put_doc_asset", path: "assets/flow.png", file: "/tmp/flow.PNG" },
		);
	});

	it("refuses unknown and invalid arguments", () => {
		const refused = (name: string, args: unknown) =>
			assert.ok("error" in parseDocToolInput(name, args), name);
		refused("nope", {});
		refused("list_docs", []);
		refused("list_docs", { store: 3 });
		refused("read_doc", {});
		refused("read_doc", { path: "../x.md" });
		refused("read_doc", { path: ".hidden.md" });
		refused("read_doc", { path: "x.md", extra: 1 });
		refused("write_doc", { path: "x.png", content: "" });
		refused("write_doc", { path: "x.md" });
		refused("write_doc", {
			path: "x.md",
			content: "é".repeat(maxDocTextBytes / 2 + 1),
		});
		refused("put_doc_asset", { path: "x.png", file: "relative.png" });
		refused("put_doc_asset", { path: "x.png", file: "/tmp/x.jpg" });
		refused("put_doc_asset", { path: "x.md", file: "/tmp/x.md" });
		refused("put_doc_asset", { path: "x.png", data: "AAAA" });
		assert.deepEqual(
			parseDocToolInput("read_doc", { path: "x.md", extra: 1 }),
			{
				error: "Unknown argument extra",
			},
		);
	});
});

describe("parseDocToolCall", () => {
	it("takes base64 data for assets", () => {
		assert.deepEqual(
			parseDocToolCall("put_doc_asset", {
				store: "d1",
				path: "a.gif",
				data: "R0lG",
			}),
			{ tool: "put_doc_asset", store: "d1", path: "a.gif", data: "R0lG" },
		);
		assert.ok(
			"error" in
				parseDocToolCall("put_doc_asset", {
					path: "a.gif",
					file: "/tmp/a.gif",
				}),
		);
		assert.ok(
			"error" in
				parseDocToolCall("put_doc_asset", { path: "a.gif", data: "!!" }),
		);
		assert.deepEqual(
			parseDocToolCall("write_doc", { path: "a.md", content: "hi" }),
			{ tool: "write_doc", path: "a.md", content: "hi" },
		);
	});
});
