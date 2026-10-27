import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import type {
	Board,
	BoardFeed,
	ExitResult,
	NewSessionRequest,
	Point,
} from "../shared/types.ts";
import { createAnnotationStore } from "./annotations.ts";
import type { AttachHub } from "./attach.ts";
import type { AuditEvent } from "./audit.ts";
import type { Authenticate } from "./auth.ts";
import { createFeed } from "./feed.ts";
import {
	contentTypeFor,
	createKanbanServer,
	matchRoute,
	matchUpgrade,
	staticFile,
} from "./http.ts";
import { createLayoutStore } from "./layout.ts";

const route = (method: string, path: string) =>
	matchRoute(method, new URL(path, "http://x"));

describe("matchRoute", () => {
	it("parses the API", () => {
		assert.deepEqual(route("GET", "/healthz"), { kind: "healthz" });
		assert.deepEqual(route("GET", "/api/sessions/abc-1/transcript?limit=20"), {
			kind: "transcript",
			sessionId: "abc-1",
			limit: 20,
		});
		assert.deepEqual(route("GET", "/api/sessions/abc/transcript?limit=x"), {
			kind: "transcript",
			sessionId: "abc",
			limit: 200,
		});
		assert.deepEqual(route("GET", "/api/sessions/abc/transcript?limit=99999"), {
			kind: "transcript",
			sessionId: "abc",
			limit: 1000,
		});
		assert.deepEqual(route("POST", "/api/sessions"), {
			kind: "create-session",
		});
		assert.deepEqual(route("GET", "/api/sessions"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("POST", "/api/sessions/abc-1/exit"), {
			kind: "exit-session",
			sessionId: "abc-1",
		});
		assert.deepEqual(route("GET", "/api/sessions/abc-1/exit"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("PUT", "/api/layout"), { kind: "update-layout" });
		assert.deepEqual(route("POST", "/api/layout"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("PUT", "/api/annotations/n-1"), {
			kind: "put-annotation",
			id: "n-1",
		});
		assert.deepEqual(route("DELETE", "/api/annotations/n-1"), {
			kind: "delete-annotation",
			id: "n-1",
		});
		assert.deepEqual(route("GET", "/api/annotations/n-1"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("GET", "/api/nope"), { kind: "not-found" });
		assert.deepEqual(route("GET", "/assets/app.js"), {
			kind: "static",
			path: "/assets/app.js",
		});
		assert.deepEqual(route("DELETE", "/"), { kind: "method-not-allowed" });
	});

	it("parses upgrades", () => {
		const upgrade = (path: string) => matchUpgrade(new URL(path, "http://x"));
		assert.deepEqual(upgrade("/api/feed"), { kind: "feed" });
		assert.deepEqual(upgrade("/api/attach/abcd1234?cols=90&rows=30"), {
			kind: "attach",
			short: "abcd1234",
			size: { cols: 90, rows: 30 },
		});
		assert.equal(upgrade("/api/attach/ABCD1234"), null);
		assert.equal(upgrade("/api/attach/abcd1234/x"), null);
		assert.equal(upgrade("/api/other"), null);
	});

	it("keeps static paths inside dist", () => {
		assert.equal(staticFile("/srv/dist", "/app.js"), "/srv/dist/app.js");
		assert.equal(staticFile("/srv/dist", "/"), "/srv/dist/");
		assert.equal(staticFile("/srv/dist", "/../secret"), null);
		assert.equal(staticFile("/srv/dist", "/%2e%2e/secret"), null);
		assert.equal(staticFile("/srv/dist", "/%E0%A4%A"), null);
		assert.equal(contentTypeFor("/a/b.JS"), "text/javascript; charset=utf-8");
		assert.equal(contentTypeFor("/a/b.woff2"), "font/woff2");
		assert.equal(contentTypeFor("/a/b"), "application/octet-stream");
	});
});

const board: Board = {
	sessions: [
		{
			id: "11111111-2222-3333-4444-555555555555",
			short: "abcd1234",
			pid: 42,
			name: "acme-api",
			cwd: "/Users/me/dev/acme-api",
			project: "acme-api",
			kind: "background",
			activity: "idle",
			doing: null,
			needs: null,
			startedAt: 0,
			updatedAt: 0,
			attachable: true,
		},
	],
	subagents: [],
	links: [],
	messages: [],
	generatedAt: 1,
};

describe("createKanbanServer", () => {
	const token = "good";
	const authenticate: Authenticate = async (req) => {
		const value = req.headers["cf-access-jwt-assertion"];
		if (!value) return { ok: false, status: 401 };
		return value === token
			? { ok: true, identity: "me@example.com" }
			: { ok: false, status: 403 };
	};
	const launched: NewSessionRequest[] = [];
	const expected: [string, Point][] = [];
	const exits: [string, boolean][] = [];
	let exitResult: ExitResult = { ok: true, exited: true };
	let exitGate: Promise<void> = Promise.resolve();
	let layoutFile = "";
	let layoutSaved = () => Promise.resolve();
	let annotationsFile = "";
	let annotationsSaved = () => Promise.resolve();
	const attached: string[] = [];
	const events: AuditEvent[] = [];
	const origins: string[] = [];
	let base = "";
	let origin = "";
	let close = () => {};

	before(async () => {
		const dist = await mkdtemp(join(tmpdir(), "kanban-dist-"));
		await mkdir(join(dist, "assets"));
		await writeFile(join(dist, "index.html"), "<!doctype html>board");
		await writeFile(join(dist, "assets", "app.js"), "export {}");
		await writeFile(join(dist, "locked.js"), "export {}");
		await chmod(join(dist, "locked.js"), 0o000);
		const attach: AttachHub = {
			open: (socket, target) => {
				attached.push(`${target.short} ${target.cwd}`);
				socket.close(1000, "fake");
			},
			attached: () => [],
		};
		layoutFile = join(dist, "state", "layout.json");
		let feed: ReturnType<typeof createFeed> | null = null;
		const store = createLayoutStore({
			file: layoutFile,
			initial: {},
			onChange: (layout) => feed?.layout(layout),
		});
		layoutSaved = store.saved;
		annotationsFile = join(dist, "state", "annotations.json");
		const annotations = createAnnotationStore({
			file: annotationsFile,
			initial: {},
			onChange: (next) => feed?.annotations(next),
		});
		annotationsSaved = annotations.saved;
		feed = createFeed({
			layout: store.current,
			annotations: annotations.current,
			board: () => board,
			previews: () => [
				{
					sessionId: board.sessions[0]?.id ?? "",
					html: "<pre></pre>",
					capturedAt: 1,
				},
			],
		});
		const server = createKanbanServer({
			origins,
			dist,
			authenticate,
			source: {
				board: () => board,
				transcript: async (_id, limit) => [
					{ at: 1, role: "user", text: `limit ${limit}` },
				],
			},
			launch: async (request) => {
				launched.push(request);
				return { ok: true, short: "feedbeef" };
			},
			exit: async (session, force) => {
				exits.push([session.id, force]);
				await exitGate;
				return exitResult;
			},
			layout: {
				...store,
				expect: (short, at) => {
					expected.push([short, at]);
					store.expect(short, at);
				},
			},
			annotations,
			attach,
			feed,
			audit: (event) => events.push(event),
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		base = `http://127.0.0.1:${port}`;
		origin = base;
		origins.push(origin);
		close = () => {
			server.closeAllConnections();
			server.close();
		};
	});
	after(() => close());

	const authed = { "cf-access-jwt-assertion": token };

	it("serves healthz without auth", async () => {
		const response = await fetch(`${base}/healthz`);
		assert.equal(response.status, 200);
	});

	it("refuses requests without or with a bad token", async () => {
		assert.equal((await fetch(`${base}/`)).status, 401);
		assert.equal(
			(
				await fetch(`${base}/`, {
					headers: { "cf-access-jwt-assertion": "bad" },
				})
			).status,
			403,
		);
	});

	it("serves static files with an index fallback", async () => {
		const asset = await fetch(`${base}/assets/app.js`, { headers: authed });
		assert.equal(
			asset.headers.get("content-type"),
			"text/javascript; charset=utf-8",
		);
		const deep = await fetch(`${base}/some/route`, { headers: authed });
		assert.equal(deep.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(await deep.text(), "<!doctype html>board");
		assert.equal(
			deep.headers.get("content-security-policy"),
			"frame-ancestors 'none'",
		);
		assert.equal(deep.headers.get("x-frame-options"), "DENY");
	});

	it("survives a static file it cannot read", async () => {
		await assert.rejects(
			fetch(`${base}/locked.js`, { headers: authed }).then((response) =>
				response.text(),
			),
		);
		assert.equal((await fetch(`${base}/healthz`)).status, 200);
	});

	it("serves transcripts for known sessions without caching", async () => {
		const id = board.sessions[0]?.id;
		const response = await fetch(
			`${base}/api/sessions/${id}/transcript?limit=5`,
			{
				headers: authed,
			},
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.deepEqual(await response.json(), [
			{ at: 1, role: "user", text: "limit 5" },
		]);
		const missing = await fetch(`${base}/api/sessions/nope/transcript`, {
			headers: authed,
		});
		assert.equal(missing.status, 404);
	});

	it("creates sessions from same-origin JSON and audits them", async () => {
		const post = (body: unknown, headers: Record<string, string> = {}) =>
			fetch(`${base}/api/sessions`, {
				method: "POST",
				headers: {
					...authed,
					"content-type": "application/json",
					origin,
					...headers,
				},
				body: JSON.stringify(body),
			});
		const request = { cwd: tmpdir(), name: "acme-api", prompt: "say hi" };
		const created = await post(request);
		assert.equal(created.status, 201);
		assert.deepEqual(await created.json(), { ok: true, short: "feedbeef" });
		assert.deepEqual(launched, [request]);
		assert.equal(events.at(-1)?.action, "session-create");

		const invalid = await post({ ...request, prompt: "" });
		assert.equal(invalid.status, 400);
		assert.deepEqual(await invalid.json(), {
			ok: false,
			error: "prompt is required",
		});

		assert.equal(
			(await post(request, { origin: "https://evil.example" })).status,
			403,
		);
		assert.equal(
			(await post(request, { "content-type": "text/plain" })).status,
			415,
		);
		assert.equal(launched.length, 1);
		assert.deepEqual(expected, []);

		const placed = await post({ ...request, at: { x: 40, y: 80 } });
		assert.equal(placed.status, 201);
		assert.deepEqual(expected, [["feedbeef", { x: 40, y: 80 }]]);
	});

	const send = (method: string, path: string, body: unknown) =>
		fetch(`${base}${path}`, {
			method,
			headers: { ...authed, "content-type": "application/json", origin },
			body: JSON.stringify(body),
		});

	const exitFrames = async () => {
		const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
			headers: { ...authed, origin },
		});
		const frames: BoardFeed[] = [];
		const waiting: (() => void)[] = [];
		socket.on("message", (data) => {
			const frame = JSON.parse(String(data)) as BoardFeed;
			if (frame.type !== "exit") return;
			frames.push(frame);
			waiting.shift()?.();
		});
		await new Promise((resolve) => socket.on("open", resolve));
		return {
			next: async () => {
				if (frames.length === 0)
					await new Promise<void>((resolve) => waiting.push(resolve));
				return frames.shift();
			},
			close: () => socket.close(),
		};
	};

	it("accepts an exit at once, then broadcasts and audits the outcome", async () => {
		const id = board.sessions[0]?.id ?? "";
		const feed = await exitFrames();
		let release = () => {};
		exitGate = new Promise((resolve) => {
			release = resolve;
		});
		const accepted = await send("POST", `/api/sessions/${id}/exit`, {
			force: false,
		});
		assert.equal(accepted.status, 202);
		const twice = await send("POST", `/api/sessions/${id}/exit`, {
			force: true,
		});
		assert.equal(twice.status, 409);
		release();
		assert.deepEqual(await feed.next(), {
			type: "exit",
			sessionId: id,
			result: { ok: true, exited: true },
		});
		assert.deepEqual(events.at(-1), {
			action: "session-exit",
			sessionId: id,
			short: "abcd1234",
			kind: "background",
			force: false,
			identity: "me@example.com",
			result: "exited",
		});

		exitResult = { ok: true, exited: false, reason: "Tests still running" };
		await send("POST", `/api/sessions/${id}/exit`, { force: false });
		const notReady = await feed.next();
		assert.deepEqual(notReady?.type === "exit" && notReady.result, {
			ok: true,
			exited: false,
			reason: "Tests still running",
		});
		const audited = events.at(-1);
		assert.equal(
			audited?.action === "session-exit" && audited.result,
			"not ready: Tests still running",
		);

		exitResult = { ok: false, error: "claude rm refused: x" };
		await send("POST", `/api/sessions/${id}/exit`, { force: true });
		const refused = await feed.next();
		assert.deepEqual(refused?.type === "exit" && refused.result, exitResult);
		feed.close();

		assert.equal(
			(await send("POST", "/api/sessions/nope/exit", { force: true })).status,
			404,
		);
		assert.equal(
			(await send("POST", `/api/sessions/${id}/exit`, { force: "yes" })).status,
			400,
		);
		assert.deepEqual(exits, [
			[id, false],
			[id, false],
			[id, true],
		]);
	});

	it("stores placements for nodes on the board and broadcasts them", async () => {
		const key = `session:${board.sessions[0]?.id}`;
		const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
			headers: { ...authed, origin },
		});
		const broadcast = new Promise<BoardFeed>((resolve) => {
			let layouts = 0;
			socket.on("message", (data) => {
				const frame = JSON.parse(String(data)) as BoardFeed;
				if (frame.type === "layout" && ++layouts === 2) resolve(frame);
			});
		});
		await new Promise((resolve) => socket.on("open", resolve));
		const placement = { x: 24, y: -48, w: 480, h: 360 };
		const stored = await send("PUT", "/api/layout", { key, placement });
		assert.equal(stored.status, 204);
		assert.deepEqual(await broadcast, {
			type: "layout",
			layout: { [key]: placement },
		});
		socket.close();
		assert.equal(
			(await send("PUT", "/api/layout", { key: "session:nope", placement }))
				.status,
			404,
		);
		assert.equal(
			(await send("PUT", "/api/layout", { key, placement: { x: 1 } })).status,
			400,
		);
		await layoutSaved();
		assert.deepEqual(JSON.parse(await readFile(layoutFile, "utf8")), {
			[key]: placement,
		});
	});

	it("stores and deletes annotations and broadcasts them", async () => {
		const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
			headers: { ...authed, origin },
		});
		const frames: BoardFeed[] = [];
		const received = (count: number) =>
			new Promise<void>((resolve) => {
				const check = () => {
					if (frames.length >= count) resolve();
					else setTimeout(check, 5);
				};
				check();
			});
		socket.on("message", (data) => {
			const frame = JSON.parse(String(data)) as BoardFeed;
			if (frame.type === "annotations") frames.push(frame);
		});
		await new Promise((resolve) => socket.on("open", resolve));
		await received(1);
		assert.deepEqual(frames[0], { type: "annotations", annotations: {} });

		const note = {
			kind: "note",
			x: 0,
			y: 0,
			w: 192,
			h: 192,
			z: 1,
			text: "hi",
			color: "pink",
		};
		assert.equal((await send("PUT", "/api/annotations/n1", note)).status, 204);
		await received(2);
		assert.deepEqual(frames[1], {
			type: "annotations",
			annotations: { n1: { id: "n1", ...note } },
		});
		const invalid = await send("PUT", "/api/annotations/n2", {
			...note,
			color: "teal",
		});
		assert.equal(invalid.status, 400);

		const remove = (id: string, headers: Record<string, string> = {}) =>
			fetch(`${base}/api/annotations/${id}`, {
				method: "DELETE",
				headers: { ...authed, origin, ...headers },
			});
		assert.equal(
			(await remove("n1", { origin: "https://evil.example" })).status,
			403,
		);
		assert.equal((await remove("n1")).status, 204);
		assert.equal((await remove("n1")).status, 404);
		await received(3);
		assert.deepEqual(frames[2], { type: "annotations", annotations: {} });
		socket.close();
		await annotationsSaved();
		assert.deepEqual(JSON.parse(await readFile(annotationsFile, "utf8")), {});
	});

	const upgradeStatus = (path: string, headers: Record<string, string>) =>
		new Promise<number | "open">((resolve) => {
			const socket = new WebSocket(`${base.replace("http", "ws")}${path}`, {
				headers,
			});
			socket.on("open", () => {
				resolve("open");
				socket.close();
			});
			socket.on("unexpected-response", (_req, res) =>
				resolve(res.statusCode ?? 0),
			);
			socket.on("error", () => {});
		});

	it("guards websocket upgrades by origin, token and attachability", async () => {
		assert.equal(await upgradeStatus("/api/feed", { ...authed }), 403);
		assert.equal(
			await upgradeStatus("/api/feed", {
				...authed,
				origin: "https://evil.example",
			}),
			403,
		);
		assert.equal(await upgradeStatus("/api/feed", { origin }), 401);
		assert.equal(
			await upgradeStatus("/api/attach/deadbeef", { ...authed, origin }),
			404,
		);
		assert.equal(
			await upgradeStatus("/api/attach/xyz", { ...authed, origin }),
			404,
		);
		assert.equal(
			await upgradeStatus("/api/attach/abcd1234", { ...authed, origin }),
			"open",
		);
		assert.deepEqual(attached, ["abcd1234 /Users/me/dev/acme-api"]);
	});

	it("sends the board and cached previews when a feed client connects", async () => {
		const frames = await new Promise<BoardFeed[]>((resolve) => {
			const received: BoardFeed[] = [];
			const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
				headers: { ...authed, origin },
			});
			socket.on("message", (data) => {
				received.push(JSON.parse(String(data)));
				if (received.length === 4) {
					socket.close();
					resolve(received);
				}
			});
		});
		assert.deepEqual(
			frames.map((frame) => frame.type),
			["layout", "annotations", "board", "preview"],
		);
	});

	it("survives a websocket frame over the payload limit", async () => {
		const code = await new Promise<number>((resolve) => {
			const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
				headers: { ...authed, origin },
			});
			socket.on("open", () => socket.send("x".repeat(2 * 1024 * 1024)));
			socket.on("close", (closeCode) => resolve(closeCode));
			socket.on("error", () => {});
		});
		assert.ok(code === 1006 || code === 1009);
		assert.equal((await fetch(`${base}/healthz`)).status, 200);
	});
});
