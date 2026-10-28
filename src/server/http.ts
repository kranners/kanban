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
import { parseToolCall } from "../agent/tools.ts";
import { maxImageBytes, maxPromptImages } from "../shared/promptImages.ts";
import type {
	Board,
	NodeRef,
	Session,
	TranscriptEntry,
} from "../shared/types.ts";
import type { AgentTokens } from "./agentAuth.ts";
import { type AnnotationStore, parseAnnotation } from "./annotations.ts";
import {
	type AttachHub,
	type AttachTarget,
	isValidShort,
	parseSize,
	type TerminalSize,
} from "./attach.ts";
import type { Audit } from "./audit.ts";
import { type Authenticate, originAllowed } from "./auth.ts";
import type { BoardAgent } from "./boardAgent.ts";
import type { BoardTools } from "./boardTools.ts";
import { type ColourStore, maxColours, parseColourUpdate } from "./colours.ts";
import type { SlashCommand } from "./commands.ts";
import {
	type CommentStore,
	isThreadId,
	maxThreads,
	parseCommentDraft,
	parseCommentPatch,
	parseMessage,
} from "./comments.ts";
import {
	type ConversationHub,
	type ConversationTarget,
	parseSince,
	type Since,
} from "./conversationHub.ts";
import type { ExitRunner } from "./exit.ts";
import type { Feed } from "./feed.ts";
import type { FileListing } from "./files.ts";
import { boardKeys, type LayoutStore, parseLayoutUpdate } from "./layout.ts";
import type { MirrorHub } from "./mirror.ts";
import {
	isRegionId,
	maxRegions,
	parseRegionDraft,
	parseRegionPatch,
	type RegionStore,
} from "./regions.ts";
import type { RegionReportRunner, ReportRunner } from "./reports.ts";
import { type SessionLauncher, validateNewSession } from "./sessions.ts";

export type BoardSource = {
	board(): Board;
	transcript(sessionId: string, limit: number): Promise<TranscriptEntry[]>;
	transcriptPath(node: NodeRef): string | null;
};

export type ServerDeps = {
	origins: string[];
	dist: string;
	authenticate: Authenticate;
	source: BoardSource;
	launch: SessionLauncher;
	exit: ExitRunner;
	report: ReportRunner;
	regionReport: RegionReportRunner;
	layout: LayoutStore;
	annotations: AnnotationStore;
	colours: ColourStore;
	regions: RegionStore;
	comments: CommentStore;
	agent: Omit<BoardAgent, "stopAll">;
	agentTokens: AgentTokens;
	tools: BoardTools;
	attach: AttachHub;
	mirror: MirrorHub;
	conversation: ConversationHub;
	files(cwd: string, query: string): Promise<FileListing>;
	commands(cwd: string): Promise<SlashCommand[]>;
	feed: Feed;
	audit: Audit;
};

export type Route =
	| { kind: "healthz" }
	| { kind: "transcript"; sessionId: string; limit: number }
	| { kind: "files"; sessionId: string; query: string }
	| { kind: "commands"; sessionId: string }
	| { kind: "create-session" }
	| { kind: "exit-session"; sessionId: string }
	| { kind: "report-session"; sessionId: string }
	| { kind: "update-layout" }
	| { kind: "put-annotation"; id: string }
	| { kind: "delete-annotation"; id: string }
	| { kind: "update-colour" }
	| { kind: "create-region" }
	| { kind: "update-region"; regionId: string }
	| { kind: "delete-region"; regionId: string }
	| { kind: "report-region"; regionId: string }
	| { kind: "create-comment" }
	| { kind: "reply-comment"; threadId: string }
	| { kind: "cancel-comment"; threadId: string }
	| { kind: "update-comment"; threadId: string }
	| { kind: "delete-comment"; threadId: string }
	| { kind: "agent-tool"; tool: string }
	| { kind: "static"; path: string }
	| { kind: "not-found" }
	| { kind: "method-not-allowed" };

export type UpgradeRoute =
	| { kind: "feed" }
	| { kind: "attach"; short: string; size: TerminalSize }
	| { kind: "mirror"; sessionId: string }
	| { kind: "conversation"; node: NodeRef; since: Since };

