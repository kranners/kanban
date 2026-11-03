import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
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
import { maxImageBytes, maxPromptImages } from "../shared/promptImages.ts";
import { linkRefusal } from "../shared/reach.ts";
import {
	type AccountResult,
	type Board,
	landingId,
	type NodeRef,
	type RelationEnd,
	type RemoteHost,
	type Session,
	type TranscriptEntry,
} from "../shared/types.ts";
import { type AnnotationStore, parseAnnotation } from "./annotations.ts";
import type { Announcer } from "./announce.ts";
import {
	type AttachHub,
	type AttachTarget,
	isValidShort,
	parseSize,
	type TerminalSize,
} from "./attach.ts";
import type { Audit } from "./audit.ts";
import {
	type Authenticate,
	type AuthResult,
	originAllowed,
	type RunnerTokenCheck,
	runnerIdentity,
} from "./auth.ts";
import type { BoardTools } from "./boardTools.ts";
import { type Butler, butlerAllowed, type SelfFixAction } from "./butler.ts";
import { type ColourStore, maxColours, parseColourUpdate } from "./colours.ts";
import type { SlashCommand } from "./commands.ts";
import {
	type CommentStore,
	isThreadId,
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
import { type DocsHttp, type DocsReply, maxDocPutBytes } from "./docsHttp.ts";
import type { ExitRunner } from "./exit.ts";
import type { Feed } from "./feed.ts";
import type { FileListing } from "./files.ts";
import type { FolderPicker } from "./folders.ts";
import { type IgnoreStore, maxIgnores, parseIgnoreUpdate } from "./ignores.ts";
import { boardKeys, type LayoutStore, parseLayoutUpdate } from "./layout.ts";
import { fromLoopback } from "./loopback.ts";
import type { MirrorHub } from "./mirror.ts";
import { type PeerHook, parsePeerHookInput } from "./peers.ts";
import { type Permissions, parseGrants } from "./permissions.ts";
import {
	isRegionId,
	maxRegions,
	parseRegionDraft,
	parseRegionPatch,
	type RegionStore,
} from "./regions.ts";
import {
	isRelationId,
	parseRelationDraft,
	type RelationStore,
} from "./relations.ts";
import { reportShotContentType, reportShotName } from "./reportShots.ts";
import type { RegionReportRunner, ReportRunner } from "./reports.ts";
import type { RunnerHub } from "./runners.ts";
import {
	isAccountNumber,
	type SessionLauncher,
	validateNewSession,
} from "./sessions.ts";

export type BoardSource = {
	board(): Board;
	transcript(sessionId: string, limit: number): Promise<TranscriptEntry[]>;
	transcriptPath(node: NodeRef): string | null;
};

export type ServerDeps = {
	origins: string[];
	dist: string;
	authenticate: Authenticate;
	/** Checks the shared runner bearer token; absent means none is configured. */
	runnerToken?: RunnerTokenCheck;
	source: BoardSource;
	launch: SessionLauncher;
	exit: ExitRunner;
	report: ReportRunner;
	regionReport: RegionReportRunner;
	layout: LayoutStore;
	annotations: AnnotationStore;
	colours: ColourStore;
	ignores: IgnoreStore;
	regions: RegionStore;
	relations: RelationStore;
	docs: DocsHttp;
	comments: CommentStore;
	tools: BoardTools;
	butler?: Butler;
	/** The token the board's page sends with every message to Butler. */
	csrf: string;
	peerHook: PeerHook;
	attach: AttachHub;
	mirror: MirrorHub;
	conversation: ConversationHub;
	files(cwd: string, query: string): Promise<FileListing>;
	commands(cwd: string): Promise<SlashCommand[]>;
	cloudBlocker(
		cwd: string,
		runsOn: string,
		account?: number,
	): Promise<string | null>;
	remoteHosts(
		account?: number,
	): Promise<{ ok: true; value: RemoteHost[] } | { ok: false; error: string }>;
	pickFolder: FolderPicker;
	makeDefault(account: number): Promise<AccountResult>;
	runners?: Pick<
		RunnerHub,
		"register" | "heartbeat" | "poll" | "requeue" | "complete" | "views"
	>;
	permissions: Permissions;
	announce: Announcer;
	feed: Feed;
	audit: Audit;
	reportShots?: string;
};

export type Route =
	| { kind: "healthz" }
	| { kind: "report-shot"; name: string }
	| { kind: "transcript"; sessionId: string; limit: number }
	| { kind: "files"; sessionId: string; query: string }
	| { kind: "commands"; sessionId: string }
	| { kind: "create-session" }
	| { kind: "cloud-blocker"; cwd: string; runsOn: string; account?: number }
	| { kind: "remote-hosts"; account?: number }
	| { kind: "pick-folder" }
	| { kind: "set-default-account" }
	| { kind: "exit-session"; sessionId: string }
	| { kind: "report-session"; sessionId: string }
	| { kind: "survey-permissions" }
	| { kind: "grant-permissions" }
	| { kind: "announce" }
	| { kind: "update-layout" }
	| { kind: "put-annotation"; id: string }
	| { kind: "delete-annotation"; id: string }
	| { kind: "update-colour" }
	| { kind: "update-ignore" }
	| { kind: "create-region" }
	| { kind: "update-region"; regionId: string }
	| { kind: "delete-region"; regionId: string }
	| { kind: "report-region"; regionId: string }
	| { kind: "create-relation" }
	| { kind: "delete-relation"; relationId: string }
	| { kind: "docs-tool"; tool: string }
	| { kind: "doc-file"; store: string; path: string }
	| { kind: "put-doc-file"; store: string; path: string }
	| { kind: "delete-doc-file"; store: string; path: string }
	| { kind: "create-doc-store" }
	| { kind: "rename-doc-store"; store: string }
	| { kind: "delete-doc-store"; store: string }
	| { kind: "csrf" }
	| { kind: "create-comment" }
	| { kind: "reply-comment"; threadId: string }
	| { kind: "cancel-comment"; threadId: string }
	| { kind: "update-comment"; threadId: string }
	| { kind: "delete-comment"; threadId: string }
	| { kind: "butler-tool"; tool: string }
	| { kind: "self-fix-action"; id: string; action: SelfFixAction }
	| { kind: "peer-hook" }
	| { kind: "runners" }
	| { kind: "runner-register" }
	| { kind: "runner-heartbeat"; runnerId: string }
	| { kind: "runner-poll"; runnerId: string; waitMs: number }
	| { kind: "runner-complete"; runnerId: string; commandId: string }
	| { kind: "static"; path: string }
	| { kind: "not-found" }
	| { kind: "method-not-allowed" };

export type UpgradeRoute =
	| { kind: "feed" }
	| { kind: "attach"; short: string; size: TerminalSize }
	| { kind: "mirror"; sessionId: string }
	| { kind: "conversation"; node: NodeRef; since: Since };

const maxBodyBytes = 128 * 1024;
const maxHookBytes = 64 * 1024 * 1024;
const maxRunnerBytes = 256 * 1024;

const parseWait = (raw: string | null): number => {
	const wait = Number(raw);
	return Number.isFinite(wait) && wait >= 0 ? Math.min(wait, 30_000) : 0;
};
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

const accountQuery = (url: URL): { account?: number } => {
	const account = Number(url.searchParams.get("account"));
	return isAccountNumber(account) ? { account } : {};
};

export const matchRoute = (method: string, url: URL): Route => {
	const path = url.pathname;
	if (path === "/healthz") {
		return method === "GET"
			? { kind: "healthz" }
			: { kind: "method-not-allowed" };
	}
	const shot = path.match(/^\/api\/report-shots\/([^/]+)$/);
	if (shot?.[1]) {
		if (method !== "GET" && method !== "HEAD")
			return { kind: "method-not-allowed" };
		return reportShotName.test(shot[1])
			? { kind: "report-shot", name: shot[1] }
			: { kind: "not-found" };
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
	if (path === "/api/cloud-blocker") {
		return method === "GET"
			? {
					kind: "cloud-blocker",
					cwd: url.searchParams.get("cwd") ?? "",
					runsOn: url.searchParams.get("runsOn") ?? "cloud",
					...accountQuery(url),
				}
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/remote-hosts") {
		return method === "GET"
			? { kind: "remote-hosts", ...accountQuery(url) }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/accounts/default") {
		return method === "POST"
			? { kind: "set-default-account" }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/folder-picker") {
		return method === "POST"
			? { kind: "pick-folder" }
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
	if (path === "/api/permissions/survey") {
		return method === "POST"
			? { kind: "survey-permissions" }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/permissions/grant") {
		return method === "POST"
			? { kind: "grant-permissions" }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/announce") {
		return method === "POST"
			? { kind: "announce" }
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
	if (path === "/api/ignores") {
		return method === "PUT"
			? { kind: "update-ignore" }
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
	if (path === "/api/csrf") {
		return method === "GET" ? { kind: "csrf" } : { kind: "method-not-allowed" };
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
	if (path === "/api/relations") {
		return method === "POST"
			? { kind: "create-relation" }
			: { kind: "method-not-allowed" };
	}
	const relation = path.match(/^\/api\/relations\/([^/]+)$/);
	if (relation?.[1] && isRelationId(relation[1])) {
		return method === "DELETE"
			? { kind: "delete-relation", relationId: relation[1] }
			: { kind: "method-not-allowed" };
	}
	const docsTool = path.match(/^\/api\/docs\/tools\/([a-z_]{1,64})$/);
	if (docsTool?.[1]) {
		return method === "POST"
			? { kind: "docs-tool", tool: docsTool[1] }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/docs") {
		return method === "POST"
			? { kind: "create-doc-store" }
			: { kind: "method-not-allowed" };
	}
	const docStore = path.match(
		/^\/api\/docs\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/,
	);
	if (docStore?.[1]) {
		if (method === "PATCH")
			return { kind: "rename-doc-store", store: docStore[1] };
		if (method === "DELETE")
			return { kind: "delete-doc-store", store: docStore[1] };
		return { kind: "method-not-allowed" };
	}
	const docFile = path.match(
		/^\/api\/docs\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/files\/(.+)$/,
	);
	if (docFile?.[1] && docFile[2]) {
		const located = { store: docFile[1], path: docFile[2] };
		if (method === "GET" || method === "HEAD") {
			return { kind: "doc-file", ...located };
		}
		if (method === "PUT") return { kind: "put-doc-file", ...located };
		if (method === "DELETE") return { kind: "delete-doc-file", ...located };
		return { kind: "method-not-allowed" };
	}
	const fixAction = path.match(
		/^\/api\/butler\/self-fixes\/([0-9]{8}-[0-9]{6}-[0-9]+)\/(archive|dismiss)$/,
	);
	if (fixAction?.[1] && fixAction[2]) {
		return method === "POST"
			? {
					kind: "self-fix-action",
					id: fixAction[1],
					action: fixAction[2] as SelfFixAction,
				}
			: { kind: "method-not-allowed" };
	}
	const butlerTool = path.match(/^\/api\/butler\/tools\/([a-z_]{1,64})$/);
	if (butlerTool?.[1]) {
		return method === "POST"
			? { kind: "butler-tool", tool: butlerTool[1] }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/runners") {
		return method === "GET"
			? { kind: "runners" }
			: { kind: "method-not-allowed" };
	}
	if (path === "/api/runners/register") {
		return method === "POST"
			? { kind: "runner-register" }
			: { kind: "method-not-allowed" };
	}
	const runner = path.match(
		/^\/api\/runners\/([a-z0-9][a-z0-9-]{0,39})\/(heartbeat|commands)(?:\/([\w-]{1,64}))?$/,
	);
	if (runner?.[1]) {
		const runnerId = runner[1];
		if (runner[2] === "heartbeat" && !runner[3]) {
			return method === "POST"
				? { kind: "runner-heartbeat", runnerId }
				: { kind: "method-not-allowed" };
		}
		if (runner[2] === "commands" && runner[3]) {
			return method === "POST"
				? { kind: "runner-complete", runnerId, commandId: runner[3] }
				: { kind: "method-not-allowed" };
		}
		if (runner[2] === "commands") {
			return method === "GET"
				? {
						kind: "runner-poll",
						runnerId,
						waitMs: parseWait(url.searchParams.get("wait")),
					}
				: { kind: "method-not-allowed" };
		}
	}
	if (path === "/api/hooks/peers") {
		return method === "POST"
			? { kind: "peer-hook" }
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

const hashedStatic = /^\/(?:chunks|assets)\//;

export const cacheControlFor = (dist: string, file: string): string =>
	file.startsWith(join(dist, "assets", sep)) ||
	file.startsWith(join(dist, "chunks", sep))
		? "public, max-age=31536000, immutable"
		: "no-cache";

const serveStatic = async (
	req: IncomingMessage,
	res: ServerResponse,
	dist: string,
	urlPath: string,
	head: boolean,
) => {
	const requested = staticFile(dist, urlPath);
	if (requested === null) return sendError(res, 404);
	const found = await isFile(requested);
	if (!found && hashedStatic.test(urlPath)) return sendError(res, 404);
	const file = found ? requested : join(dist, "index.html");
	let info: Stats;
	try {
		info = await stat(file);
		if (!info.isFile()) return sendError(res, 404);
	} catch {
		return sendError(res, 404);
	}
	const headers: Record<string, string> = {
		"content-type": contentTypeFor(file),
		"cache-control": cacheControlFor(dist, file),
		"x-content-type-options": "nosniff",
		"content-security-policy": "frame-ancestors 'none'",
		"x-frame-options": "DENY",
	};
	if (!file.endsWith(".html")) {
		const etag = `"${info.size}-${Math.floor(info.mtimeMs)}"`;
		headers.etag = etag;
		if (req.headers["if-none-match"] === etag) {
			res.writeHead(304, headers);
			return res.end();
		}
	}
	res.writeHead(200, headers);
	if (head) return res.end();
	pipeline(createReadStream(file), res, (error) => {
		if (error) res.destroy();
	});
};

const serveReportShot = async (
	res: ServerResponse,
	dir: string | undefined,
	name: string,
	head: boolean,
) => {
	const type = reportShotContentType(name);
	if (!dir || !type) return sendError(res, 404);
	const file = join(dir, name);
	if (!(await isFile(file))) return sendError(res, 404);
	res.writeHead(200, {
		"content-type": type,
		"cache-control": "private, max-age=31536000, immutable",
		"x-content-type-options": "nosniff",
		"content-security-policy": "default-src 'none'; frame-ancestors 'none'",
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
	return session
		? { short, cwd: session.cwd, configDir: session.configDir }
		: null;
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

export const newCsrfToken = (): string => randomBytes(24).toString("base64url");

export const csrfMatches = (sent: string, expected: string): boolean => {
	const a = createHash("sha256").update(sent).digest();
	const b = createHash("sha256").update(expected).digest();
	return expected.length > 0 && timingSafeEqual(a, b);
};

export const createKanbanServer = (deps: ServerDeps): Server => {
	const sockets = new WebSocketServer({
		noServer: true,
		maxPayload: 1024 * 1024,
	});
	// A request carrying the runner token comes from a machine, not a browser,
	// so there is no cross-site request to guard against with the Origin check.
	const byToken = new WeakSet<IncomingMessage>();
	const originOk = (req: IncomingMessage) =>
		byToken.has(req) || originAllowed(req, deps.origins);
	const authenticate = async (req: IncomingMessage): Promise<AuthResult> => {
		if (deps.runnerToken?.(req) === "ok") {
			byToken.add(req);
			return { ok: true, identity: runnerIdentity };
		}
		return deps.authenticate(req);
	};

	const readBody = async (
		req: IncomingMessage,
		res: ServerResponse,
		limit = maxBodyBytes,
	): Promise<{ body: unknown } | null> => {
		if (!originOk(req)) {
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
			account: request.account ?? null,
			runsOn: request.runsOn,
			identity,
			result: result.ok ? landingId(result) : result.error,
		});
		if (settle) {
			settle(result.ok ? result : null);
			deps.layout.observe(deps.source.board());
		}
		sendJson(res, result.ok ? 201 : 422, result);
	};

	const setDefaultAccount = async (
		req: IncomingMessage,
		res: ServerResponse,
		identity: string | null,
	) => {
		const read = await readBody(req, res);
		if (!read) return;
		const account = (read.body as { account?: unknown } | null)?.account;
		if (!isAccountNumber(account)) {
			return sendJson(res, 400, {
				ok: false,
				error: "account must be a positive whole number",
			});
		}
		const result = await deps.makeDefault(account);
		deps.audit({
			action: "account-default",
			account,
			identity,
			result: result.ok ? "ok" : result.error,
		});
		sendJson(res, result.ok ? 200 : 422, result);
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
		if (!originOk(req)) return sendError(res, 403);
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

	const surveyPermissions = async (
		req: IncomingMessage,
		res: ServerResponse,
	) => {
		if (!originOk(req)) return sendError(res, 403);
		sendJson(res, 200, await deps.permissions.survey());
	};

	const grantPermissions = async (
		req: IncomingMessage,
		res: ServerResponse,
		identity: string | null,
	) => {
		const read = await readBody(req, res);
		if (!read) return;
		const parsed = parseGrants(read.body);
		if ("error" in parsed) {
			return sendJson(res, 400, { ok: false, error: parsed.error });
		}
		const results = await deps.permissions.grant(parsed.grants);
		for (const [index, result] of results.entries()) {
			deps.audit({
				action: "permissions-grant",
				sessionId: result.sessionId,
				rules: parsed.grants[index]?.rules ?? [],
				identity,
				result: result.ok ? `added ${result.added.length}` : result.error,
			});
		}
		sendJson(res, 200, results);
	};

	const announce = async (
		req: IncomingMessage,
		res: ServerResponse,
		identity: string | null,
	) => {
		const read = await readBody(req, res);
		if (!read) return;
		const text = (read.body as Record<string, unknown> | null)?.text;
		if (typeof text !== "string") {
			return sendJson(res, 400, { ok: false, error: "text must be a string" });
		}
		const result = await deps.announce(text, identity);
		sendJson(res, result.ok ? 200 : 400, result);
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
		if (!originOk(req)) return sendError(res, 403);
		// Aaron deleting a self-fix's card closes it, which archives the fix.
		const card = deps.annotations.current()[id];
		if (card?.kind === "butler-card" && card.selfFix && deps.butler) {
			const outcome = deps.butler.selfFixAction(card.selfFix, "archive");
			if (!outcome.ok) {
				return sendJson(res, 409, { ok: false, error: outcome.error });
			}
			res.writeHead(204, { "cache-control": "no-store" });
			return res.end();
		}
		if (!deps.annotations.remove(id)) return sendError(res, 404);
		res.writeHead(204, { "cache-control": "no-store" });
		res.end();
	};

	/** Aaron's own board actions on a self-fix's card, from its menu. */
	const selfFixAction = (
		req: IncomingMessage,
		res: ServerResponse,
		id: string,
		action: SelfFixAction,
	) => {
		if (!originOk(req)) return sendError(res, 403);
		if (!deps.butler) return sendError(res, 404);
		const outcome = deps.butler.selfFixAction(id, action);
		if (!outcome.ok) {
			return sendJson(res, 409, { ok: false, error: outcome.error });
		}
		sendJson(res, 200, { ok: true, text: outcome.text });
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

	const updateIgnore = async (req: IncomingMessage, res: ServerResponse) => {
		const read = await readBody(req, res);
		if (!read) return;
		const update = parseIgnoreUpdate(read.body, Date.now());
		if ("error" in update) {
			return sendJson(res, 400, { ok: false, error: update.error });
		}
		if (!deps.ignores.set(update)) {
			return sendJson(res, 409, {
				ok: false,
				error: `The board ignores at most ${maxIgnores} projects at once`,
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
		if (!originOk(req)) return sendError(res, 403);
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
		if (!originOk(req)) return sendError(res, 403);
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

	const unlinkable = (end: RelationEnd): string | null => {
		const session = deps.source
			.board()
			.sessions.find(({ id }) => id === end.id);
		return session ? linkRefusal(session) : `No session ${end.id} on the board`;
	};

	const createRelation = async (req: IncomingMessage, res: ServerResponse) => {
		const read = await readBody(req, res);
		if (!read) return;
		const draft = parseRelationDraft(read.body);
		if ("error" in draft) {
			return sendJson(res, 400, { ok: false, error: draft.error });
		}
		const refusal = unlinkable(draft.from) ?? unlinkable(draft.to);
		if (refusal) return sendJson(res, 422, { ok: false, error: refusal });
		const relation = deps.relations.create(draft);
		if ("error" in relation) {
			return sendJson(res, 409, { ok: false, error: relation.error });
		}
		sendJson(res, 201, relation);
	};

	const sendDocsReply = (res: ServerResponse, reply: DocsReply) => {
		if (reply.body === undefined) {
			res.writeHead(reply.status, { "cache-control": "no-store" });
			res.end();
			return;
		}
		sendJson(res, reply.status, reply.body);
	};

	const docsReply = async (
		req: IncomingMessage,
		res: ServerResponse,
		act: (body: unknown) => DocsReply | Promise<DocsReply>,
		limit = maxBodyBytes,
	) => {
		const read = await readBody(req, res, limit);
		if (!read) return;
		sendDocsReply(res, await act(read.body));
	};

	const docsReplyWithoutBody = async (
		req: IncomingMessage,
		res: ServerResponse,
		act: () => Promise<DocsReply>,
	) => {
		if (!originOk(req)) return sendError(res, 403);
		sendDocsReply(res, await act());
	};

	const deleteRelation = (
		req: IncomingMessage,
		res: ServerResponse,
		relationId: string,
	) => {
		if (!originOk(req)) return sendError(res, 403);
		if (!deps.relations.remove(relationId)) return sendError(res, 404);
		res.writeHead(204, { "cache-control": "no-store" });
		res.end();
	};

	// Only the board's own page may speak to Butler as Aaron: a browser
	// request with the board's origin, its sign-in, and the token the page
	// fetched from this server, which no other origin can read. A runner's
	// bearer token is for machines and never stands in for Aaron.
	const butlerRequestOk = (req: IncomingMessage): boolean => {
		if (byToken.has(req) || !originAllowed(req, deps.origins)) return false;
		const sent = req.headers["x-kanban-csrf"];
		return typeof sent === "string" && csrfMatches(sent, deps.csrf);
	};

	const refuseButler = (res: ServerResponse) =>
		sendJson(res, 403, {
			ok: false,
			error: "Only the board's own page can message Butler; reload it",
		});

	const createComment = async (req: IncomingMessage, res: ServerResponse) => {
		const read = await readBody(req, res);
		if (!read) return;
		const draft = parseCommentDraft(read.body);
		if ("error" in draft) {
			return sendJson(res, 400, { ok: false, error: draft.error });
		}
		if (!butlerRequestOk(req)) return refuseButler(res);
		const inbox = deps.butler?.inbox;
		if (!inbox) {
			return sendJson(res, 409, {
				ok: false,
				error: "Butler is not set up on this board",
			});
		}
		const started = inbox.start(draft);
		if ("error" in started) {
			return sendJson(res, started.status, {
				ok: false,
				error: started.error,
			});
		}
		sendJson(res, 201, started);
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
		const thread = deps.comments.get(threadId);
		if (!thread) return sendError(res, 404);
		if (thread.to !== "butler") {
			return sendJson(res, 410, {
				ok: false,
				error:
					"The board agent has been retired; press / to message Butler instead",
			});
		}
		if (!butlerRequestOk(req)) return refuseButler(res);
		const sent = deps.butler?.inbox?.send(threadId, text) ?? {
			error: "Butler is not set up on this board",
			status: 409 as const,
		};
		if ("error" in sent) {
			return sendJson(res, sent.status, { ok: false, error: sent.error });
		}
		sendJson(res, 202, { ok: true });
	};

	const cancelComment = (
		req: IncomingMessage,
		res: ServerResponse,
		threadId: string,
	) => {
		if (!originOk(req)) return sendError(res, 403);
		const thread = deps.comments.get(threadId);
		if (!thread) return sendError(res, 404);
		deps.butler?.inbox?.cancel(threadId);
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
		if (!originOk(req)) return sendError(res, 403);
		if (!deps.comments.remove(threadId)) return sendError(res, 404);
		res.writeHead(204, { "cache-control": "no-store" });
		res.end();
	};

	const butlerTool = async (
		req: IncomingMessage,
		res: ServerResponse,
		tool: string,
	) => {
		if (!deps.butler || !butlerAllowed(req)) return sendError(res, 403);
		if (!req.headers["content-type"]?.startsWith("application/json")) {
			return sendError(res, 415);
		}
		let body: unknown;
		try {
			body = await readJson(req);
		} catch {
			return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
		}
		const outcome = await deps.butler.tool(tool, body);
		if (!outcome.ok) {
			return sendJson(res, 422, { ok: false, error: outcome.error });
		}
		sendJson(res, 200, { ok: true, text: outcome.text });
	};

	const peerHook = async (req: IncomingMessage, res: ServerResponse) => {
		if (!fromLoopback(req) || req.headers.origin !== undefined) {
			return sendError(res, 403);
		}
		if (!req.headers["content-type"]?.startsWith("application/json")) {
			return sendError(res, 415);
		}
		let body: unknown;
		try {
			body = await readJson(req, maxHookBytes);
		} catch {
			return sendError(res, 400);
		}
		const input = parsePeerHookInput(body);
		const output = input && deps.peerHook(input);
		if (!output) {
			res.writeHead(204, { "cache-control": "no-store" });
			return res.end();
		}
		sendJson(res, 200, output);
	};

	// Runners speak only with the shared token: no Access, no browser.
	const runnerCall = async (
		req: IncomingMessage,
		res: ServerResponse,
		route: Extract<
			Route,
			{
				kind:
					| "runner-register"
					| "runner-heartbeat"
					| "runner-poll"
					| "runner-complete";
			}
		>,
	) => {
		const token = deps.runnerToken?.(req) ?? "none";
		if (token !== "ok") return sendError(res, token === "none" ? 401 : 403);
		const hub = deps.runners;
		if (!hub) return sendError(res, 404);
		if (route.kind === "runner-poll") {
			let gone = false;
			res.on("close", () => {
				gone = true;
			});
			const commands = await hub.poll(route.runnerId, route.waitMs);
			if (commands === null) return sendError(res, 404);
			if (gone) {
				// The runner hung up first: keep the commands for its next poll.
				hub.requeue(route.runnerId, commands);
				return;
			}
			return sendJson(res, 200, { commands });
		}
		if (!req.headers["content-type"]?.startsWith("application/json")) {
			return sendError(res, 415);
		}
		let body: unknown;
		try {
			body = await readJson(req, maxRunnerBytes);
		} catch {
			return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
		}
		if (route.kind === "runner-register") {
			const registered = hub.register(body);
			return sendJson(res, registered.ok ? 200 : 400, registered);
		}
		if (route.kind === "runner-heartbeat") {
			const beat = hub.heartbeat(route.runnerId, body);
			if (beat === "unknown") return sendError(res, 404);
			if (beat !== "ok") return sendJson(res, 400, { ok: false, ...beat });
			res.writeHead(204, { "cache-control": "no-store" });
			return res.end();
		}
		if (!hub.complete(route.runnerId, route.commandId, body)) {
			return sendError(res, 404);
		}
		res.writeHead(204, { "cache-control": "no-store" });
		res.end();
	};

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const route = matchRoute(req.method ?? "GET", requestUrl(req));
		if (
			route.kind === "runner-register" ||
			route.kind === "runner-heartbeat" ||
			route.kind === "runner-poll" ||
			route.kind === "runner-complete"
		) {
			return runnerCall(req, res, route);
		}
		if (route.kind === "healthz") return sendJson(res, 200, { ok: true });
		if (route.kind === "butler-tool") return butlerTool(req, res, route.tool);
		if (route.kind === "peer-hook") return peerHook(req, res);
		if (route.kind === "docs-tool") return deps.docs.tool(req, res, route.tool);
		const auth = await authenticate(req);
		if (!auth.ok) return sendError(res, auth.status);
		switch (route.kind) {
			case "not-found":
				return sendError(res, 404);
			case "method-not-allowed":
				return sendError(res, 405);
			case "report-shot":
				return serveReportShot(
					res,
					deps.reportShots,
					route.name,
					req.method === "HEAD",
				);
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
			case "cloud-blocker":
				return sendJson(res, 200, {
					reason: await deps.cloudBlocker(
						route.cwd,
						route.runsOn,
						route.account,
					),
				});
			case "remote-hosts": {
				const hosts = await deps.remoteHosts(route.account);
				return sendJson(
					res,
					200,
					hosts.ok ? { hosts: hosts.value } : { hosts: [], error: hosts.error },
				);
			}
			case "set-default-account":
				return setDefaultAccount(req, res, auth.identity);
			case "runners":
				return sendJson(res, 200, { runners: deps.runners?.views() ?? [] });
			case "pick-folder":
				if (!originOk(req)) return sendError(res, 403);
				return sendJson(res, 200, await deps.pickFolder());
			case "exit-session":
				return exitSession(req, res, route.sessionId, auth.identity);
			case "report-session":
				return reportSession(req, res, route.sessionId, auth.identity);
			case "survey-permissions":
				return surveyPermissions(req, res);
			case "grant-permissions":
				return grantPermissions(req, res, auth.identity);
			case "announce":
				return announce(req, res, auth.identity);
			case "update-layout":
				return updateLayout(req, res);
			case "put-annotation":
				return putAnnotation(req, res, route.id);
			case "delete-annotation":
				return deleteAnnotation(req, res, route.id);
			case "self-fix-action":
				return selfFixAction(req, res, route.id, route.action);
			case "update-colour":
				return updateColour(req, res);
			case "update-ignore":
				return updateIgnore(req, res);
			case "create-region":
				return createRegion(req, res);
			case "update-region":
				return updateRegion(req, res, route.regionId);
			case "delete-region":
				return deleteRegion(req, res, route.regionId);
			case "report-region":
				return reportRegion(req, res, route.regionId, auth.identity);
			case "create-relation":
				return createRelation(req, res);
			case "delete-relation":
				return deleteRelation(req, res, route.relationId);
			case "doc-file":
				return deps.docs.file(req, res, route.store, route.path);
			case "create-doc-store":
				return docsReply(req, res, (body) => deps.docs.createStore(body));
			case "rename-doc-store":
				return docsReply(req, res, (body) =>
					deps.docs.renameStore(route.store, body),
				);
			case "delete-doc-store":
				return docsReplyWithoutBody(req, res, () =>
					deps.docs.deleteStore(route.store),
				);
			case "put-doc-file":
				return docsReply(
					req,
					res,
					(body) => deps.docs.putFile(route.store, route.path, body),
					maxDocPutBytes,
				);
			case "delete-doc-file":
				return docsReplyWithoutBody(req, res, () =>
					deps.docs.deleteFile(route.store, route.path),
				);
			case "csrf":
				return sendJson(res, 200, { token: deps.csrf });
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
				return serveStatic(
					req,
					res,
					deps.dist,
					route.path,
					req.method === "HEAD",
				);
		}
	};

	const upgrade = async (
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => {
		const route = matchUpgrade(requestUrl(req));
		if (route === null) return rejectUpgrade(socket, 404);
		const viaToken = deps.runnerToken?.(req) === "ok";
		if (!viaToken && !originAllowed(req, deps.origins)) {
			return rejectUpgrade(socket, 403);
		}
		const auth: AuthResult = viaToken
			? { ok: true, identity: runnerIdentity }
			: await deps.authenticate(req);
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
