import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
	STATUS_CODES,
} from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { type Duplex, pipeline } from "node:stream";
import { WebSocketServer } from "ws";
import type { Board, ExitResult, TranscriptEntry } from "../shared/types.ts";
import {
	type AttachHub,
	type AttachTarget,
	isValidShort,
	parseSize,
	type TerminalSize,
} from "./attach.ts";
import type { Audit } from "./audit.ts";
import { type Authenticate, originAllowed } from "./auth.ts";
import type { SessionExiter } from "./exit.ts";
import type { Feed } from "./feed.ts";
import { boardKeys, type LayoutStore, parseLayoutUpdate } from "./layout.ts";
import {
	isRegionId,
	maxRegions,
	parseRegionDraft,
	parseRegionPatch,
	type RegionStore,
} from "./regions.ts";
import { type SessionLauncher, validateNewSession } from "./sessions.ts";

export type BoardSource = {
	board(): Board;
	transcript(sessionId: string, limit: number): Promise<TranscriptEntry[]>;
};

export type ServerDeps = {
	origins: string[];
	dist: string;
	authenticate: Authenticate;
	source: BoardSource;
	launch: SessionLauncher;
	exit: SessionExiter;
	layout: LayoutStore;
	regions: RegionStore;
	attach: AttachHub;
	feed: Feed;
	audit: Audit;
};

export type Route =
	| { kind: "healthz" }
	| { kind: "transcript"; sessionId: string; limit: number }
	| { kind: "create-session" }
	| { kind: "exit-session"; sessionId: string }
	| { kind: "update-layout" }
	| { kind: "create-region" }
	| { kind: "update-region"; regionId: string }
	| { kind: "delete-region"; regionId: string }
	| { kind: "static"; path: string }
	| { kind: "not-found" }
	| { kind: "method-not-allowed" };

export type UpgradeRoute =
	| { kind: "feed" }
	| { kind: "attach"; short: string; size: TerminalSize };

const maxBodyBytes = 64 * 1024;
const defaultTranscriptLimit = 200;
const maxTranscriptLimit = 1000;

const contentTypes: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
};

export const contentTypeFor = (path: string): string =>
	contentTypes[extname(path).toLowerCase()] ?? "application/octet-stream";

const parseLimit = (raw: string | null): number => {
	const limit = Number(raw);
	if (raw === null || !Number.isInteger(limit) || limit < 1) {
		return defaultTranscriptLimit;
	}
	return Math.min(limit, maxTranscriptLimit);
};

export const matchRoute = (method: string, url: URL): Route => {
	const path = url.pathname;
	if (path === "/healthz") {
		return method === "GET"
			? { kind: "healthz" }
			: { kind: "method-not-allowed" };
	}
	const transcript = path.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
	if (transcript?.[1]) {
		if (method !== "GET") return { kind: "method-not-allowed" };
		return {
			kind: "transcript",
			sessionId: transcript[1],
			limit: parseLimit(url.searchParams.get("limit")),
		};
	}
	if (path === "/api/sessions") {
		return method === "POST"
			? { kind: "create-session" }
			: { kind: "method-not-allowed" };
	}
	const exit = path.match(/^\/api\/sessions\/([^/]+)\/exit$/);
	if (exit?.[1]) {
		return method === "POST"
			? { kind: "exit-session", sessionId: exit[1] }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/layout") {
		return method === "PUT"
			? { kind: "update-layout" }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/regions") {
		return method === "POST"
			? { kind: "create-region" }
			: { kind: "method-not-allowed" };
	}
	const region = path.match(/^\/api\/regions\/([^/]+)$/);
	if (region?.[1] && isRegionId(region[1])) {
		if (method === "PATCH")
			return { kind: "update-region", regionId: region[1] };
		if (method === "DELETE")
			return { kind: "delete-region", regionId: region[1] };
		return { kind: "method-not-allowed" };
	}
	if (path === "/api" || path.startsWith("/api/")) return { kind: "not-found" };
	if (method !== "GET" && method !== "HEAD")
		return { kind: "method-not-allowed" };
	return { kind: "static", path };
};

export const matchUpgrade = (url: URL): UpgradeRoute | null => {
	if (url.pathname === "/api/feed") return { kind: "feed" };
	const attach = url.pathname.match(/^\/api\/attach\/([^/]+)$/);
	if (attach?.[1] && isValidShort(attach[1])) {
		return {
			kind: "attach",
			short: attach[1],
			size: parseSize(
				url.searchParams.get("cols"),
				url.searchParams.get("rows"),
			),
		};
	}
	return null;
};