const maxBodyBytes = 128 * 1024;
const maxSessionBodyBytes =
	maxBodyBytes + maxPromptImages * Math.ceil((maxImageBytes * 4) / 3);
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
	const sessionList = path.match(
		/^\/api\/sessions\/([^/]+)\/(files|commands)$/,
	);
	if (sessionList?.[1]) {
		if (method !== "GET") return { kind: "method-not-allowed" };
		return sessionList[2] === "files"
			? {
					kind: "files",
					sessionId: sessionList[1],
					query: (url.searchParams.get("q") ?? "").slice(0, 200),
				}
			: { kind: "commands", sessionId: sessionList[1] };
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
	const report = path.match(/^\/api\/sessions\/([^/]+)\/report$/);
	if (report?.[1]) {
		return method === "POST"
			? { kind: "report-session", sessionId: report[1] }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/layout") {
		return method === "PUT"
			? { kind: "update-layout" }
			: { kind: "method-not-allowed" };
	}
	const annotation = path.match(/^\/api\/annotations\/([^/]+)$/);
	if (annotation?.[1]) {
		if (method === "PUT") return { kind: "put-annotation", id: annotation[1] };
		if (method === "DELETE") {
			return { kind: "delete-annotation", id: annotation[1] };
		}
		return { kind: "method-not-allowed" };
	}
	if (path === "/api/colours") {
		return method === "PUT"
			? { kind: "update-colour" }
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
	const regionReport = path.match(/^\/api\/regions\/([^/]+)\/report$/);
	if (regionReport?.[1] && isRegionId(regionReport[1])) {
		return method === "POST"
			? { kind: "report-region", regionId: regionReport[1] }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/comments") {
		return method === "POST"
			? { kind: "create-comment" }
			: { kind: "method-not-allowed" };
	}
	const commentAction = path.match(
		/^\/api\/comments\/([^/]+)\/(messages|cancel)$/,
	);
	if (commentAction?.[1] && isThreadId(commentAction[1])) {
		if (method !== "POST") return { kind: "method-not-allowed" };
		return commentAction[2] === "messages"
			? { kind: "reply-comment", threadId: commentAction[1] }
			: { kind: "cancel-comment", threadId: commentAction[1] };
	}
	const comment = path.match(/^\/api\/comments\/([^/]+)$/);
	if (comment?.[1] && isThreadId(comment[1])) {
		if (method === "PATCH")
			return { kind: "update-comment", threadId: comment[1] };
		if (method === "DELETE")
			return { kind: "delete-comment", threadId: comment[1] };
		return { kind: "method-not-allowed" };
	}
	const tool = path.match(/^\/api\/agent\/tools\/([a-z_]{1,64})$/);
	if (tool?.[1]) {
		return method === "POST"
			? { kind: "agent-tool", tool: tool[1] }
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
	const mirror = url.pathname.match(/^\/api\/mirror\/([\w-]{1,64})$/);
	if (mirror?.[1]) return { kind: "mirror", sessionId: mirror[1] };
	const conversation = url.pathname.match(
		/^\/api\/(sessions|subagents)\/([\w-]{1,64})\/conversation$/,
	);
	if (conversation?.[2]) {
		return {
			kind: "conversation",
			node: {
				kind: conversation[1] === "sessions" ? "session" : "subagent",
				id: conversation[2],
			},
			since: parseSince(url.searchParams.get("since")),
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

const readJson = (
	req: IncomingMessage,
	limit = maxBodyBytes,
): Promise<unknown> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
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

const mirrorTarget = (board: Board, sessionId: string): Session | null =>
	board.sessions.find(
		(session) =>
			session.id === sessionId &&
			session.kind === "interactive" &&
			session.cmux,
	) ?? null;

const conversationTarget = (
	source: BoardSource,
	node: NodeRef,
): ConversationTarget | null => {
	const board = source.board();
	const path = source.transcriptPath(node);
	if (node.kind === "subagent") {
		return path && board.subagents.some(({ id }) => id === node.id)
			? { kind: "subagent", id: node.id, path }
			: null;
	}
	const session = board.sessions.find(({ id }) => id === node.id);
	return session ? { kind: "session", session, path } : null;
};

export const createKanbanServer = (deps: ServerDeps): Server => {
	const sockets = new WebSocketServer({
		noServer: true,
		maxPayload: 1024 * 1024,
	});

	const readBody = async (
		req: IncomingMessage,
		res: ServerResponse,
		limit = maxBodyBytes,
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
			return { body: await readJson(req, limit) };
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
		const read = await readBody(req, res, maxSessionBodyBytes);
		if (!read) return;
		const request = await validateNewSession(read.body);
		if ("error" in request) {
			return sendJson(res, 400, { ok: false, error: request.error });
		}
		const settle = request.at && deps.layout.expect(request.cwd, request.at);
		const result = await deps.launch(request);
		deps.audit({
			action: "session-create",
			cwd: request.cwd,
			name: request.name ?? null,
			images: request.images?.length ?? 0,
			identity,
			result: result.ok ? result.short : result.error,
		});
		if (settle) {
			settle(result.ok ? result.short : null);
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
		if (!deps.exit(session, force, identity)) {
			return sendJson(res, 409, {
				ok: false,
				error: "This session is already exiting",
			});
		}
		sendJson(res, 202, { ok: true });
	};

	const reportSession = (
		req: IncomingMessage,
		res: ServerResponse,
		sessionId: string,
		identity: string | null,
	) => {
		if (!originAllowed(req, deps.origins)) return sendError(res, 403);
		const session = deps.source
			.board()
			.sessions.find((session) => session.id === sessionId);
		if (!session) return sendError(res, 404);
		if (!deps.report(session, identity)) {
			return sendJson(res, 409, {
				ok: false,
				error: "This session is already writing a status report",
			});
		}
		sendJson(res, 202, { ok: true });
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

	const putAnnotation = async (
		req: IncomingMessage,
		res: ServerResponse,
		id: string,
	) => {
		const read = await readBody(req, res);
		if (!read) return;
		const annotation = parseAnnotation(id, read.body);
		if ("error" in annotation) {
			return sendJson(res, 400, { ok: false, error: annotation.error });
		}
		const stored = deps.annotations.put(annotation);
		if ("error" in stored) {
			return sendJson(res, 409, { ok: false, error: stored.error });
		}
		res.writeHead(204, { "cache-control": "no-store" });
		res.end();
	};

	const deleteAnnotation = (
		req: IncomingMessage,
		res: ServerResponse,
		id: string,
	) => {
		if (!originAllowed(req, deps.origins)) return sendError(res, 403);
		if (!deps.annotations.remove(id)) return sendError(res, 404);
		res.writeHead(204, { "cache-control": "no-store" });
		res.end();
	};

	const updateColour = async (req: IncomingMessage, res: ServerResponse) => {
		const read = await readBody(req, res);
		if (!read) return;
		const update = parseColourUpdate(read.body);
		if ("error" in update) {
			return sendJson(res, 400, { ok: false, error: update.error });
		}
		if (!deps.colours.set(update)) {
			return sendJson(res, 409, {
				ok: false,
				error: `The board holds at most ${maxColours} project colours`,
			});
		}
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

	const reportRegion = (
		req: IncomingMessage,
		res: ServerResponse,
		regionId: string,
		identity: string | null,
	) => {
		if (!originAllowed(req, deps.origins)) return sendError(res, 403);
		const region = deps.regions
			.current()
			.find((region) => region.id === regionId);
		if (!region) return sendError(res, 404);
		if (!deps.regionReport(region, identity)) {
			return sendJson(res, 409, {
				ok: false,
				error: "This project is already writing a status report",
			});
		}
		sendJson(res, 202, { ok: true });
	};

	const createComment = async (req: IncomingMessage, res: ServerResponse) => {
		const read = await readBody(req, res);
		if (!read) return;
		const draft = parseCommentDraft(read.body);
		if ("error" in draft) {
			return sendJson(res, 400, { ok: false, error: draft.error });
		}
		const thread = deps.comments.create(draft);
		if (!thread) {
			return sendJson(res, 409, {
				ok: false,
				error: `The board holds at most ${maxThreads} comments`,
			});
		}
		const asked = deps.agent.ask(thread.id, draft.text);
		if ("error" in asked) {
			return sendJson(res, asked.status, { ok: false, error: asked.error });
		}
		sendJson(res, 201, deps.comments.get(thread.id) ?? thread);
	};

	const replyComment = async (
		req: IncomingMessage,
		res: ServerResponse,
		threadId: string,
	) => {
		const read = await readBody(req, res);
		if (!read) return;
		const text = parseMessage(read.body);
		if (typeof text !== "string") {
			return sendJson(res, 400, { ok: false, error: text.error });
		}
		const asked = deps.agent.ask(threadId, text);
		if ("error" in asked) {
			return sendJson(res, asked.status, { ok: false, error: asked.error });
		}
		sendJson(res, 202, { ok: true });
	};

	const cancelComment = (
		req: IncomingMessage,
		res: ServerResponse,
		threadId: string,
	) => {
		if (!originAllowed(req, deps.origins)) return sendError(res, 403);
		if (!deps.comments.get(threadId)) return sendError(res, 404);
		deps.agent.cancel(threadId);
		res.writeHead(204, { "cache-control": "no-store" });
		res.end();
	};

	const updateComment = async (
		req: IncomingMessage,
		res: ServerResponse,
		threadId: string,
	) => {
		const read = await readBody(req, res);
		if (!read) return;
		const patch = parseCommentPatch(read.body);
		if ("error" in patch) {
			return sendJson(res, 400, { ok: false, error: patch.error });
		}
		const thread = deps.comments.update(threadId, (current) => ({
			...current,
			...patch,
		}));
		if (!thread) return sendError(res, 404);
		sendJson(res, 200, thread);
	};

	const deleteComment = (
		req: IncomingMessage,
		res: ServerResponse,
		threadId: string,
	) => {
		if (!originAllowed(req, deps.origins)) return sendError(res, 403);
		deps.agent.cancel(threadId);
		if (!deps.comments.remove(threadId)) return sendError(res, 404);
		res.writeHead(204, { "cache-control": "no-store" });
		res.end();
	};

	const agentTool = async (
		req: IncomingMessage,
		res: ServerResponse,
		tool: string,
	) => {
		const threadId = deps.agentTokens.verify(req);
		if (!threadId) return sendError(res, 401);
		if (!req.headers["content-type"]?.startsWith("application/json")) {
			return sendError(res, 415);
		}
		let body: unknown;
		try {
			body = await readJson(req);
		} catch {
			return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
		}
		const call = parseToolCall(tool, body);
		if ("error" in call) {
			return sendJson(res, 400, { ok: false, error: call.error });
		}
		const outcome = await deps.tools(threadId, call);
		if (!outcome.ok) {
			return sendJson(res, 422, { ok: false, error: outcome.error });
		}
		sendJson(res, 200, { ok: true, text: outcome.text });
	};

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const route = matchRoute(req.method ?? "GET", requestUrl(req));
		if (route.kind === "healthz") return sendJson(res, 200, { ok: true });
		if (route.kind === "agent-tool") return agentTool(req, res, route.tool);
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
			case "files":
			case "commands": {
				const session = deps.source
					.board()
					.sessions.find(({ id }) => id === route.sessionId);
				if (!session) return sendError(res, 404);
				if (route.kind === "commands") {
					return sendJson(res, 200, await deps.commands(session.cwd));
				}
				const listing = await deps.files(session.cwd, route.query);
				return sendJson(res, listing.ok ? 200 : 422, listing);
			}
			case "create-session":
				return createSession(req, res, auth.identity);
			case "exit-session":
				return exitSession(req, res, route.sessionId, auth.identity);
			case "report-session":
				return reportSession(req, res, route.sessionId, auth.identity);
			case "update-layout":
				return updateLayout(req, res);
			case "put-annotation":
				return putAnnotation(req, res, route.id);
			case "delete-annotation":
				return deleteAnnotation(req, res, route.id);
			case "update-colour":
				return updateColour(req, res);
			case "create-region":
				return createRegion(req, res);
			case "update-region":
				return updateRegion(req, res, route.regionId);
			case "delete-region":
				return deleteRegion(req, res, route.regionId);
			case "report-region":
				return reportRegion(req, res, route.regionId, auth.identity);
			case "create-comment":
				return createComment(req, res);
			case "reply-comment":
				return replyComment(req, res, route.threadId);
			case "cancel-comment":
				return cancelComment(req, res, route.threadId);
			case "update-comment":
				return updateComment(req, res, route.threadId);
			case "delete-comment":
				return deleteComment(req, res, route.threadId);
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
		const mirrored =
			route.kind === "mirror"
				? mirrorTarget(deps.source.board(), route.sessionId)
				: null;
		if (route.kind === "mirror" && mirrored === null) {
			return rejectUpgrade(socket, 404);
		}
		const conversation =
			route.kind === "conversation"
				? conversationTarget(deps.source, route.node)
				: null;
		if (route.kind === "conversation" && conversation === null) {
			return rejectUpgrade(socket, 404);
		}
		sockets.handleUpgrade(req, socket, head, (ws) => {
			ws.on("error", () => ws.terminate());
			try {
				if (route.kind === "feed") deps.feed.add(ws);
				else if (target && route.kind === "attach") {
					deps.attach.open(ws, target, route.size, auth.identity);
				} else if (mirrored) deps.mirror.open(ws, mirrored, auth.identity);
				else if (conversation && route.kind === "conversation") {
					deps.conversation.open(ws, conversation, route.since, auth.identity);
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
