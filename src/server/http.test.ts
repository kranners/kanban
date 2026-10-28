import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import type { ToolCall } from "../agent/tools.ts";
import {
	type Annotations,
	type Board,
	type BoardFeed,
	type ExitResult,
	maxNoteText,
	type NewSessionRequest,
	type Point,
} from "../shared/types.ts";
import { createAgentTokens } from "./agentAuth.ts";
import { createAnnotationStore } from "./annotations.ts";
import type { AttachHub } from "./attach.ts";
import type { AuditEvent } from "./audit.ts";
import type { Authenticate } from "./auth.ts";
import { createColourStore } from "./colours.ts";
import { createCommentStore } from "./comments.ts";
import { type Answer, createExitRunner } from "./exit.ts";
import { createFeed } from "./feed.ts";
import {
	contentTypeFor,
	createKanbanServer,
	matchRoute,
	matchUpgrade,
	staticFile,
} from "./http.ts";
import { createLayoutStore } from "./layout.ts";
import { createRegionStore } from "./regions.ts";
import { createRegionReportRunner, createReportRunner } from "./reports.ts";

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
		assert.deepEqual(route("POST", "/api/sessions/abc-1/report"), {
			kind: "report-session",
			sessionId: "abc-1",
		});
		assert.deepEqual(route("GET", "/api/sessions/abc-1/report"), {
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
		assert.deepEqual(route("PUT", "/api/colours"), { kind: "update-colour" });
		assert.deepEqual(route("GET", "/api/colours"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("POST", "/api/regions"), { kind: "create-region" });
		assert.deepEqual(route("PATCH", "/api/regions/region-1"), {
			kind: "update-region",
			regionId: "region-1",
		});
		assert.deepEqual(route("DELETE", "/api/regions/region-1"), {
			kind: "delete-region",
			regionId: "region-1",
		});
		assert.deepEqual(route("GET", "/api/regions/region-1"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("POST", "/api/regions/region-1/report"), {
			kind: "report-region",
			regionId: "region-1",
		});
		assert.deepEqual(route("GET", "/api/regions/region-1/report"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("DELETE", "/api/regions/..%2Fx"), {
			kind: "not-found",
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
		assert.deepEqual(upgrade("/api/mirror/abc-1"), {
			kind: "mirror",
			sessionId: "abc-1",
		});
		assert.equal(upgrade("/api/mirror/abc/x"), null);
		assert.equal(upgrade("/api/mirror/a%2Fb"), null);
		assert.deepEqual(upgrade("/api/subagents/a1b2/conversation"), {
			kind: "conversation",
			node: { kind: "subagent", id: "a1b2" },
			since: null,
		});
		assert.deepEqual(upgrade("/api/sessions/s-1/conversation?since=ep:12"), {
			kind: "conversation",
			node: { kind: "session", id: "s-1" },
			since: { epoch: "ep", rev: 12 },
		});
		assert.equal(upgrade("/api/sessions/a%2Fb/conversation"), null);
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
			goal: null,
			startedAt: 0,
			updatedAt: 0,
			attachable: true,
			cmux: false,
			artifacts: [],
			tasks: [],
			steps: [],
		},
		{
			id: "66666666-7777-8888-9999-000000000000",
			short: null,
			pid: 43,
			name: "acme-web",
			cwd: "/Users/me/dev/acme-web",
			project: "acme-web",
			kind: "interactive",
			activity: "idle",
			doing: null,
			needs: null,
			goal: null,
			startedAt: 0,
			updatedAt: 0,
			attachable: false,
			cmux: true,
			artifacts: [],
			tasks: [],
			steps: [],
		},
	],
	subagents: [],
	subagentCounts: {},
	subagentStates: {},
	workflowRuns: {},
	workflows: [],
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
	const reports: [string, string][] = [];
	let reportAnswer: Answer = { ok: true, answer: "- Tests pass" };
	let reportGate: Promise<void> = Promise.resolve();
	let annotationsNow = (): Annotations => ({});
	let layoutFile = "";
	let layoutSaved = () => Promise.resolve();
	let annotationsFile = "";
	let annotationsSaved = () => Promise.resolve();
	let coloursFile = "";
	let coloursSaved = () => Promise.resolve();
	const attached: string[] = [];
	const mirrored: string[] = [];
	const conversed: string[] = [];
	const events: AuditEvent[] = [];
	const origins: string[] = [];
	const asked: [string, string][] = [];
	const cancelled: string[] = [];
	const toolCalls: [string, ToolCall][] = [];
	const agentTokens = createAgentTokens(60_000);
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
			screen: () => null,
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
		annotationsNow = annotations.current;
		coloursFile = join(dist, "state", "colours.json");
		const colours = createColourStore({
			file: coloursFile,
			initial: {},
			onChange: (next) => feed?.colours(next),
		});
		coloursSaved = colours.saved;
		const regions = createRegionStore({
			file: join(dist, "state", "regions.json"),
			initial: [],
			onChange: (next) => feed?.regions(next),
			newId: () => "region-1",
		});
		const comments = createCommentStore({
			file: join(dist, "state", "comments.json"),
			initial: [],
			onChange: (thread) => feed?.comment(thread),
			onRemove: (threads) => feed?.comments(threads),
			newId: () => "thread-1",
		});
		feed = createFeed({
			comments: comments.current,
			layout: store.current,
			annotations: annotations.current,
			colours: colours.current,
			regions: regions.current,
			board: () => board,
			usage: () => ({
				session: null,
				week: null,
				samples: [],
				checkedAt: null,
				error: null,
			}),
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
				transcriptPath: (node) =>
					node.kind === "session" ? `/transcripts/${node.id}.jsonl` : null,
			},
			launch: async (request) => {
				launched.push(request);
				return { ok: true, short: "feedbeef" };
			},
			exit: createExitRunner({
				exit: async (session, force) => {
					exits.push([session.id, force]);
					await exitGate;
					return exitResult;
				},
				audit: (event) => events.push(event),
				announce: (sessionId, result) => feed?.exit(sessionId, result),
			}),
			report: createReportRunner({
				ask: async (session, question) => {
					reports.push([session.id, question]);
					await reportGate;
					return reportAnswer;
				},
				annotations,
				cards: () =>
					new Map([
						[
							`session:${board.sessions[0]?.id}`,
							{ x: 0, y: 24, w: 288, h: 168 },
						],
					]),
				audit: (event) => events.push(event),
				announce: (sessionId, result) => feed?.report(sessionId, result),
				now: () => new Date(2026, 9, 27, 14, 5),
				newId: () => "report-1",
			}),
			regionReport: createRegionReportRunner({
				ask: async (session, question) => {
					reports.push([session.id, question]);
					return reportAnswer;
				},
				annotations,
				members: (regionId) =>
					regionId === "region-1"
						? {
								frame: { x: 0, y: 0, w: 480, h: 360 },
								sessions: board.sessions,
							}
						: null,
				cards: () => new Map(),
				audit: (event) => events.push(event),
				announce: (regionId, result) => feed?.regionReport(regionId, result),
				now: () => new Date(2026, 9, 27, 14, 5),
				newId: () => "region-report-1",
			}),
			layout: {
				...store,
				expect: (cwd, at) => {
					const settle = store.expect(cwd, at);
					return (short) => {
						if (short) expected.push([short, at]);
						settle(short);
					};
				},
			},
			annotations,
			colours,
			regions,
			comments,
			agent: {
				ask: (threadId, text) => {
					asked.push([threadId, text]);
					return comments.get(threadId)
						? { ok: true }
						: { error: "No such comment", status: 404 };
				},
				cancel: (threadId) => {
					cancelled.push(threadId);
					return true;
				},
				owns: comments.owns,
			},
			agentTokens,
			tools: async (threadId, call) => {
				toolCalls.push([threadId, call]);
				return { ok: true, text: `ran ${call.tool}` };
			},
			attach,
			mirror: {
				open: (socket, session, identity) => {
					mirrored.push(`${session.id} ${identity}`);
					socket.close(1000, "fake");
				},
			},
			conversation: {
				open: (socket, target, since, identity) => {
					conversed.push(
						`${target.kind}:${target.path} ${since?.rev ?? "-"} ${identity}`,
					);
					socket.close(1000, "fake");
				},
				respond: async () => ({ ok: false, error: "fake" }),
				attached: () => [],
				release() {},
			},
			files: async (cwd, query) => ({ ok: true, files: [`${cwd}:${query}`] }),
			commands: async (cwd) => [
				{ name: "compact", description: cwd, source: "built-in" },
			],
			pickFolder: async () => ({ ok: true, path: "/Users/me/dev/picked" }),
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

	it("lists a session's files and commands for the composer", async () => {
		const session = board.sessions[0];
		const files = await fetch(
			`${base}/api/sessions/${session?.id}/files?q=src`,
			{ headers: authed },
		);
		assert.equal(files.status, 200);
		assert.deepEqual(await files.json(), {
			ok: true,
			files: [`${session?.cwd}:src`],
		});
		const commands = await fetch(
			`${base}/api/sessions/${session?.id}/commands`,
			{ headers: authed },
		);
		assert.deepEqual(await commands.json(), [
			{ name: "compact", description: session?.cwd, source: "built-in" },
		]);
		const unauthenticated = await fetch(
			`${base}/api/sessions/${session?.id}/files`,
		);
		assert.equal(unauthenticated.status, 401);
		const missing = await fetch(`${base}/api/sessions/nope/commands`, {
			headers: authed,
		});
		assert.equal(missing.status, 404);
	});

	it("opens the host's folder picker for same-origin requests", async () => {
		const pick = (headers: Record<string, string>) =>
			fetch(`${base}/api/folder-picker`, { method: "POST", headers });
		const picked = await pick({ ...authed, origin });
		assert.equal(picked.status, 200);
		assert.deepEqual(await picked.json(), {
			ok: true,
			path: "/Users/me/dev/picked",
		});
		assert.equal(
			(await pick({ ...authed, origin: "https://evil.example" })).status,
			403,
		);
		assert.equal((await pick({ origin })).status, 401);
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

	const feedFrames = async (type: BoardFeed["type"]) => {
		const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
			headers: { ...authed, origin },
		});
		const frames: BoardFeed[] = [];
		const waiting: (() => void)[] = [];
		socket.on("message", (data) => {
			const frame = JSON.parse(String(data)) as BoardFeed;
			if (frame.type !== type) return;
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
		const feed = await feedFrames("exit");
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

	it("asks for a status report and notes the answer beside the card", async () => {
		const id = board.sessions[0]?.id ?? "";
		const feed = await feedFrames("report");
		let release = () => {};
		reportGate = new Promise((resolve) => {
			release = resolve;
		});
		assert.equal(
			(await send("POST", `/api/sessions/${id}/report`, {})).status,
			202,
		);
		assert.equal(
			(await send("POST", `/api/sessions/${id}/report`, {})).status,
			409,
		);
		release();
		assert.deepEqual(await feed.next(), {
			type: "report",
			sessionId: id,
			result: { ok: true },
		});
		const note = annotationsNow()["report-1"];
		assert.equal(note?.kind === "note" && note.session, id);
		assert.equal(note?.kind === "note" && note.x, 336);
		assert.match(
			note?.kind === "note" ? note.text : "",
			/^\*\*Status · 14:05\*\*\n\n- Tests pass$/,
		);
		assert.deepEqual(events.at(-1), {
			action: "session-report",
			sessionId: id,
			short: "abcd1234",
			identity: "me@example.com",
			result: "noted",
		});

		reportAnswer = { ok: false, error: "The session did not answer" };
		await send("POST", `/api/sessions/${id}/report`, {});
		assert.deepEqual(await feed.next(), {
			type: "report",
			sessionId: id,
			result: reportAnswer,
		});
		feed.close();

		assert.equal(
			(await send("POST", "/api/sessions/nope/report", {})).status,
			404,
		);
		assert.equal(
			(
				await fetch(`${base}/api/sessions/${id}/report`, {
					method: "POST",
					headers: { ...authed, origin: "https://evil.example" },
				})
			).status,
			403,
		);
		assert.equal(reports.length, 2);
		assert.equal(
			(await send("DELETE", "/api/annotations/report-1", undefined)).status,
			204,
		);
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

	it("accepts a note of the longest text however it escapes", async () => {
		const report = {
			kind: "note",
			x: 0,
			y: 0,
			w: 480,
			h: 720,
			z: 1,
			text: "\u0001".repeat(maxNoteText),
			color: "blue",
		};
		const put = (text: string) =>
			send("PUT", "/api/annotations/report", { ...report, text });
		assert.equal((await put(report.text)).status, 204);
		assert.equal((await put(`${report.text}x`)).status, 400);
		const removed = await fetch(`${base}/api/annotations/report`, {
			method: "DELETE",
			headers: { ...authed, origin },
		});
		assert.equal(removed.status, 204);
	});

	it("stores region colours by cwd and broadcasts them", async () => {
		const cwd = "/Users/me/dev/acme-api";
		const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
			headers: { ...authed, origin },
		});
		const broadcast = new Promise<BoardFeed>((resolve) => {
			let frames = 0;
			socket.on("message", (data) => {
				const frame = JSON.parse(String(data)) as BoardFeed;
				if (frame.type === "colours" && ++frames === 2) resolve(frame);
			});
		});
		await new Promise((resolve) => socket.on("open", resolve));
		const stored = await send("PUT", "/api/colours", { cwd, colour: "teal" });
		assert.equal(stored.status, 204);
		assert.deepEqual(await broadcast, {
			type: "colours",
			colours: { [cwd]: "teal" },
		});
		socket.close();
		assert.equal(
			(await send("PUT", "/api/colours", { cwd, colour: "plaid" })).status,
			400,
		);
		assert.equal(
			(await send("PUT", "/api/colours", { cwd: "acme", colour: "red" }))
				.status,
			400,
		);
		await coloursSaved();
		assert.deepEqual(JSON.parse(await readFile(coloursFile, "utf8")), {
			[cwd]: "teal",
		});
	});

	it("creates, updates and deletes project regions and broadcasts them", async () => {
		const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
			headers: { ...authed, origin },
		});
		const frames: BoardFeed[] = [];
		socket.on("message", (data) => {
			const frame = JSON.parse(String(data)) as BoardFeed;
			if (frame.type === "regions") frames.push(frame);
		});
		await new Promise((resolve) => socket.on("open", resolve));
		const draft = { cwd: realpathSync(tmpdir()), x: 0, y: 24, w: 480, h: 336 };
		const created = await send("POST", "/api/regions", draft);
		assert.equal(created.status, 201);
		const region = { id: "region-1", name: null, ...draft };
		assert.deepEqual(await created.json(), region);
		assert.equal(
			(await send("POST", "/api/regions", { ...draft, cwd: "/nope/missing" }))
				.status,
			400,
		);
		const renamed = await send("PATCH", "/api/regions/region-1", {
			name: "Acme",
		});
		assert.deepEqual(await renamed.json(), { ...region, name: "Acme" });
		assert.equal(
			(await send("PATCH", "/api/regions/region-1", { x: 1 })).status,
			400,
		);
		assert.equal(
			(await send("PATCH", "/api/regions/other", { name: "x" })).status,
			404,
		);
		const foreign = await fetch(`${base}/api/regions/region-1`, {
			method: "DELETE",
			headers: { ...authed, origin: "https://evil.example" },
		});
		assert.equal(foreign.status, 403);
		const deleted = await fetch(`${base}/api/regions/region-1`, {
			method: "DELETE",
			headers: { ...authed, origin },
		});
		assert.equal(deleted.status, 204);
		await new Promise((resolve) => setTimeout(resolve, 50));
		socket.close();
		assert.deepEqual(
			frames.map((frame) => frame.type === "regions" && frame.regions),
			[[], [region], [{ ...region, name: "Acme" }], []],
		);
	});

	it("asks every session in a project region and notes the answers beside it", async () => {
		reportAnswer = { ok: true, answer: "- Tests pass" };
		const draft = { cwd: realpathSync(tmpdir()), x: 0, y: 24, w: 480, h: 336 };
		assert.equal((await send("POST", "/api/regions", draft)).status, 201);
		const feed = await feedFrames("region-report");
		assert.equal(
			(await send("POST", "/api/regions/region-1/report", {})).status,
			202,
		);
		assert.deepEqual(await feed.next(), {
			type: "region-report",
			regionId: "region-1",
			result: { ok: true },
		});
		feed.close();
		const note = annotationsNow()["region-report-1"];
		assert.equal(note?.kind === "note" && note.region, "region-1");
		assert.equal(note?.kind === "note" && note.session, undefined);
		assert.equal(note?.kind === "note" && note.x, 528);
		const names = board.sessions.map((session) => session.name);
		assert.equal(
			note?.kind === "note" ? note.text : "",
			[
				"**Status · 14:05**",
				...names.map((name) => `**${name}**\n\n- Tests pass`),
			].join("\n\n"),
		);
		const audited = events.at(-1);
		assert.equal(
			audited?.action === "region-report" && audited.result,
			"noted",
		);
		assert.equal(
			(await send("POST", "/api/regions/other/report", {})).status,
			404,
		);
		assert.equal(
			(
				await fetch(`${base}/api/regions/region-1/report`, {
					method: "POST",
					headers: { ...authed, origin: "https://evil.example" },
				})
			).status,
			403,
		);
		assert.equal(
			(await send("DELETE", "/api/annotations/region-report-1", undefined))
				.status,
			204,
		);
		assert.equal(
			(await send("DELETE", "/api/regions/region-1", undefined)).status,
			204,
		);
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

	it("mirrors only interactive sessions running in cmux", async () => {
		const [background, inCmux] = board.sessions;
		assert.equal(
			await upgradeStatus(`/api/mirror/${background?.id}`, {
				...authed,
				origin,
			}),
			404,
		);
		assert.equal(
			await upgradeStatus(`/api/mirror/${inCmux?.id}`, {
				...authed,
				origin: "https://evil.example",
			}),
			403,
		);
		assert.equal(
			await upgradeStatus(`/api/mirror/${inCmux?.id}`, { origin }),
			401,
		);
		assert.equal(
			await upgradeStatus(`/api/mirror/${inCmux?.id}`, { ...authed, origin }),
			"open",
		);
		assert.deepEqual(mirrored, [`${inCmux?.id} me@example.com`]);
	});

	it("opens conversations for sessions on the board only", async () => {
		const id = board.sessions[0]?.id;
		assert.equal(
			await upgradeStatus(`/api/sessions/${id}/conversation?since=e1:7`, {
				...authed,
				origin: "https://evil.example",
			}),
			403,
		);
		assert.equal(
			await upgradeStatus(`/api/sessions/nope/conversation`, {
				...authed,
				origin,
			}),
			404,
		);
		assert.equal(
			await upgradeStatus(`/api/subagents/nope/conversation`, {
				...authed,
				origin,
			}),
			404,
		);
		assert.equal(
			await upgradeStatus(`/api/sessions/${id}/conversation?since=e1:7`, {
				...authed,
				origin,
			}),
			"open",
		);
		assert.deepEqual(conversed, [
			`session:/transcripts/${id}.jsonl 7 me@example.com`,
		]);
	});

	it("sends the board when a feed client connects", async () => {
		const frames = await new Promise<BoardFeed[]>((resolve) => {
			const received: BoardFeed[] = [];
			const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
				headers: { ...authed, origin },
			});
			socket.on("message", (data) => {
				received.push(JSON.parse(String(data)));
				if (received.length === 7) {
					socket.close();
					resolve(received);
				}
			});
		});
		assert.deepEqual(
			frames.map((frame) => frame.type),
			[
				"layout",
				"annotations",
				"colours",
				"regions",
				"comments",
				"usage",
				"board",
			],
		);
	});

	it("creates, replies to, moves, resolves and deletes comment threads", async () => {
		const created = await send("POST", "/api/comments", {
			x: 120,
			y: -48,
			text: "organise my board",
		});
		assert.equal(created.status, 201);
		const thread = await created.json();
		assert.equal(thread.id, "thread-1");
		assert.deepEqual([thread.x, thread.y], [120, -48]);
		assert.match(thread.sessionId, /^[0-9a-f-]{36}$/);
		assert.equal(
			(await send("POST", "/api/comments", { x: 1, y: 1, text: " " })).status,
			400,
		);
		assert.equal(
			(await send("POST", "/api/comments/thread-1/messages", { text: "more" }))
				.status,
			202,
		);
		assert.equal(
			(await send("POST", "/api/comments/nope/messages", { text: "more" }))
				.status,
			404,
		);
		assert.deepEqual(asked, [
			["thread-1", "organise my board"],
			["thread-1", "more"],
			["nope", "more"],
		]);
		const moved = await send("PATCH", "/api/comments/thread-1", {
			x: 240,
			y: 24,
			resolved: true,
		});
		assert.equal(moved.status, 200);
		const patched = await moved.json();
		assert.deepEqual([patched.x, patched.y, patched.resolved], [240, 24, true]);
		assert.equal(
			(await send("PATCH", "/api/comments/thread-1", { x: 1 })).status,
			400,
		);
		assert.equal(
			(
				await fetch(`${base}/api/comments/thread-1/cancel`, {
					method: "POST",
					headers: { ...authed, origin },
				})
			).status,
			204,
		);
		assert.equal(
			(
				await fetch(`${base}/api/comments/thread-1`, {
					method: "DELETE",
					headers: { ...authed, origin },
				})
			).status,
			204,
		);
		assert.deepEqual(cancelled, ["thread-1", "thread-1"]);
		assert.equal(
			(
				await fetch(`${base}/api/comments/thread-1`, {
					method: "DELETE",
					headers: { ...authed, origin },
				})
			).status,
			404,
		);
	});

	it("runs agent tools only for a live token from loopback", async () => {
		const call = (headers: Record<string, string>, body: unknown = {}) =>
			fetch(`${base}/api/agent/tools/board_snapshot`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
			});
		const token = agentTokens.issue("thread-9");
		assert.equal((await call({})).status, 401);
		assert.equal(
			(await call({ authorization: `Bearer ${"x".repeat(43)}` })).status,
			401,
		);
		assert.equal(
			(await call({ ...authed, origin })).status,
			401,
			"browser credentials do not open agent tools",
		);
		assert.equal(
			(
				await call({
					authorization: `Bearer ${token}`,
					"cf-connecting-ip": "203.0.113.9",
				})
			).status,
			401,
			"requests through the tunnel are refused",
		);
		const ok = await call({ authorization: `Bearer ${token}` });
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), { ok: true, text: "ran board_snapshot" });
		assert.equal(
			(await call({ authorization: `Bearer ${token}` }, { extra: 1 })).status,
			400,
		);
		assert.deepEqual(toolCalls, [["thread-9", { tool: "board_snapshot" }]]);
		agentTokens.revoke(token);
		assert.equal(
			(await call({ authorization: `Bearer ${token}` })).status,
			401,
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
