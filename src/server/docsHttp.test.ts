import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Annotations, Relation } from "../shared/types.ts";
import { loadDocFiles } from "./docs.ts";
import { createDocsHttp, sessionMcpConfig } from "./docsHttp.ts";
import { matchRoute } from "./http.ts";

const docStore = (id: string, title: string) => ({
	id,
	kind: "docs" as const,
	title,
	x: 0,
	y: 0,
	w: 200,
	h: 160,
	z: 0,
});

const annotations: Annotations = {
	d1: docStore("d1", "Setup"),
	d2: docStore("d2", "Design"),
	n1: {
		id: "n1",
		kind: "note",
		text: "",
		color: "yellow",
		x: 0,
		y: 0,
		w: 10,
		h: 10,
		z: 0,
	},
};

const relation = (session: string, store: string): Relation => ({
	id: `${session}-${store}`,
	createdAt: 0,
	from: { kind: "session", id: session },
	to: { kind: "docs", id: store },
});

describe("docs http", () => {
	let base = "";
	let relations: Relation[] = [];
	const server = createServer();

	before(async () => {
		const files = await loadDocFiles({
			dir: await mkdtemp(join(tmpdir(), "kanban-docs-http-")),
			onChange: () => {},
		});
		const docs = createDocsHttp({
			files,
			relations: { current: () => relations },
			annotations: { current: () => annotations },
		});
		server.on("request", (req, res) => {
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

	beforeEach(() => {
		relations = [
			relation("s1", "d1"),
			relation("s2", "d1"),
			relation("s2", "d2"),
			relation("s3", "n1"),
		];
	});

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

	it("guards the tool route", async () => {
		assert.equal(
			(await tool("list_docs", {}, { "x-kanban-session": "s1", origin: base }))
				.status,
			403,
		);
		assert.equal(
			(await tool("list_docs", {}, { "x-kanban-session": "s1", "cf-ray": "x" }))
				.status,
			403,
		);
		assert.equal((await tool("list_docs", {}, {})).status, 401);
		assert.equal(
			(await tool("list_docs", {}, { "x-kanban-session": "bad id" })).status,
			401,
		);
		const plain = await fetch(`${base}/api/docs/tools/list_docs`, {
			method: "POST",
			headers: { "x-kanban-session": "s1", "content-type": "text/plain" },
			body: "{}",
		});
		assert.equal(plain.status, 415);
		const unknown = await answer(
			await tool("read_doc", { path: "x.md", extra: 1 }),
		);
		assert.deepEqual(unknown, {
			status: 400,
			body: { ok: false, error: "Unknown argument extra" },
		});
	});

	it("refuses stores that aren't linked or aren't chosen", async () => {
		const unlinked = await answer(await tool("list_docs", { store: "d2" }));
		assert.deepEqual(unlinked, {
			status: 422,
			body: { ok: false, error: "Doc store d2 isn't linked to this session" },
		});
		for (const session of ["nobody", "s3"]) {
			const none = await answer(
				await tool(
					"read_doc",
					{ path: "x.md" },
					{ "x-kanban-session": session },
				),
			);
			assert.equal(none.status, 422);
			assert.match(none.body.error ?? "", /^No doc stores are linked/);
		}
		const several = await answer(
			await tool(
				"write_doc",
				{ path: "x.md", content: "" },
				{ "x-kanban-session": "s2" },
			),
		);
		assert.equal(several.status, 422);
		assert.match(several.body.error ?? "", /"Setup" \(d1\), "Design" \(d2\)/);
	});

	it("writes, lists, reads and deletes docs", async () => {
		const written = await answer(
			await tool("write_doc", { path: "guides/setup.md", content: "# Setup" }),
		);
		assert.deepEqual(written, {
			status: 200,
			body: { ok: true, text: 'Wrote guides/setup.md in "Setup" (7 bytes)' },
		});
		const listed = await answer(await tool("list_docs", {}));
		assert.match(listed.body.text ?? "", /- "Setup" \(d1\): 1 file\n/);
		assert.match(
			listed.body.text ?? "",
			/- guides\/setup\.md \(7 bytes, \d{4}-/,
		);
		const several = await answer(
			await tool("list_docs", {}, { "x-kanban-session": "s2" }),
		);
		assert.match(several.body.text ?? "", /"Design" \(d2\): 0 files/);
		assert.doesNotMatch(several.body.text ?? "", /guides/);
		const one = await answer(
			await tool("list_docs", { store: "d2" }, { "x-kanban-session": "s2" }),
		);
		assert.equal(one.body.text, '"Design" (d2) is empty.');
		const read = await answer(
			await tool("read_doc", { path: "guides/setup.md" }),
		);
		assert.deepEqual(read, {
			status: 200,
			body: { ok: true, text: "# Setup" },
		});
		const missing = await answer(await tool("read_doc", { path: "nope.md" }));
		assert.equal(missing.status, 422);
		const deleted = await answer(
			await tool("delete_doc", { store: "d1", path: "guides/setup.md" }),
		);
		assert.equal(deleted.status, 200);
		assert.equal(
			(await tool("delete_doc", { path: "guides/setup.md" })).status,
			422,
		);
	});

	it("saves a base64 asset and serves files with safe headers", async () => {
		const saved = await answer(
			await tool("put_doc_asset", { path: "assets/dot.png", data: "iVBORw==" }),
		);
		assert.equal(saved.status, 200);
		assert.match(
			saved.body.text ?? "",
			/^Saved assets\/dot\.png in "Setup" \(4 bytes\)/,
		);
		const image = await answer(
			await tool("read_doc", { path: "assets/dot.png" }),
		);
		assert.match(
			image.body.text ?? "",
			/is an image \(4 bytes\); show it with !\[alt\]/,
		);
		await tool("write_doc", { path: "notes/index.md", content: "# Notes" });
		await tool("write_doc", { path: "flow.svg", content: "<svg/>" });
		const svg = await fetch(`${base}/api/docs/d1/files/flow.svg`);
		assert.equal(svg.headers.get("content-type"), "image/svg+xml");
		assert.match(svg.headers.get("content-security-policy") ?? "", /^sandbox;/);

		const png = await fetch(`${base}/api/docs/d1/files/assets/dot.png`);
		assert.equal(png.status, 200);
		assert.equal(png.headers.get("content-type"), "image/png");
		assert.equal(png.headers.get("content-length"), "4");
		assert.equal(png.headers.get("x-content-type-options"), "nosniff");
		assert.equal(png.headers.get("cache-control"), "no-cache");
		assert.equal(
			png.headers.get("content-security-policy"),
			"sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
		);
		assert.deepEqual(
			[...new Uint8Array(await png.arrayBuffer())],
			[137, 80, 78, 71],
		);

		const page = await fetch(`${base}/api/docs/d1/files/notes%2Findex.md`);
		assert.equal(
			page.headers.get("content-type"),
			"text/markdown; charset=utf-8",
		);
		assert.equal(await page.text(), "# Notes");

		const head = await fetch(`${base}/api/docs/d1/files/notes/index.md`, {
			method: "HEAD",
		});
		assert.equal(head.status, 200);
		assert.equal(head.headers.get("content-length"), "7");
		assert.equal(await head.text(), "");

		for (const path of [
			"d9/files/notes/index.md",
			"n1/files/notes/index.md",
			"d1/files/notes/gone.md",
			"d1/files/.hidden.md",
		]) {
			assert.equal((await fetch(`${base}/api/docs/${path}`)).status, 404, path);
		}
		assert.equal(
			(await fetch(`${base}/api/docs/d1/files/%E0%A4%A.md`)).status,
			400,
		);
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
