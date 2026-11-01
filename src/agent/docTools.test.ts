import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maxDocTextBytes } from "../shared/docPaths.ts";
import {
	docToolDefinitions,
	parseDocToolCall,
	parseDocToolInput,
} from "./docTools.ts";

const docToolNames = [
	"list_doc_stores",
	"search_docs",
	"list_docs",
	"read_doc",
	"write_doc",
	"delete_doc",
	"put_doc_asset",
	"create_doc_store",
	"rename_doc_store",
	"delete_doc_store",
];

describe("doc tool definitions", () => {
	it("are closed objects for every doc tool", () => {
		assert.deepEqual(
			docToolDefinitions.map((tool) => tool.name),
			docToolNames,
		);
		for (const tool of docToolDefinitions) {
			assert.equal(tool.inputSchema.type, "object");
			assert.equal(tool.inputSchema.additionalProperties, false);
			assert.ok(tool.description.length > 0);
		}
	});

	it("require a store for every tool that works in one", () => {
		for (const tool of docToolDefinitions) {
			if ("store" in tool.inputSchema.properties) {
				assert.equal(
					tool.inputSchema.required?.includes("store"),
					tool.name !== "search_docs",
					tool.name,
				);
			}
		}
	});

	it("say the docs are shared by every session", () => {
		const described = (name: string) =>
			docToolDefinitions.find((tool) => tool.name === name)?.description ?? "";
		assert.match(described("list_doc_stores"), /shared by every session/);
		assert.match(described("write_doc"), /read a page again/);
	});
});

describe("parseDocToolInput", () => {
	it("parses each tool", () => {
		assert.deepEqual(parseDocToolInput("list_doc_stores", undefined), {
			tool: "list_doc_stores",
		});
		assert.deepEqual(parseDocToolInput("list_docs", { store: "d1" }), {
			tool: "list_docs",
			store: "d1",
		});
		assert.deepEqual(
			parseDocToolInput("read_doc", { store: "API guide", path: "a/b.md" }),
			{ tool: "read_doc", store: "API guide", path: "a/b.md" },
		);
		assert.deepEqual(
			parseDocToolInput("write_doc", {
				store: "d1",
				path: "index.md",
				content: "",
			}),
			{ tool: "write_doc", store: "d1", path: "index.md", content: "" },
		);
		assert.deepEqual(
			parseDocToolInput("delete_doc", { store: "d1", path: "x.png" }),
			{ tool: "delete_doc", store: "d1", path: "x.png" },
		);
		assert.deepEqual(
			parseDocToolInput("put_doc_asset", {
				store: "d1",
				path: "assets/flow.png",
				file: "/tmp/flow.PNG",
			}),
			{
				tool: "put_doc_asset",
				store: "d1",
				path: "assets/flow.png",
				file: "/tmp/flow.PNG",
			},
		);
		assert.deepEqual(parseDocToolInput("search_docs", { query: " token " }), {
			tool: "search_docs",
			query: "token",
		});
		assert.deepEqual(
			parseDocToolInput("search_docs", { query: "token", store: "d1" }),
			{ tool: "search_docs", query: "token", store: "d1" },
		);
		assert.deepEqual(
			parseDocToolInput("create_doc_store", { title: " API guide " }),
			{ tool: "create_doc_store", title: "API guide" },
		);
		assert.deepEqual(
			parseDocToolInput("rename_doc_store", { store: "d1", title: "New" }),
			{ tool: "rename_doc_store", store: "d1", title: "New" },
		);
		assert.deepEqual(parseDocToolInput("delete_doc_store", { store: "d1" }), {
			tool: "delete_doc_store",
			store: "d1",
		});
	});

	it("refuses unknown and invalid arguments", () => {
		const refused = (name: string, args: unknown) =>
			assert.ok("error" in parseDocToolInput(name, args), name);
		for (const gone of [
			"find_doc_stores",
			"join_doc_store",
			"leave_doc_store",
			"share_doc_store",
		]) {
			refused(gone, { store: "d1" });
		}
		refused("nope", {});
		refused("list_docs", []);
		refused("list_docs", {});
		refused("list_docs", { store: 3 });
		refused("list_docs", { store: "x".repeat(65) });
		refused("read_doc", { path: "x.md" });
		refused("read_doc", { store: "d1" });
		refused("read_doc", { store: "d1", path: "../x.md" });
		refused("read_doc", { store: "d1", path: ".hidden.md" });
		refused("read_doc", { store: "d1", path: "x.md", extra: 1 });
		refused("write_doc", { store: "d1", path: "x.png", content: "" });
		refused("write_doc", { store: "d1", path: "x.md" });
		refused("write_doc", {
			store: "d1",
			path: "x.md",
			content: "é".repeat(maxDocTextBytes / 2 + 1),
		});
		refused("put_doc_asset", { store: "d1", path: "x.png", file: "rel.png" });
		refused("put_doc_asset", { store: "d1", path: "x.png", file: "/t/x.jpg" });
		refused("put_doc_asset", { store: "d1", path: "x.md", file: "/t/x.md" });
		refused("put_doc_asset", { store: "d1", path: "x.png", data: "AAAA" });
		refused("search_docs", {});
		refused("search_docs", { query: "  " });
		refused("search_docs", { query: "x".repeat(201) });
		refused("create_doc_store", { title: "a\nb" });
		refused("create_doc_store", { title: "x".repeat(61) });
		refused("rename_doc_store", { title: "New" });
		refused("delete_doc_store", {});
		assert.deepEqual(
			parseDocToolInput("read_doc", { store: "d1", path: "x.md", extra: 1 }),
			{ error: "Unknown argument extra" },
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
					store: "d1",
					path: "a.gif",
					file: "/tmp/a.gif",
				}),
		);
		assert.ok(
			"error" in
				parseDocToolCall("put_doc_asset", {
					store: "d1",
					path: "a.gif",
					data: "!!",
				}),
		);
		assert.deepEqual(
			parseDocToolCall("write_doc", {
				store: "d1",
				path: "a.md",
				content: "hi",
			}),
			{ tool: "write_doc", store: "d1", path: "a.md", content: "hi" },
		);
	});
});
