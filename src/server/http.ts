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
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { Board, TranscriptEntry } from "../shared/types.ts";
import {
	type AttachHub,
	type AttachTarget,
	isValidShort,
	parseSize,
	type TerminalSize,
} from "./attach.ts";
import type { Audit } from "./audit.ts";
import { type Authenticate, originAllowed } from "./auth.ts";
import type { Feed } from "./feed.ts";
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
	attach: AttachHub;
	feed: Feed;
	audit: Audit;
};

export type Route =
	| { kind: "healthz" }
	| { kind: "transcript"; sessionId: string; limit: number }
	| { kind: "create-session" }
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
	});
	if (head) return res.end();
	createReadStream(file).pipe(res);
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

	const createSession = async (
		req: IncomingMessage,
		res: ServerResponse,
		identity: string | null,
	) => {
		if (!originAllowed(req, deps.origins)) return sendError(res, 403);
		if (!req.headers["content-type"]?.startsWith("application/json")) {
			return sendError(res, 415);
		}
		let body: unknown;
		try {
			body = await readJson(req);
		} catch {
			return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
		}
		const request = await validateNewSession(body);
		if ("error" in request) {
			return sendJson(res, 400, { ok: false, error: request.error });
		}
		const result = await deps.launch(request);
		deps.audit({
			action: "session-create",
			cwd: request.cwd,
			name: request.name,
			identity,
			result: result.ok ? result.short : result.error,
		});
		sendJson(res, result.ok ? 201 : 422, result);
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
