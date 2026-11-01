import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { DocStore } from "../shared/types.ts";
import { createDocStoreRegistry, type DocStoreRegistry } from "./docStores.ts";
import { type DocFiles, loadDocFiles } from "./docs.ts";
import {
	createDocsHttp,
	type DocsHttp,
	describeIndex,
	maxSearchLines,
	sessionMcpConfig,
} from "./docsHttp.ts";
import { matchRoute } from "./http.ts";

const store = (id: string, title: string): DocStore => ({
	id,
	title,
	createdAt: 0,
	updatedAt: 0,
});

describe("docs http", () => {
	let base = "";
	let files: DocFiles;
	let stores: DocStoreRegistry;
	let docs: DocsHttp;
	let ids = 0;
	const server = createServer();

	const reset = async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-docs-http-"));
		files = await loadDocFiles({ dir: join(dir, "docs"), onChange: () => {} });
		stores = createDocStoreRegistry({
			file: join(dir, "doc-stores.json"),
			initial: [store("d1", "Setup"), store("d2", "Design")],
			files,
			onChange: () => {},
			newId: () => `new${++ids}`,
			now: () => 1000,
		});
		docs = createDocsHttp({ files, stores });
	};

	before(async () => {
		server.on("request", async (req, res) => {
			const route = matchRoute(
				req.method ?? "GET",
				new URL(req.url ?? "/", "http://x"),
			);
			if (route.kind === "docs-tool") return docs.tool(req, res, route.tool);
			if (route.kind === "doc-file") {
				return docs.file(req, res, route.store, route.path);
			}
			res.writeHead(404).end();
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(() => server.close());

	beforeEach(reset);

	const tool = (
		name: string,
		body: unknown,
		headers: Record<string, string> = { "x-kanban-session": "s1" },
	) =>
		fetch(`${base}/api/docs/tools/${name}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});

	const answer = async (response: Response) => ({
		status: response.status,
		body: (await response.json()) as {
			ok?: boolean;
			text?: string;
			error?: string;
		},
	});

	const text = async (name: string, body: unknown) =>
		(await answer(await tool(name, body))).body.text ?? "";

	it("guards the tool route", async () => {
		assert.equal(
			(
				await tool(
					"list_doc_stores",
					{},
					{ "x-kanban-session": "s1", origin: base },
				)
			).status,
			403,
		);
		assert.equal(
			(
				await tool(
					"list_doc_stores",
					{},
					{ "x-kanban-session": "s1", "cf-ray": "x" },
				)
			).status,
			403,
		);
		assert.equal((await tool("list_doc_stores", {}, {})).status, 401);
		assert.equal(
			(await tool("list_doc_stores", {}, { "x-kanban-session": "bad id" }))
				.status,
			401,
		);
		const plain = await fetch(`${base}/api/docs/tools/list_doc_stores`, {
			method: "POST",
			headers: { "x-kanban-session": "s1", "content-type": "text/plain" },
			body: "{}",
		});
		assert.equal(plain.status, 415);
		assert.deepEqual(
			await answer(await tool("read_doc", { store: "d1", path: "x.md", x: 1 })),
			{ status: 400, body: { ok: false, error: "Unknown argument x" } },
		);
		for (const gone of [
			"find_doc_stores",
			"join_doc_store",
			"share_doc_store",
		]) {
			assert.equal((await tool(gone, { store: "d1" })).status, 400, gone);
		}
	});

	it("lets any session, on the board or not, use any store", async () => {
		for (const session of ["s1", "someone-else"]) {
			const written = await answer(
				await tool(
					"write_doc",
					{ store: "d2", path: `${session}.md`, content: "hi" },
					{ "x-kanban-session": session },
				),
			);
			assert.equal(written.status, 200, session);
		}
		assert.match(
			await text("list_docs", { store: "d2" }),
			/s1\.md[\s\S]*someone-else\.md/,
		);
	});

	it("resolves a store by id or exact title, ignoring case", async () => {
		await tool("write_doc", { store: "setup", path: "a.md", content: "A" });
		assert.equal(await text("read_doc", { store: "d1", path: "a.md" }), "A");
		assert.equal(
			await text("read_doc", { store: " SETUP ", path: "a.md" }),
			"A",
		);
		const unknown = await answer(await tool("list_docs", { store: "nope" }));
		assert.equal(unknown.status, 422);
		assert.match(
			unknown.body.error ?? "",
			/^No doc store nope\..*list_doc_stores/,
		);
		stores.create("setup");
		const ambiguous = await answer(await tool("list_docs", { store: "Setup" }));
		assert.equal(ambiguous.status, 422);
		assert.match(
			ambiguous.body.error ?? "",
			/Several doc stores are titled "Setup", so give its id: (d1, new\d+|new\d+, d1)/,
		);
		assert.equal(
			(await answer(await tool("list_docs", { store: "d1" }))).status,
			200,
		);
	});

	it("writes, lists, reads and deletes docs and bumps the store", async () => {
		const written = await answer(
			await tool("write_doc", {
				store: "d1",
				path: "guides/setup.md",
				content: "# Setup",
			}),
		);
		assert.deepEqual(written, {
			status: 200,
			body: {
				ok: true,
				text: 'Wrote guides/setup.md in "Setup" (d1) (7 bytes)',
			},
		});
		assert.equal(stores.get("d1")?.updatedAt, 1000);
		const listed = await text("list_docs", { store: "d1" });
		assert.match(
			listed,
			/^Files in "Setup" \(d1\):\n- guides\/setup\.md \(7 bytes, \d{4}-/,
		);
		assert.match(
			await text("list_docs", { store: "d2" }),
			/is empty\. Start it with an index\.md/,
		);
		assert.equal(
			await text("read_doc", { store: "d1", path: "guides/setup.md" }),
			"# Setup",
		);
		assert.equal(
			(await tool("read_doc", { store: "d1", path: "nope.md" })).status,
			422,
		);
		assert.equal(
			(await tool("delete_doc", { store: "d1", path: "guides/setup.md" }))
				.status,
			200,
		);
		assert.equal(
			(await tool("delete_doc", { store: "d1", path: "guides/setup.md" }))
				.status,
			422,
		);
	});

	it("lists every store with its count, update time and index line", async () => {
		await tool("write_doc", {
			store: "d1",
			path: "index.md",
			content: "\n\n## How to set up   the API\n\nMore.",
		});
		await tool("write_doc", { store: "d1", path: "b.md", content: "B" });
		assert.match(
			await text("list_doc_stores", {}),
			/^Doc stores shared by every session on the board:\n- "Design" \(d2\): 0 files, updated 1970-01-01T00:00:00\.000Z\n- "Setup" \(d1\): 2 files, updated \d{4}-[^ ]+ · How to set up the API$/,
		);
		await stores.remove("d1");
		await stores.remove("d2");
		assert.match(
			await text("list_doc_stores", {}),
			/^There are no doc stores yet\. .*create_doc_store/,
		);
	});

	it("describes a store by its index's first heading or line", () => {
		assert.equal(describeIndex("# Title\nbody"), "Title");
		assert.equal(
			describeIndex("\n  plain first line \n# Later"),
			"plain first line",
		);
		assert.equal(describeIndex("\n\n"), null);
		assert.equal(describeIndex(`# ${"x".repeat(200)}`)?.length, 120);
	});

	it("searches text pages, titles and paths across stores, ranked by matches", async () => {
		await tool("write_doc", {
			store: "d1",
			path: "auth.md",
			content:
				"Tokens expire.\nRefresh the token daily.\nno match\nTOKEN rotation\ntoken four",
		});
		await tool("write_doc", {
			store: "d2",
			path: "notes/token-flow.md",
			content: "The flow of a token.",
		});
		await tool("put_doc_asset", {
			store: "d2",
			path: "token.png",
			data: "iVBORw==",
		});
		const found = await text("search_docs", { query: "token" });
		const lines = found.split("\n");
		assert.equal(lines[0], "5 matching lines in 3 files, most matches first:");
		assert.equal(lines[1], '- "Setup" (d1) auth.md: 4 matches');
		assert.deepEqual(lines.slice(2, 5), [
			"  1: Tokens expire.",
			"  2: Refresh the token daily.",
			"  4: TOKEN rotation",
		]);
		assert.equal(lines[5], '- "Design" (d2) notes/token-flow.md: 1 match');
		assert.equal(lines[7], '- "Design" (d2) token.png: path matches');
		assert.match(found, /\[Results capped at 40 lines and 3 per file/);

		const titled = await text("search_docs", { query: "desi" });
		assert.equal(titled, 'Doc stores whose title matches: "Design" (d2)');
		const words = await text("search_docs", { query: "refresh daily" });
		assert.match(words, /^1 matching line in 1 file/);
		const scoped = await text("search_docs", {
			query: "token",
			store: "Design",
		});
		assert.doesNotMatch(scoped, /auth\.md/);
		assert.match(
			await text("search_docs", { query: "zebra" }),
			/^Nothing matches "zebra" in any doc store\./,
		);
		assert.equal(
			(await tool("search_docs", { query: "x", store: "nope" })).status,
			422,
		);
	});

	it("caps search results at 40 lines", async () => {
		for (let n = 0; n < 20; n++) {
			await tool("write_doc", {
				store: "d1",
				path: `p${n}.md`,
				content: "needle\nneedle\nneedle\nneedle",
			});
		}
		const found = await text("search_docs", { query: "needle" });
		assert.equal(
			found.split("\n").filter((line) => /^ {2}\d+: /.test(line)).length,
			maxSearchLines,
		);
		assert.match(found, /Results capped/);
	});

	it("creates, renames and deletes stores", async () => {
		const made = await text("create_doc_store", { title: "  API notes " });
		assert.match(
			made,
			/^Made the doc store "API notes" \(new\d+\), shared with every session.*index\.md/,
		);
		const id = /\((new\d+)\)/.exec(made)?.[1] ?? "";
		assert.equal(stores.get(id)?.title, "API notes");
		assert.equal(
			await text("rename_doc_store", {
				store: "api NOTES",
				title: "API reference",
			}),
			`Renamed ${id} to "API reference".`,
		);
		await tool("write_doc", { store: id, path: "a.md", content: "A" });
		await tool("write_doc", { store: id, path: "b.md", content: "B" });
		assert.equal(
			await text("delete_doc_store", { store: id }),
			`Deleted the doc store "API reference" (${id}) and its 2 files.`,
		);
		assert.equal(stores.get(id), null);
		assert.equal(files.index()[id], undefined);
		assert.equal((await tool("delete_doc_store", { store: id })).status, 422);
	});

	it("saves a base64 asset and serves files with safe headers", async () => {
		const saved = await answer(
			await tool("put_doc_asset", {
				store: "d1",
				path: "assets/dot.png",
				data: "iVBORw==",
			}),
		);
		assert.equal(saved.status, 200);
		assert.match(
			saved.body.text ?? "",
			/^Saved assets\/dot\.png in "Setup" \(d1\) \(4 bytes\)/,
		);
		assert.match(
			await text("read_doc", { store: "d1", path: "assets/dot.png" }),
			/is an image \(4 bytes\); show it with !\[alt\]/,
		);
		await tool("write_doc", {
			store: "d1",
			path: "notes/index.md",
			content: "# Notes",
		});
		const png = await fetch(`${base}/api/docs/d1/files/assets/dot.png`);
		assert.equal(png.status, 200);
		assert.equal(png.headers.get("content-type"), "image/png");
		assert.equal(png.headers.get("content-length"), "4");
		assert.equal(png.headers.get("x-content-type-options"), "nosniff");
		assert.equal(
			png.headers.get("content-security-policy"),
			"sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
		);
		const page = await fetch(`${base}/api/docs/d1/files/notes%2Findex.md`);
		assert.equal(await page.text(), "# Notes");
		for (const path of [
			"d9/files/notes/index.md",
			"d1/files/notes/gone.md",
			"d1/files/.hidden.md",
		]) {
			assert.equal((await fetch(`${base}/api/docs/${path}`)).status, 404, path);
		}
		await files.write("d9", "x.md", Buffer.from("unregistered"));
		assert.equal((await fetch(`${base}/api/docs/d9/files/x.md`)).status, 404);
		assert.equal(
			(await fetch(`${base}/api/docs/d1/files/%E0%A4%A.md`)).status,
			400,
		);
	});

	it("handles the user's store and page changes", async () => {
		assert.deepEqual(docs.createStore({ title: "Runbook" }), {
			status: 201,
			body: {
				id: `new${ids}`,
				title: "Runbook",
				createdAt: 1000,
				updatedAt: 1000,
			},
		});
		assert.equal(docs.createStore({ title: "" }).status, 400);
		assert.equal(docs.createStore(null).status, 400);
		assert.deepEqual(docs.renameStore("d1", { title: "Set up" }), {
			status: 200,
			body: { id: "d1", title: "Set up", createdAt: 0, updatedAt: 1000 },
		});
		assert.equal(docs.renameStore("nope", { title: "X" }).status, 404);
		assert.equal(docs.renameStore("d1", { title: "a\nb" }).status, 400);

		const put = await docs.putFile("d1", "guides%2Fa.md", { content: "# A" });
		assert.equal(put.status, 200);
		assert.deepEqual(
			{ ...(put.body as object), updatedAt: 0 },
			{ path: "guides/a.md", size: 3, updatedAt: 0 },
		);
		assert.equal((await files.read("d1", "guides/a.md"))?.toString(), "# A");
		assert.equal(
			(await docs.putFile("nope", "a.md", { content: "" })).status,
			404,
		);
		assert.equal(
			(await docs.putFile("d1", "a.png", { content: "" })).status,
			400,
		);
		assert.equal(
			(await docs.putFile("d1", "../a.md", { content: "" })).status,
			400,
		);
		assert.equal(
			(await docs.putFile("d1", "a.md", { content: 3 })).status,
			400,
		);
		assert.equal(
			(
				await docs.putFile("d1", "a.md", {
					content: "x".repeat(1024 * 1024 + 1),
				})
			).status,
			400,
		);
		assert.equal(
			(await docs.putFile("d1", "Guides/b.md", { content: "" })).status,
			422,
		);

		assert.equal((await docs.deleteFile("d1", "guides/a.md")).status, 204);
		assert.equal((await docs.deleteFile("d1", "guides/a.md")).status, 404);
		assert.equal((await docs.deleteFile("nope", "a.md")).status, 404);

		await docs.putFile("d2", "x.md", { content: "x" });
		assert.equal((await docs.deleteStore("d2")).status, 204);
		assert.equal(files.index().d2, undefined);
		assert.equal((await docs.deleteStore("d2")).status, 404);
	});
});

describe("sessionMcpConfig", () => {
	it("names the server kanban and passes the board url", () => {
		assert.deepEqual(
			JSON.parse(
				sessionMcpConfig(
					"/bin/node",
					"/app/sessionMcp.ts",
					"http://127.0.0.1:7420",
				) ?? "",
			),
			{
				mcpServers: {
					kanban: {
						type: "stdio",
						command: "/bin/node",
						args: ["/app/sessionMcp.ts"],
						env: { KANBAN_AGENT_URL: "http://127.0.0.1:7420" },
					},
				},
			},
		);
	});
});