export const staticFile = (dist: string, urlPath: string): string | null => {
	let decoded: string;
	try {
		decoded = decodeURIComponent(urlPath);
	} catch {
		return null;
	}
	if (decoded.includes("\0")) return null;
	const root = normalize(dist);
	const file = normalize(join(root, decoded));
	return file === root || file.startsWith(root + sep) ? file : null;
};

const requestUrl = (req: IncomingMessage): URL =>
	new URL(req.url ?? "/", "http://kanban.invalid");

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(body));
};

const sendError = (res: ServerResponse, status: number) =>
	sendJson(res, status, { error: STATUS_CODES[status] });

const readJson = (req: IncomingMessage): Promise<unknown> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBodyBytes) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});

const isFile = async (path: string): Promise<boolean> => {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
};

const serveStatic = async (
	res: ServerResponse,
	dist: string,
	urlPath: string,
	head: boolean,
) => {
	const requested = staticFile(dist, urlPath);
	if (requested === null) return sendError(res, 404);
	const file = (await isFile(requested)) ? requested : join(dist, "index.html");
	if (!(await isFile(file))) return sendError(res, 404);
	res.writeHead(200, {
		"content-type": contentTypeFor(file),
		"cache-control": file.endsWith(".html")
			? "no-cache"
			: "public, max-age=3600",
		"x-content-type-options": "nosniff",
		"content-security-policy": "frame-ancestors 'none'",
		"x-frame-options": "DENY",
	});
	if (head) return res.end();
	pipeline(createReadStream(file), res, (error) => {
		if (error) res.destroy();
	});
};

