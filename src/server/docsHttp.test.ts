import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { samePair } from "../shared/relations.ts";
import type {
	Annotations,
	Relation,
	RelationDraft,
	Session,
} from "../shared/types.ts";
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

const session = (id: string, patch: Partial<Session> = {}): Session => ({
	id,
	short: null,
	pid: 1,
	name: `name-${id}`,
	cwd: "/dev/acme",
	project: "acme",
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
	...patch,
});

const initialAnnotations: Annotations = {
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
	let annotations: Annotations = {};
	let sessions: Session[] = [];
	let posted: [string, string][] = [];
	let woken: [string, string][] = [];
	let ids = 0;
	const server = createServer();

	before(async () => {
		const files = await loadDocFiles({
			dir: await mkdtemp(join(tmpdir(), "kanban-docs-http-")),
			onChange: () => {},
		});
		const docs = createDocsHttp({
			files,
			relations: {
				current: () => relations,
				create: (draft: RelationDraft) => {
					if (relations.some((other) => samePair(other, draft))) {
						return { error: "These two are already linked" };
					}
					const made = { id: `r${relations.length}`, createdAt: 0, ...draft };
					relations = [...relations, made];
					return made;
				},
				remove: (id: string) => {
					const before = relations.length;
					relations = relations.filter((relation) => relation.id !== id);
					return relations.length < before;
				},
			},
			annotations: {
				current: () => annotations,
				put: (annotation) => {
					annotations = { ...annotations, [annotation.id]: annotation };
					return { ok: true };
				},
			},
			sessions: () => sessions,
			place: () => ({ x: 480, y: 96 }),
			notices: { post: (to, text) => posted.push([to, text]) },
			wake: async (target, text) => {
				woken.push([target.id, text]);
			},
			newId: () => `new${++ids}`,
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
		annotations = { ...initialAnnotations };
		sessions = [
			session("s1"),
			session("s2", { activity: "idle", short: "s2short" }),
			session("s3"),
			session("s4", { activity: "idle", kind: "interactive" }),
			session("s5", { pid: null }),
		];
		posted = [];
		woken = [];
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

	it("finds every store on the board with who it's linked to", async () => {
		const found = await answer(await tool("find_doc_stores", {}));
		assert.equal(
			found.body.text?.replace(/\d+ files?/g, "N files"),
			[
				"Doc stores on the board:",
				'- "Design" (d2): N files · linked to name-s2',
				'- "Setup" (d1): N files · linked to you, name-s2',
			].join("\n"),
		);
		assert.equal(
			(await tool("find_doc_stores", {}, { "x-kanban-session": "ghost" }))
				.status,
			422,
		);
	});

	it("creates a store beside the caller and links it", async () => {
		const made = await answer(
			await tool("create_doc_store", { title: "  API notes " }),
		);
		assert.equal(made.status, 200);
		assert.match(made.body.text ?? "", /"API notes" \((new\d+)\)/);
		const id = /\((new\d+)\)/.exec(made.body.text ?? "")?.[1] ?? "";
		assert.deepEqual(
			{ ...annotations[id], z: 0 },
			{
				id,
				kind: "docs",
				x: 480,
				y: 96,
				w: 288,
				h: 264,
				z: 0,
				title: "API notes",
			},
		);
		assert.ok(
			relations.some((relation) =>
				samePair(relation, {
					from: { kind: "session", id: "s1" },
					to: { kind: "docs", id },
				}),
			),
		);
		const listed = await answer(await tool("list_docs", { store: id }));
		assert.equal(listed.body.text, `"API notes" (${id}) is empty.`);
		assert.equal(
			(await tool("create_doc_store", { title: "a\nb" })).status,
			400,
		);
	});

	it("joins and leaves stores", async () => {
		const joined = await answer(await tool("join_doc_store", { store: "d2" }));
		assert.match(joined.body.text ?? "", /^Joined "Design" \(d2\)\./);
		assert.equal(
			(await answer(await tool("list_docs", { store: "d2" }))).status,
			200,
		);
		const again = await answer(await tool("join_doc_store", { store: "d2" }));
		assert.equal(again.body.text, '"Design" (d2) is already linked to you.');
		assert.equal((await tool("join_doc_store", { store: "n1" })).status, 422);
		const left = await answer(await tool("leave_doc_store", { store: "d2" }));
		assert.equal(left.body.text, 'Left "Design" (d2).');
		assert.equal((await tool("list_docs", { store: "d2" })).status, 422);
		assert.equal((await tool("leave_doc_store", { store: "d2" })).status, 422);
	});

	it("shares a store with another session and passes on the note", async () => {
		const working = await answer(
			await tool("share_doc_store", {
				session: "name-s3",
				note: "The API decisions",
			}),
		);
		assert.equal(
			working.body.text,
			'"Setup" (d1) is now linked to name-s3. It gets your note at its next step.',
		);
		assert.deepEqual(woken, []);
		assert.equal(posted.length, 1);
		assert.equal(posted[0]?.[0], "s3");
		assert.match(posted[0]?.[1] ?? "", /^name-s1 \(session s1\) linked/);
		assert.match(posted[0]?.[1] ?? "", /for reference\. Their note: The API/);

		const idle = await answer(
			await tool("share_doc_store", {
				store: "d1",
				session: "s2",
				contribute: true,
			}),
		);
		assert.equal(
			idle.body.text,
			'"Setup" (d1) was already linked to name-s2. It was idle, so the board woke it to read your note.',
		);
		assert.equal(woken[0]?.[0], "s2");
		assert.match(posted[1]?.[1] ?? "", /asks you to contribute/);

		for (const [target, pattern] of [
			["s1", /your own session/],
			["s4", /runs in a terminal/],
			["s5", /isn't running/],
			["nobody", /^No session nobody on the board\. Live sessions: /],
		] as const) {
			const refused = await answer(
				await tool("share_doc_store", { session: target }),
			);
			assert.equal(refused.status, 422, target);
			assert.match(refused.body.error ?? "", pattern, target);
		}
		const unlinked = await answer(
			await tool("share_doc_store", { store: "d2", session: "s3" }),
		);
		assert.match(unlinked.body.error ?? "", /isn't linked to this session/);
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