const rejectUpgrade = (socket: Duplex, status: number) => {
	socket.end(
		`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
	);
};

const attachTarget = (board: Board, short: string): AttachTarget | null => {
	const session = board.sessions.find(
		(session) =>
			session.short === short &&
			session.kind === "background" &&
			session.attachable,
	);
	return session ? { short, cwd: session.cwd } : null;
};

export const createKanbanServer = (deps: ServerDeps): Server => {
	const sockets = new WebSocketServer({
		noServer: true,
		maxPayload: 1024 * 1024,
	});

	const exiting = new Set<string>();

	const readBody = async (
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<{ body: unknown } | null> => {
		if (!originAllowed(req, deps.origins)) {
			sendError(res, 403);
			return null;
		}
		if (!req.headers["content-type"]?.startsWith("application/json")) {
			sendError(res, 415);
			return null;
		}
		try {
			return { body: await readJson(req) };
		} catch {
			sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
			return null;
		}
	};

	const createSession = async (
		req: IncomingMessage,
		res: ServerResponse,
		identity: string | null,
	) => {
		const read = await readBody(req, res);
		if (!read) return;
		const request = await validateNewSession(read.body);
		if ("error" in request) {
			return sendJson(res, 400, { ok: false, error: request.error });
		}
		const result = await deps.launch(request);
		deps.audit({
			action: "session-create",
			cwd: request.cwd,
			name: request.name ?? null,
			identity,
			result: result.ok ? result.short : result.error,
		});
		if (result.ok && request.at) {
			deps.layout.expect(result.short, request.at);
			deps.layout.observe(deps.source.board());
		}
		sendJson(res, result.ok ? 201 : 422, result);
	};

	const exitSession = async (
		req: IncomingMessage,
		res: ServerResponse,
		sessionId: string,
		identity: string | null,
	) => {
		const read = await readBody(req, res);
		if (!read) return;
		const force = (read.body as Record<string, unknown> | null)?.force;
		if (typeof force !== "boolean") {
			return sendJson(res, 400, {
				ok: false,
				error: "force must be a boolean",
			});
		}
		const session = deps.source
			.board()
			.sessions.find((session) => session.id === sessionId);
		if (!session) return sendError(res, 404);
		if (exiting.has(session.id)) {
			return sendJson(res, 409, {
				ok: false,
				error: "This session is already exiting",
			});
		}
		exiting.add(session.id);
		sendJson(res, 202, { ok: true });
		const result = await deps
			.exit(session, force)
			.catch(
				(error: unknown): ExitResult => ({
					ok: false,
					error: `Exit failed: ${(error as Error).message}`,
				}),
			)
			.finally(() => exiting.delete(session.id));
		deps.audit({
			action: "session-exit",
			sessionId: session.id,
			short: session.short,
			kind: session.kind,
			force,
			identity,
			result: !result.ok
				? `error: ${result.error}`
				: result.exited
					? "exited"
					: `not ready: ${result.reason}`,
		});
		deps.feed.exit(session.id, result);
	};

	const updateLayout = async (req: IncomingMessage, res: ServerResponse) => {
		const read = await readBody(req, res);
		if (!read) return;
		const update = parseLayoutUpdate(read.body);
		if ("error" in update) {
			return sendJson(res, 400, { ok: false, error: update.error });
		}
		if (!boardKeys(deps.source.board()).has(update.key)) {
			return sendError(res, 404);
		}
		deps.layout.set(update);
		res.writeHead(204, { "cache-control": "no-store" });
		res.end();
	};

	const createRegion = async (req: IncomingMessage, res: ServerResponse) => {
		const read = await readBody(req, res);
		if (!read) return;
		const draft = await parseRegionDraft(read.body);
		if ("error" in draft) {
			return sendJson(res, 400, { ok: false, error: draft.error });
		}
		const region = deps.regions.create(draft);
		if (!region) {
			return sendJson(res, 409, {
				ok: false,
				error: `The board holds at most ${maxRegions} project regions`,
			});
		}
		sendJson(res, 201, region);
	};

	const updateRegion = async (
		req: IncomingMessage,
		res: ServerResponse,
		regionId: string,
	) => {
		const read = await readBody(req, res);
		if (!read) return;
		const patch = parseRegionPatch(read.body);
		if ("error" in patch) {
			return sendJson(res, 400, { ok: false, error: patch.error });
		}
		const region = deps.regions.update(regionId, patch);
		if (!region) return sendError(res, 404);
		sendJson(res, 200, region);
	};

	const deleteRegion = (
		req: IncomingMessage,
		res: ServerResponse,
		regionId: string,
	) => {
		if (!originAllowed(req, deps.origins)) return sendError(res, 403);
		if (!deps.regions.remove(regionId)) return sendError(res, 404);
		res.writeHead(204, { "cache-control": "no-store" });
		res.end();
	};

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const route = matchRoute(req.method ?? "GET", requestUrl(req));
		if (route.kind === "healthz") return sendJson(res, 200, { ok: true });
		const auth = await deps.authenticate(req);
		if (!auth.ok) return sendError(res, auth.status);
		switch (route.kind) {
			case "not-found":
				return sendError(res, 404);
			case "method-not-allowed":
				return sendError(res, 405);
			case "transcript": {
				const known = deps.source
					.board()
					.sessions.some((session) => session.id === route.sessionId);
				if (!known) return sendError(res, 404);
				return sendJson(
					res,
					200,
					await deps.source.transcript(route.sessionId, route.limit),
				);
			}
			case "create-session":
				return createSession(req, res, auth.identity);
			case "exit-session":
				return exitSession(req, res, route.sessionId, auth.identity);
			case "update-layout":
				return updateLayout(req, res);
			case "create-region":
				return createRegion(req, res);
			case "update-region":
				return updateRegion(req, res, route.regionId);
			case "delete-region":
				return deleteRegion(req, res, route.regionId);
			case "static":
				return serveStatic(res, deps.dist, route.path, req.method === "HEAD");
		}
	};

	const upgrade = async (
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => {
		const route = matchUpgrade(requestUrl(req));
		if (route === null) return rejectUpgrade(socket, 404);
		if (!originAllowed(req, deps.origins)) return rejectUpgrade(socket, 403);
		const auth = await deps.authenticate(req);
		if (!auth.ok) return rejectUpgrade(socket, auth.status);
		const target =
			route.kind === "attach"
				? attachTarget(deps.source.board(), route.short)
				: null;
		if (route.kind === "attach" && target === null) {
			return rejectUpgrade(socket, 404);
		}
		sockets.handleUpgrade(req, socket, head, (ws) => {
			ws.on("error", () => ws.terminate());
			try {
				if (route.kind === "feed") deps.feed.add(ws);
				else if (target && route.kind === "attach") {
					deps.attach.open(ws, target, route.size, auth.identity);
				}
			} catch (error) {
				console.error(`${route.kind} socket failed`, error);
				ws.close(1011, "server error");
			}
		});
	};

	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			console.error("request failed", error);
			if (!res.headersSent) sendError(res, 500);
			else res.destroy();
		});
	});
	server.on("upgrade", (req, socket, head) => {
		socket.on("error", () => socket.destroy());
		upgrade(req, socket, head).catch((error: unknown) => {
			console.error("upgrade failed", error);
			rejectUpgrade(socket, 500);
		});
	});
	return server;
};
