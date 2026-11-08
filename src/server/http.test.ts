import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import WebSocket from "ws";
import type { ToolCall } from "../agent/tools.ts";
import { startRunnerClient } from "../runner/client.ts";
import type { SessionManager } from "../runner/sessions.ts";
import type { PermissionGrant } from "../shared/permissions.ts";
import type {
	RunnerLaunch,
	RunnerSession,
	RunnerView,
} from "../shared/runners.ts";
import {
	type Annotations,
	type Board,
	type BoardFeed,
	type DocFile,
	type DocStore,
	type ExitResult,
	landingId,
	maxNoteText,
	type NewSessionRequest,
	noDigests,
	type Point,
	type Relation,
	type Session,
} from "../shared/types.ts";
import { createAnnotationStore } from "./annotations.ts";
import type { AttachHub } from "./attach.ts";
import type { AuditEvent } from "./audit.ts";
import { type Authenticate, runnerTokenCheck } from "./auth.ts";
import { createButler } from "./butler.ts";
import { createColourStore } from "./colours.ts";
import { type CommentStore, createCommentStore } from "./comments.ts";
import { createDocStoreRegistry, type DocStoreRegistry } from "./docStores.ts";
import { loadDocFiles } from "./docs.ts";
import { createDocsHttp } from "./docsHttp.ts";
import { type Answer, createExitRunner } from "./exit.ts";
import { createFeed } from "./feed.ts";
import {
	contentTypeFor,
	createKanbanServer,
	matchRoute,
	matchUpgrade,
	staticFile,
} from "./http.ts";
import { createIgnoreStore } from "./ignores.ts";
import { createLastRunStore, type LastRunStore } from "./lastRuns.ts";
import { createLayoutStore } from "./layout.ts";
import { createMessageEdgeStore } from "./messageEdges.ts";
import { createRegionStore } from "./regions.ts";
import { createRelationStore } from "./relations.ts";
import { createRegionReportRunner, createReportRunner } from "./reports.ts";
import { createRunnerHub } from "./runners.ts";
import { boardParts, createUndo, yourGapMs } from "./undo.ts";

const route = (method: string, path: string) =>
	matchRoute(method, new URL(path, "http://x"));

describe("matchRoute", () => {
	it("parses the archive's routes and Tidy", () => {
		assert.deepEqual(route("GET", "/api/archive?kind=change&q=fix"), {
			kind: "archive",
			query: { kind: "change", q: "fix" },
		});
		assert.deepEqual(route("POST", "/api/archive/thread-123456/restore"), {
			kind: "archive-restore",
			id: "thread-123456",
		});
		assert.deepEqual(route("POST", "/api/archive/session:abc/restore"), {
			kind: "archive-restore",
			id: "session:abc",
		});
		assert.deepEqual(route("POST", "/api/archive"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("POST", "/api/tidy"), { kind: "tidy" });
		assert.deepEqual(route("GET", "/api/tidy"), {
			kind: "method-not-allowed",
		});
	});

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
		assert.deepEqual(route("POST", "/api/permissions/survey"), {
			kind: "survey-permissions",
		});
		assert.deepEqual(route("POST", "/api/permissions/grant"), {
			kind: "grant-permissions",
		});
		assert.deepEqual(route("GET", "/api/permissions/grant"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(
			route("GET", "/api/folders?runsOn=runner_jimbo&path=~/x"),
			{
				kind: "browse-folders",
				runsOn: "runner_jimbo",
				path: "~/x",
			},
		);
		assert.deepEqual(route("GET", "/api/folders"), {
			kind: "browse-folders",
			runsOn: "local",
			path: null,
		});
		assert.deepEqual(route("POST", "/api/folders"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("POST", "/api/announce"), { kind: "announce" });
		assert.deepEqual(route("GET", "/api/announce"), {
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
		assert.deepEqual(route("PUT", "/api/ignores"), { kind: "update-ignore" });
		assert.deepEqual(route("POST", "/api/notifications"), {
			kind: "update-notifications",
		});
		assert.deepEqual(route("GET", "/api/notifications"), {
			kind: "method-not-allowed",
		});
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

	it("parses link and doc store routes", () => {
		assert.deepEqual(route("POST", "/api/relations"), {
			kind: "create-relation",
		});
		assert.deepEqual(route("DELETE", "/api/relations/rel-1"), {
			kind: "delete-relation",
			relationId: "rel-1",
		});
		assert.deepEqual(route("GET", "/api/relations"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("POST", "/api/docs/tools/write_doc"), {
			kind: "docs-tool",
			tool: "write_doc",
		});
		assert.deepEqual(route("GET", "/api/docs/tools/write_doc"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("POST", "/api/runners/docs/write_doc"), {
			kind: "runner-docs-tool",
			tool: "write_doc",
		});
		assert.deepEqual(route("GET", "/api/runners/docs/write_doc"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("GET", "/api/docs/d-1/files/guides/setup.md"), {
			kind: "doc-file",
			store: "d-1",
			path: "guides/setup.md",
		});
		assert.deepEqual(route("HEAD", "/api/docs/d-1/files/a%20b.png"), {
			kind: "doc-file",
			store: "d-1",
			path: "a%20b.png",
		});
		assert.deepEqual(route("PUT", "/api/docs/d-1/files/index.md"), {
			kind: "put-doc-file",
			store: "d-1",
			path: "index.md",
		});
		assert.deepEqual(route("DELETE", "/api/docs/d-1/files/index.md"), {
			kind: "delete-doc-file",
			store: "d-1",
			path: "index.md",
		});
		assert.deepEqual(route("POST", "/api/docs/d-1/files/index.md"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("POST", "/api/docs"), { kind: "create-doc-store" });
		assert.deepEqual(route("GET", "/api/docs"), { kind: "method-not-allowed" });
		assert.deepEqual(route("PATCH", "/api/docs/d-1"), {
			kind: "rename-doc-store",
			store: "d-1",
		});
		assert.deepEqual(route("DELETE", "/api/docs/d-1"), {
			kind: "delete-doc-store",
			store: "d-1",
		});
		assert.deepEqual(route("GET", "/api/docs/d-1"), {
			kind: "method-not-allowed",
		});
		assert.deepEqual(route("DELETE", "/api/docs/../x"), { kind: "not-found" });
		assert.deepEqual(route("GET", "/api/docs/d-1/files/"), {
			kind: "not-found",
		});
	});

	it("keeps static paths inside dist", () => {
		assert.equal(staticFile("/srv/dist", "/app.js"), "/srv/dist/app.js");
		assert.equal(staticFile("/srv/dist", "/"), "/srv/dist/");
		assert.equal(staticFile("/srv/dist", "/../secret"), null);
		assert.equal(staticFile("/srv/dist", "/%2e%2e/secret"), null);
		assert.equal(staticFile("/srv/dist", "/%E0%A4%A"), null);
		assert.equal(contentTypeFor("/a/b.JS"), "text/javascript; charset=utf-8");
		assert.equal(contentTypeFor("/a/b.woff2"), "font/woff2");
		assert.equal(contentTypeFor("/assets/content-AB12.webp"), "image/webp");
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

const backgroundPair = (t: TestContext) => {
	const worker: Session = {
		...(board.sessions[1] as Session),
		id: "66666666-7777-8888-9999-111111111111",
		name: "acme-worker",
		kind: "background",
	};
	board.sessions.push(worker);
	t.after(() => {
		board.sessions.pop();
	});
	return [board.sessions[0], worker].map(
		(session) => ({ kind: "session", id: session?.id ?? "" }) as const,
	);
};

describe("createKanbanServer", () => {
	const token = "good";
	const runnerSecret = "r".repeat(40);
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
	let lastRuns: LastRunStore;
	let ignoresFile = "";
	let ignoresSaved = () => Promise.resolve();
	let relationsFile = "";
	let relationsSaved = () => Promise.resolve();
	let docStores: DocStoreRegistry;
	const attached: string[] = [];
	const mirrored: string[] = [];
	const conversed: string[] = [];
	const events: AuditEvent[] = [];
	const origins: string[] = [];
	let comments: CommentStore;
	let threadCount = 0;
	let butlerIds = 0;
	const toolCalls: [string, ToolCall][] = [];
	const madeDefault: number[] = [];
	const granted: PermissionGrant[] = [];
	const announced: [string, string | null][] = [];
	const browsed: [string, string | null][] = [];
	const refusedRunners: string[] = [];
	const runnerHub = createRunnerHub({
		hubHome: "/Users/me",
		local: () => ({ name: "pilot", usage: null, cap: 4, sessions: [] }),
		onChange: () => {},
	});
	let base = "";
	let origin = "";
	let close = () => {};

	before(async () => {
		const dist = await mkdtemp(join(tmpdir(), "kanban-dist-"));
		await mkdir(join(dist, "assets"));
		await writeFile(join(dist, "index.html"), "<!doctype html>board");
		await writeFile(join(dist, "assets", "app.js"), "export {}");
		await writeFile(join(dist, "app.js"), "export const app = 1");
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
		lastRuns = createLastRunStore({
			file: join(dist, "state", "last-runs.json"),
			initial: {},
			onChange: (next) => feed?.lastRuns(next),
		});
		ignoresFile = join(dist, "state", "ignores.json");
		const ignores = createIgnoreStore({
			file: ignoresFile,
			initial: {},
			now: Date.now,
			onChange: (next) => feed?.ignores(next),
		});
		ignoresSaved = ignores.saved;
		const regions = createRegionStore({
			file: join(dist, "state", "regions.json"),
			initial: [],
			onChange: (next) => feed?.regions(next),
			newId: () => "region-1",
		});
		relationsFile = join(dist, "state", "relations.json");
		const relations = createRelationStore({
			file: relationsFile,
			initial: [],
			onChange: (next) => feed?.relations(next),
		});
		relationsSaved = relations.saved;
		const docFiles = await loadDocFiles({
			dir: join(dist, "state", "docs"),
			onChange: () => feed?.docs(),
		});
		docStores = createDocStoreRegistry({
			file: join(dist, "state", "doc-stores.json"),
			initial: [],
			files: docFiles,
			onChange: () => feed?.docs(),
		});
		comments = createCommentStore({
			file: join(dist, "state", "comments.json"),
			initial: [],
			onChange: (thread) => feed?.comment(thread),
			onRemove: (threads) => feed?.comments(threads),
			newId: () => `thread-${++threadCount}`,
		});
		let tick = 0;
		const undo = createUndo({
			parts: boardParts({
				layout: store,
				annotations,
				regions,
				colours,
				relations,
			}),
			now: () => (tick += yourGapMs * 2),
		});
		feed = createFeed({
			build: () => "build-1",
			comments: comments.current,
			layout: store.current,
			annotations: annotations.current,
			colours: colours.current,
			ignores: ignores.current,
			regions: regions.current,
			board: () => board,
			usage: () => ({
				session: null,
				week: null,
				samples: [],
				checkedAt: null,
				error: null,
				accounts: [],
			}),
			digests: () => noDigests,
			relations: relations.current,
			docs: docFiles.index,
			docStores: docStores.current,
		});
		const messageEdges = createMessageEdgeStore({});
		const server = createKanbanServer({
			origins,
			dist,
			csrf: "test-csrf",
			build: () => "build-1",
			authenticate,
			runnerToken: runnerTokenCheck(runnerSecret),
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
				return request.runsOn === "cloud"
					? { ok: true, id: "session_01cloud" }
					: { ok: true, short: "feedbeef" };
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
			layout: undo.track(
				"layout",
				{
					...store,
					expect: (cwd, at) => {
						const settle = store.expect(cwd, at);
						return (landing) => {
							if (landing) expected.push([landingId(landing), at]);
							settle(landing);
						};
					},
				},
				["set", "setMany"],
			),
			undo,
			annotations: undo.track("annotations", annotations, ["put", "remove"]),
			colours,
			lastRuns,
			ignores,
			regions,
			relations,
			docs: createDocsHttp({ files: docFiles, stores: docStores }),
			comments,
			tools: async (threadId, call) => {
				toolCalls.push([threadId, call]);
				return { ok: true, text: `ran ${call.tool}` };
			},
			butler: createButler({
				source: {
					board: () => board,
					transcript: async () => [],
					transcriptPath: () => null,
				},
				layout: store,
				annotations,
				regions,
				tools: async () => ({ ok: true, text: "ran" }),
				audit: (event) => events.push(event),
				file: join(dist, "state", "butler.json"),
				initial: [],
				onChange: () => {},
				comments,
				edges: messageEdges,
				newId: () => `msg-${++butlerIds}`,
			}),
			edges: messageEdges,
			peerHook: ({ event, sessionId }) =>
				sessionId === "with-peers"
					? {
							hookSpecificOutput: {
								hookEventName: event,
								additionalContext: "peers here",
							},
						}
					: null,
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
				waiting: async () => ({ ok: true, value: [] }),
				prompt: async () => ({ ok: false, error: "fake" }),
				attached: () => [],
				release() {},
			},
			files: async (cwd, query) => ({ ok: true, files: [`${cwd}:${query}`] }),
			commands: async (cwd) => [
				{ name: "compact", description: cwd, source: "built-in" },
			],
			cloudBlocker: async (cwd, runsOn, account) =>
				runsOn.startsWith("env_")
					? `${runsOn} on account ${account} serves /elsewhere, not this folder`
					: cwd === "/Users/me/notes"
						? "This folder isn't a git repository"
						: null,
			remoteHosts: async (account) =>
				account === 9
					? { ok: false, error: "Cloud API unreachable: offline" }
					: {
							ok: true,
							value: [
								{
									id: "env_01host",
									name: "pilot:acme-api:6f62",
									machine: `pilot-${account ?? "default"}`,
									directory: "/Users/me/dev/acme-api",
								},
							],
						},
			pickFolder: async () => ({ ok: true, path: "/Users/me/dev/picked" }),
			browseFolders: async (runsOn, path) => {
				browsed.push([runsOn, path]);
				return path === "/nope"
					? { ok: false, error: "/nope isn't a folder on jimbo" }
					: {
							ok: true,
							listing: {
								machine: "jimbo",
								path: path ?? "/home/me/workspace",
								home: "/home/me",
								parent: "/home/me",
								folders: ["acme"],
								truncated: false,
							},
						};
			},
			runners: {
				...runnerHub,
				refused: (name) => {
					refusedRunners.push(name);
					runnerHub.refused(name);
				},
			},
			permissions: {
				survey: async () => ({ entries: [] }),
				grant: async (grants) => {
					granted.push(...grants);
					return grants.map(({ sessionId, rules }) => ({
						sessionId,
						settingsPath: `/settings/${sessionId}`,
						ok: true,
						added: rules,
					}));
				},
			},
			announce: async (text, identity) => {
				announced.push([text, identity]);
				return text === "!rm"
					? { ok: false, error: "A prompt cannot start with !" }
					: {
							ok: true,
							deliveries: [{ id: "s1", name: "one", ok: true, error: null }],
						};
			},
			makeDefault: async (account) => {
				madeDefault.push(account);
				return account === 9
					? { ok: false, error: "no account 9" }
					: { ok: true };
			},
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
			runnerHub.stopAll();
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

	it("admits the runner token in place of Access, without an Origin", async () => {
		const bearer = { authorization: `Bearer ${runnerSecret}` };
		assert.equal((await fetch(`${base}/`, { headers: bearer })).status, 200);
		const placed = await fetch(`${base}/api/folder-picker`, {
			method: "POST",
			headers: bearer,
		});
		assert.equal(placed.status, 200);
		assert.equal(
			(
				await fetch(`${base}/`, {
					headers: { authorization: `Bearer ${"x".repeat(40)}` },
				})
			).status,
			401,
		);
		const browser = await fetch(`${base}/api/folder-picker`, {
			method: "POST",
			headers: authed,
		});
		assert.equal(browser.status, 403);
	});

	it("lets only the runner token speak the runner protocol", async () => {
		const register = (headers: Record<string, string>) =>
			fetch(`${base}/api/runners/register`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: "{}",
			});
		assert.equal((await register({})).status, 401);
		assert.equal((await register(authed)).status, 401);
		assert.equal(
			(await register({ authorization: `Bearer ${"x".repeat(40)}` })).status,
			403,
		);
		const wrongToken = await fetch(`${base}/api/runners/register`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${"x".repeat(40)}`,
			},
			body: JSON.stringify({ name: "spike" }),
		});
		assert.equal(wrongToken.status, 403, "still refused");
		assert.deepEqual(refusedRunners, ["spike"], "and named for the board");
		const malformed = await register({
			authorization: `Bearer ${runnerSecret}`,
		});
		assert.equal(malformed.status, 400);
		assert.equal(
			(
				await fetch(`${base}/api/runners/ghost/commands?wait=0`, {
					headers: { authorization: `Bearer ${runnerSecret}` },
				})
			).status,
			404,
		);
	});

	it("gives a runner's sessions the doc tools with the runner token alone", async () => {
		const call = (tool: string, headers: Record<string, string>, body = {}) =>
			fetch(`${base}/api/runners/docs/${tool}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-kanban-session": "runner-session-1",
					...headers,
				},
				body: JSON.stringify(body),
			});
		const bearer = { authorization: `Bearer ${runnerSecret}` };
		assert.equal((await call("list_doc_stores", {})).status, 401);
		assert.equal((await call("list_doc_stores", authed)).status, 401);
		assert.equal(
			(
				await call("list_doc_stores", {
					authorization: `Bearer ${"x".repeat(40)}`,
				})
			).status,
			403,
		);
		assert.equal(
			(
				await call("list_doc_stores", {
					...bearer,
					origin: "https://elsewhere.example",
				})
			).status,
			403,
			"never from a browser",
		);
		const made = await call("create_doc_store", bearer, {
			title: "From a runner",
		});
		assert.equal(made.status, 200);
		const listed = (await (await call("list_doc_stores", bearer)).json()) as {
			ok: boolean;
			text: string;
		};
		assert.equal(listed.ok, true);
		assert.match(listed.text, /From a runner/);
		const removed = await call("delete_doc_store", bearer, {
			store: "From a runner",
		});
		assert.equal(removed.status, 200);
	});

	it("registers a runner, places a session on it and lists it", async (t) => {
		const launches: RunnerLaunch[] = [];
		const placed: RunnerSession[] = [];
		const sessions: SessionManager = {
			launch: async (command) => {
				launches.push(command);
				placed.push({
					id: command.session.id,
					cwd: command.session.cwd,
					localCwd: "/home/me/dev/acme-api",
					name: command.session.name,
					state: "working",
					detail: "Reading the tests",
					startedAt: 1,
					updatedAt: 2,
					endedAt: null,
					claudeSessionId: null,
					cpuPercent: null,
					rss: null,
				});
				return { ok: true };
			},
			stop: async () => ({ ok: true }),
			list: () => placed,
			pids: () => new Map(),
			stopAll: async () => {},
		};
		const client = startRunnerClient({
			config: {
				hub: base,
				token: runnerSecret,
				name: "Test Runner",
				cap: 2,
				claudeBin: "claude",
				claudeArgs: [],
				paths: [],
				cswapBin: "off",
			},
			sessions,
			sample: async () => ({
				cpus: 4,
				cpuPercent: 10,
				load1: 0.5,
				memTotal: 8e9,
				memUsed: 2e9,
				diskTotal: 1e11,
				diskFree: 5e10,
			}),
			log: () => {},
		});
		t.after(() => client.stop());
		assert.equal(await client.registered, "test-runner");
		const result = await runnerHub.launch({
			cwd: "/Users/me/dev/acme-api",
			prompt: "fix the flaky test",
			runsOn: "runner_test-runner",
		});
		assert.equal(result.ok, true);
		assert.equal(launches[0]?.session.prompt, "fix the flaky test");
		assert.equal(launches[0]?.hubHome, "/Users/me");
		for (
			let i = 0;
			i < 200 && runnerHub.sessions()[0]?.doing !== "Reading the tests";
			i++
		) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const listed = await fetch(`${base}/api/runners`, { headers: authed });
		const { runners } = (await listed.json()) as { runners: RunnerView[] };
		assert.deepEqual(
			runners.map((runner) => [
				runner.id,
				runner.state,
				runner.sessions.length,
			]),
			[
				["local", "online", 0],
				["test-runner", "online", 1],
			],
		);
		assert.equal(runners[1]?.usage?.cpus, 4);
		assert.equal(runnerHub.sessions()[0]?.doing, "Reading the tests");
	});

	it("answers a browse command over the runner protocol without launching", async (t) => {
		const touched: string[] = [];
		const posted: string[] = [];
		const asked: [string | null, string | null][] = [];
		const client = startRunnerClient({
			config: {
				hub: base,
				token: runnerSecret,
				name: "Browse Runner",
				cap: 2,
				claudeBin: "claude",
				claudeArgs: [],
				paths: [],
				cswapBin: "off",
			},
			sessions: {
				launch: async () => {
					touched.push("launch");
					return { ok: true };
				},
				stop: async () => {
					touched.push("stop");
					return { ok: true };
				},
				list: () => [],
				pids: () => new Map(),
				stopAll: async () => {},
			},
			sample: async () => ({
				cpus: 4,
				cpuPercent: 10,
				load1: 0.5,
				memTotal: 8e9,
				memUsed: 2e9,
				diskTotal: 1e11,
				diskFree: 5e10,
			}),
			fetch: (input, init) => {
				if (init?.method === "POST") posted.push(String(input));
				return fetch(input, init);
			},
			browse: async (path, hubHome) => {
				asked.push([path, hubHome]);
				return {
					ok: true,
					listing: {
						machine: "Browse Runner",
						path: "/home/me/dev",
						home: "/home/me",
						parent: "/home/me",
						folders: ["acme-api"],
						truncated: false,
					},
				};
			},
			log: () => {},
		});
		t.after(() => client.stop());
		assert.equal(await client.registered, "browse-runner");
		const found = await runnerHub.browse(
			"runner_browse-runner",
			"/Users/me/dev",
		);
		assert.deepEqual(found, {
			ok: true,
			listing: {
				machine: "Browse Runner",
				path: "/home/me/dev",
				home: "/home/me",
				parent: "/home/me",
				folders: ["acme-api"],
				truncated: false,
			},
		});
		assert.deepEqual(asked, [["/Users/me/dev", "/Users/me"]]);
		assert.equal(
			posted.filter((url) =>
				/\/api\/runners\/browse-runner\/commands\/[^/]+$/.test(
					new URL(url).pathname,
				),
			).length,
			1,
		);
		assert.deepEqual(touched, []);
	});

	it("lists folders on the machine a session would run on", async () => {
		browsed.length = 0;
		const found = await fetch(
			`${base}/api/folders?runsOn=runner_jimbo&path=${encodeURIComponent("~/code")}`,
			{ headers: authed },
		);
		assert.equal(found.status, 200);
		assert.deepEqual(await found.json(), {
			ok: true,
			listing: {
				machine: "jimbo",
				path: "~/code",
				home: "/home/me",
				parent: "/home/me",
				folders: ["acme"],
				truncated: false,
			},
		});
		const missing = await fetch(
			`${base}/api/folders?runsOn=runner_jimbo&path=/nope`,
			{ headers: authed },
		);
		assert.equal(missing.status, 422);
		assert.deepEqual(await missing.json(), {
			ok: false,
			error: "/nope isn't a folder on jimbo",
		});
		const start = await fetch(`${base}/api/folders`, { headers: authed });
		assert.equal(start.status, 200);
		assert.deepEqual(browsed, [
			["runner_jimbo", "~/code"],
			["runner_jimbo", "/nope"],
			["local", null],
		]);
		assert.equal(
			(await fetch(`${base}/api/folders`, { method: "POST", headers: authed }))
				.status,
			405,
		);
		assert.equal((await fetch(`${base}/api/folders`)).status, 401);
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

	it("caches hashed assets for good and revalidates app.js", async () => {
		const asset = await fetch(`${base}/assets/app.js`, { headers: authed });
		assert.equal(
			asset.headers.get("cache-control"),
			"public, max-age=31536000, immutable",
		);
		const app = await fetch(`${base}/app.js`, { headers: authed });
		assert.equal(app.headers.get("cache-control"), "no-cache");
		assert.match(app.headers.get("etag") ?? "", /^"\d+-\d+"$/);
		const page = await fetch(`${base}/`, { headers: authed });
		assert.equal(page.headers.get("cache-control"), "no-cache");
	});

	it("refuses a missing chunk instead of serving the page", async () => {
		const missing = await fetch(`${base}/chunks/chunk-GONE.js`, {
			headers: authed,
		});
		assert.equal(missing.status, 404);
		assert.equal(
			(await fetch(`${base}/assets/gone.svg`, { headers: authed })).status,
			404,
		);
	});

	it("answers a matching If-None-Match with 304 and no body", async () => {
		const first = await fetch(`${base}/app.js`, { headers: authed });
		await first.text();
		const etag = first.headers.get("etag") ?? "";
		const again = await fetch(`${base}/app.js`, {
			headers: { ...authed, "if-none-match": etag },
		});
		assert.equal(again.status, 304);
		assert.equal(await again.text(), "");
		const stale = await fetch(`${base}/app.js`, {
			headers: { ...authed, "if-none-match": '"0-0"' },
		});
		assert.equal(stale.status, 200);
		assert.equal(await stale.text(), "export const app = 1");
	});

	const rootReadsEveryFile = process.getuid?.() === 0;
	it("survives a static file it cannot read", {
		skip: rootReadsEveryFile && "root can read a file with no permissions",
	}, async () => {
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

	it("says whether a folder can run in the cloud", async () => {
		const check = (cwd: string, headers: Record<string, string> = authed) =>
			fetch(`${base}/api/cloud-blocker?cwd=${encodeURIComponent(cwd)}`, {
				headers,
			});
		const blocked = await check("/Users/me/notes");
		assert.equal(blocked.status, 200);
		assert.deepEqual(await blocked.json(), {
			reason: "This folder isn't a git repository",
		});
		assert.deepEqual(await (await check("/Users/me/dev/acme-api")).json(), {
			reason: null,
		});
		assert.equal((await check("/Users/me/notes", {})).status, 401);
	});

	it("checks a remote-control host against the folder on the chosen account", async () => {
		const response = await fetch(
			`${base}/api/cloud-blocker?cwd=%2FUsers%2Fme&runsOn=env_01host&account=2`,
			{ headers: authed },
		);
		assert.deepEqual(await response.json(), {
			reason: "env_01host on account 2 serves /elsewhere, not this folder",
		});
	});

	it("lists the remote-control hosts an account can start sessions on", async () => {
		const hosts = (query: string, headers: Record<string, string> = authed) =>
			fetch(`${base}/api/remote-hosts${query}`, { headers });
		const listed = await hosts("?account=2");
		assert.equal(listed.status, 200);
		assert.deepEqual(await listed.json(), {
			hosts: [
				{
					id: "env_01host",
					name: "pilot:acme-api:6f62",
					machine: "pilot-2",
					directory: "/Users/me/dev/acme-api",
				},
			],
		});
		const unnumbered = (await (await hosts("?account=junk")).json()) as {
			hosts: { machine: string }[];
		};
		assert.equal(unnumbered.hosts[0]?.machine, "pilot-default");
		assert.deepEqual(await (await hosts("?account=9")).json(), {
			hosts: [],
			error: "Cloud API unreachable: offline",
		});
		assert.equal((await hosts("", {})).status, 401);
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
		const request = {
			cwd: tmpdir(),
			name: "acme-api",
			prompt: "say hi",
			runsOn: "local",
		};
		const created = await post(request);
		assert.equal(created.status, 201);
		assert.deepEqual(await created.json(), { ok: true, short: "feedbeef" });
		assert.deepEqual(launched, [request]);
		assert.equal(events.at(-1)?.action, "session-create");
		assert.deepEqual(lastRuns.current(), {
			[request.cwd]: { runsOn: "local" },
		});

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
		const cloud = await post({
			...request,
			runsOn: "cloud",
			at: { x: 120, y: 80 },
		});
		assert.equal(cloud.status, 201);
		assert.deepEqual(await cloud.json(), { ok: true, id: "session_01cloud" });
		assert.deepEqual(launched.at(-1), {
			...request,
			runsOn: "cloud",
			at: { x: 120, y: 80 },
		});
		assert.deepEqual(
			{ ...events.at(-1), identity: null },
			{
				action: "session-create",
				cwd: request.cwd,
				name: "acme-api",
				images: 0,
				account: null,
				runsOn: "cloud",
				identity: null,
				result: "session_01cloud",
			},
		);
		assert.deepEqual(expected.at(-1), ["session_01cloud", { x: 120, y: 80 }]);
		assert.deepEqual(lastRuns.current(), {
			[request.cwd]: { runsOn: "cloud" },
		});
	});

	const send = (method: string, path: string, body: unknown) =>
		fetch(`${base}${path}`, {
			method,
			headers: { ...authed, "content-type": "application/json", origin },
			body: JSON.stringify(body),
		});

	it("links two cards and unlinks them", async (t) => {
		const [api, web] = backgroundPair(t);
		const created = await send("POST", "/api/relations", {
			from: api,
			to: web,
		});
		assert.equal(created.status, 201);
		const relation = (await created.json()) as Relation;
		assert.deepEqual(
			{ from: relation.from, to: relation.to },
			{ from: api, to: web },
		);
		const again = await send("POST", "/api/relations", { from: web, to: api });
		assert.equal(again.status, 409);
		const docs = await send("POST", "/api/relations", {
			from: api,
			to: { kind: "docs", id: "d1" },
		});
		assert.equal(docs.status, 400);
		const missing = await send("POST", "/api/relations", {
			from: api,
			to: { kind: "session", id: "nowhere" },
		});
		assert.equal(missing.status, 422);
		assert.deepEqual(await missing.json(), {
			ok: false,
			error: "No session nowhere on the board",
		});
		const self = await send("POST", "/api/relations", { from: api, to: api });
		assert.equal(self.status, 400);
		const remove = (headers: Record<string, string> = {}) =>
			fetch(`${base}/api/relations/${relation.id}`, {
				method: "DELETE",
				headers: { ...authed, origin, ...headers },
			});
		assert.equal(
			(await remove({ origin: "https://evil.example" })).status,
			403,
		);
		assert.equal((await remove()).status, 204);
		assert.equal((await remove()).status, 404);
	});

	it("refuses to link a cloud session", async () => {
		const cloudy: Session = {
			...(board.sessions[0] as Session),
			id: "session_01cloudy",
			short: null,
			name: "acme-cloud",
			cloud: { url: "https://claude.ai/code/session_01cloudy" },
		};
		board.sessions.push(cloudy);
		try {
			const refused = await send("POST", "/api/relations", {
				from: { kind: "session", id: board.sessions[0]?.id },
				to: { kind: "session", id: cloudy.id },
			});
			assert.equal(refused.status, 422);
			assert.deepEqual(await refused.json(), {
				ok: false,
				error:
					"acme-cloud runs in the cloud, where the board can't brief it or give it doc tools",
			});
		} finally {
			board.sessions.pop();
		}
	});

	it("refuses to link a terminal session", async () => {
		const terminal: Session = {
			...(board.sessions[0] as Session),
			id: "terminal-session",
			name: "acme-terminal",
			kind: "interactive",
		};
		board.sessions.push(terminal);
		try {
			const refused = await send("POST", "/api/relations", {
				from: { kind: "session", id: board.sessions[0]?.id },
				to: { kind: "session", id: terminal.id },
			});
			assert.equal(refused.status, 422);
			assert.deepEqual(await refused.json(), {
				ok: false,
				error:
					"acme-terminal runs in a terminal, where the board can't brief it or give it doc tools",
			});
		} finally {
			board.sessions.pop();
		}
	});

	it("broadcasts and saves links as they are made and removed", async (t) => {
		const [api, web] = backgroundPair(t);
		const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
			headers: { ...authed, origin },
		});
		const frames: Relation[][] = [];
		let notify = () => {};
		socket.on("message", (data) => {
			const frame = JSON.parse(String(data)) as BoardFeed;
			if (frame.type !== "relations") return;
			frames.push(frame.relations);
			notify();
		});
		const relationFrame = (index: number) =>
			new Promise<Relation[]>((resolve) => {
				const check = () => {
					const frame = frames[index];
					if (frame) resolve(frame);
					else notify = check;
				};
				check();
			});
		assert.deepEqual(await relationFrame(0), []);
		const response = await send("POST", "/api/relations", {
			from: api,
			to: web,
		});
		const relation = (await response.json()) as Relation;
		assert.deepEqual(await relationFrame(1), [relation]);
		await relationsSaved();
		assert.deepEqual(JSON.parse(await readFile(relationsFile, "utf8")), [
			relation,
		]);
		const deleted = await fetch(`${base}/api/relations/${relation.id}`, {
			method: "DELETE",
			headers: { ...authed, origin },
		});
		assert.equal(deleted.status, 204);
		assert.deepEqual(await relationFrame(2), []);
		await relationsSaved();
		assert.deepEqual(JSON.parse(await readFile(relationsFile, "utf8")), []);
		socket.close();
	});

	it("lets the user create, rename and delete doc stores and pages", async () => {
		const created = await send("POST", "/api/docs", { title: " Runbook " });
		assert.equal(created.status, 201);
		const store = (await created.json()) as DocStore;
		assert.equal(store.title, "Runbook");
		assert.equal(
			(await send("POST", "/api/docs", { title: "a\nb" })).status,
			400,
		);
		const renamed = await send("PATCH", `/api/docs/${store.id}`, {
			title: "On call",
		});
		assert.equal(renamed.status, 200);
		assert.equal(((await renamed.json()) as DocStore).title, "On call");
		assert.equal(
			(await send("PATCH", "/api/docs/nope", { title: "X" })).status,
			404,
		);

		const page = `/api/docs/${store.id}/files/guides%2Fstart.md`;
		const put = await send("PUT", page, { content: "# Start" });
		assert.equal(put.status, 200);
		assert.equal(((await put.json()) as DocFile).path, "guides/start.md");
		const served = await fetch(`${base}${page}`, { headers: authed });
		assert.equal(await served.text(), "# Start");
		assert.equal(
			(await send("PUT", `/api/docs/${store.id}/files/a.png`, { content: "" }))
				.status,
			400,
		);
		const long = await send("PUT", page, {
			content: "\u0001".repeat(200_000),
		});
		assert.equal(long.status, 200, "a big escaped body still fits");

		const evil = { ...authed, origin: "https://evil.example" };
		for (const [method, path] of [
			["DELETE", page],
			["DELETE", `/api/docs/${store.id}`],
		] as const) {
			assert.equal(
				(await fetch(`${base}${path}`, { method, headers: evil })).status,
				403,
			);
		}
		assert.equal(
			(
				await fetch(`${base}/api/docs`, {
					method: "POST",
					headers: { ...evil, "content-type": "application/json" },
					body: JSON.stringify({ title: "X" }),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/docs`, {
					method: "POST",
					headers: { "content-type": "application/json", origin },
					body: JSON.stringify({ title: "X" }),
				})
			).status,
			401,
		);

		const remove = (path: string) =>
			fetch(`${base}${path}`, {
				method: "DELETE",
				headers: { ...authed, origin },
			});
		assert.equal((await remove(page)).status, 204);
		assert.equal((await remove(page)).status, 404);
		assert.equal((await remove(`/api/docs/${store.id}`)).status, 204);
		assert.equal((await remove(`/api/docs/${store.id}`)).status, 404);
		assert.deepEqual(docStores.current(), []);
	});

	it("makes another account the default and audits it", async () => {
		const made = await send("POST", "/api/accounts/default", { account: 2 });
		assert.equal(made.status, 200);
		assert.deepEqual(await made.json(), { ok: true });
		assert.deepEqual(events.at(-1), {
			action: "account-default",
			account: 2,
			identity: "me@example.com",
			result: "ok",
		});

		const refused = await send("POST", "/api/accounts/default", {
			account: 9,
		});
		assert.equal(refused.status, 422);
		assert.deepEqual(await refused.json(), {
			ok: false,
			error: "no account 9",
		});

		const invalid = await send("POST", "/api/accounts/default", {
			account: "2",
		});
		assert.equal(invalid.status, 400);
		assert.deepEqual(madeDefault, [2, 9]);
		assert.equal(
			(await fetch(`${base}/api/accounts/default`, { headers: authed })).status,
			405,
		);
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

	it("surveys and grants permissions, auditing each grant", async () => {
		const surveyed = await send("POST", "/api/permissions/survey", {});
		assert.equal(surveyed.status, 200);
		assert.deepEqual(await surveyed.json(), { entries: [] });
		const grants = [{ sessionId: "s1", rules: ["Bash(npm run test:*)"] }];
		const response = await send("POST", "/api/permissions/grant", grants);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), [
			{
				sessionId: "s1",
				settingsPath: "/settings/s1",
				ok: true,
				added: ["Bash(npm run test:*)"],
			},
		]);
		assert.deepEqual(granted, grants);
		assert.deepEqual(events.at(-1), {
			action: "permissions-grant",
			sessionId: "s1",
			rules: ["Bash(npm run test:*)"],
			identity: "me@example.com",
			result: "added 1",
		});
		assert.equal(
			(
				await send("POST", "/api/permissions/grant", [
					{ sessionId: "s1", rules: ["rm -rf /"] },
				])
			).status,
			400,
		);
		assert.equal(granted.length, 1);
	});

	it("announces to every session for the signed-in user", async () => {
		const response = await send("POST", "/api/announce", { text: "Pull main" });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			ok: true,
			deliveries: [{ id: "s1", name: "one", ok: true, error: null }],
		});
		assert.deepEqual(announced, [["Pull main", "me@example.com"]]);
		assert.equal(
			(await send("POST", "/api/announce", { text: "!rm" })).status,
			400,
		);
		assert.equal(
			(await send("POST", "/api/announce", { text: 3 })).status,
			400,
		);
		assert.equal(announced.length, 2);
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
			/^\*\*Status · 14:05\*\*\n\n- Tests pass\n\n\*\*Stats\*\*/,
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
		const hello = new Promise<BoardFeed>((resolve) =>
			socket.once("message", (data) => resolve(JSON.parse(String(data)))),
		);
		await new Promise((resolve) => socket.on("open", resolve));
		assert.deepEqual(
			await hello,
			{ type: "hello", build: "build-1" },
			"the feed names the page build first, so a stale page reloads",
		);
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

	it("undoes and redoes your moves, but not the page's own first placement", async () => {
		const key = `session:${board.sessions[1]?.id}`;
		const first = { x: 7000, y: 7000 };
		const moved = { x: 7200, y: 7000, pinned: true };
		const saved = async () => {
			await layoutSaved();
			return JSON.parse(await readFile(layoutFile, "utf8"))[key];
		};
		assert.equal(
			(await send("PUT", "/api/layout", { key, placement: first })).status,
			204,
		);
		assert.equal(
			(await send("PUT", "/api/layout", { key, placement: moved })).status,
			204,
		);
		const undone = await send("POST", "/api/undo", undefined);
		assert.equal(undone.status, 200);
		const reply = (await undone.json()) as Record<string, unknown>;
		assert.equal(reply.ok, true);
		assert.equal(reply.label, "Move a card");
		assert.equal(reply.redo, "Move a card");
		// The first, unpinned placement was the page's, so no move is left to undo.
		assert.notEqual(reply.undo, "Move a card");
		assert.deepEqual(await saved(), first);
		const redone = await send("POST", "/api/redo", undefined);
		assert.equal(((await redone.json()) as { ok: boolean }).ok, true);
		assert.deepEqual(await saved(), moved);
		assert.equal((await send("GET", "/api/undo", undefined)).status, 405);
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

	it("ignores projects by cwd until a time and broadcasts them", async () => {
		const cwd = "/Users/me/dev/acme-api";
		const until = Date.now() + 60 * 60 * 1000;
		const socket = new WebSocket(`${base.replace("http", "ws")}/api/feed`, {
			headers: { ...authed, origin },
		});
		const broadcast = new Promise<BoardFeed>((resolve) => {
			let frames = 0;
			socket.on("message", (data) => {
				const frame = JSON.parse(String(data)) as BoardFeed;
				if (frame.type === "ignores" && ++frames === 2) resolve(frame);
			});
		});
		await new Promise((resolve) => socket.on("open", resolve));
		assert.equal(
			(await send("PUT", "/api/ignores", { cwd, until })).status,
			204,
		);
		assert.deepEqual(await broadcast, {
			type: "ignores",
			ignores: { [cwd]: until },
		});
		socket.close();
		assert.equal(
			(await send("PUT", "/api/ignores", { cwd, until: "later" })).status,
			400,
		);
		await ignoresSaved();
		assert.deepEqual(JSON.parse(await readFile(ignoresFile, "utf8")), {
			[cwd]: until,
		});
		assert.equal(
			(await send("PUT", "/api/ignores", { cwd, until: null })).status,
			204,
		);
		await ignoresSaved();
		assert.deepEqual(JSON.parse(await readFile(ignoresFile, "utf8")), {});
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
		assert.ok(
			(note?.kind === "note" ? note.text : "").startsWith(
				[
					"**Status · 14:05**",
					...names.map((name) => `**${name}**\n\n- Tests pass`),
					"**Stats**",
				].join("\n\n"),
			),
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
				if (received.length === 12) {
					socket.close();
					resolve(received);
				}
			});
		});
		assert.deepEqual(
			frames.map((frame) => frame.type),
			[
				"hello",
				"layout",
				"annotations",
				"colours",
				"ignores",
				"regions",
				"comments",
				"usage",
				"digests",
				"relations",
				"docs",
				"board",
			],
		);
		assert.deepEqual(
			frames.find((frame) => frame.type === "docs"),
			{ type: "docs", docs: {}, stores: [] },
		);
	});

	it("queues messages to Butler only from the board's own page, for spike to collect", async () => {
		const butlerSend = (path: string, body: unknown, extra = {}) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: {
					...authed,
					"content-type": "application/json",
					origin,
					...extra,
				},
				body: JSON.stringify(body),
			});
		const tool = async (name: string, body: unknown, headers = {}) =>
			fetch(`${base}/api/butler/tools/${name}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
			});
		const draft = { x: 10, y: 10, text: "tidy the board", to: "butler" };
		// No token, a wrong token, another origin and a runner's bearer are all refused.
		assert.equal((await butlerSend("/api/comments", draft)).status, 403);
		assert.equal(
			(
				await butlerSend("/api/comments", draft, {
					"x-kanban-csrf": "wrong",
				})
			).status,
			403,
		);
		assert.equal(
			(
				await butlerSend("/api/comments", draft, {
					"x-kanban-csrf": "test-csrf",
					origin: "https://evil.example",
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/comments`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${runnerSecret}`,
						"content-type": "application/json",
						"x-kanban-csrf": "test-csrf",
					},
					body: JSON.stringify(draft),
				})
			).status,
			403,
		);
		const csrf = await fetch(`${base}/api/csrf`, { headers: authed });
		assert.deepEqual(await csrf.json(), { token: "test-csrf" });
		assert.equal(
			(await fetch(`${base}/api/csrf`)).status,
			401,
			"the token needs the board's sign-in",
		);
		const created = await butlerSend(
			"/api/comments",
			{ ...draft, viewport: { x: 0, y: 0, w: 800, h: 600 } },
			{ "x-kanban-csrf": "test-csrf" },
		);
		assert.equal(created.status, 201);
		const thread = await created.json();
		assert.equal(thread.to, "butler");
		assert.equal(thread.queued.length, 1);

		// A page can't read the queue: Butler's endpoint refuses any Origin.
		assert.equal((await tool("board_inbox", {}, { origin })).status, 403);
		const inbox = await tool("board_inbox", {});
		assert.equal(inbox.status, 200);
		const { messages } = JSON.parse((await inbox.json()).text);
		assert.equal(messages.length, 1);
		assert.equal(messages[0].text, "tidy the board");
		assert.deepEqual(messages[0].context.viewport, {
			x: 0,
			y: 0,
			w: 800,
			h: 600,
		});
		const acked = await tool("board_ack", { ids: [messages[0].id] });
		assert.equal((await acked.json()).text, "Took 1");
		assert.equal(comments.get(thread.id)?.running, true);
		assert.equal(comments.get(thread.id)?.queued?.length, 0);
		const answered = await tool("board_reply", {
			thread: thread.id,
			message: messages[0].id,
			text: "Tidied into three regions.",
		});
		assert.equal(answered.status, 200);
		const after = comments.get(thread.id);
		assert.equal(after?.running, false);
		assert.equal(after?.events.at(-1)?.text, "Tidied into three regions.");
		assert.equal(
			(
				await butlerSend(
					`/api/comments/${thread.id}/messages`,
					{ text: "thanks" },
					{ "x-kanban-csrf": "test-csrf" },
				)
			).status,
			202,
		);
		assert.equal(comments.get(thread.id)?.queued?.length, 1);
		assert.equal(
			(
				await butlerSend(`/api/comments/${thread.id}/messages`, {
					text: "no token",
				})
			).status,
			403,
		);
		comments.remove(thread.id);
	});

	it("shows a Butler thread card's log to the page and queues Aaron's replies and jobs", async () => {
		const page = (path: string, body: unknown, extra = {}) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: {
					...authed,
					"content-type": "application/json",
					origin,
					...extra,
				},
				body: JSON.stringify(body),
			});
		const tool = async (name: string, body: unknown) => {
			const response = await fetch(`${base}/api/butler/tools/${name}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return (await response.json()) as {
				ok: boolean;
				text: string;
				error?: string;
			};
		};
		const entry = (id: string, kind: string) => ({
			id,
			title: `Thread ${id}`,
			kind,
			state: "working",
			status: "Reading mail",
			link: `https://discord.com/channels/1/${id}`,
			createdAt: 1,
			lastActiveAt: 2,
			private: false,
			events: [{ at: 1, kind: "user", text: "find the invoice" }],
			approvals: [{ at: 2, headline: "Send the reply?", code: "ab12" }],
		});
		const synced = await tool("butler_threads", {
			threads: [entry("11111111", "conversation"), entry("22222222", "dm")],
		});
		assert.equal(synced.ok, true);
		assert.match(synced.text, /^2 thread cards: 1 updated, 0 removed\n/);
		// A full day of threads, with every event and request card, is far past an ordinary body.
		const long = "x".repeat(1100);
		const busy = await tool("butler_threads", {
			threads: [
				{
					...entry("11111111", "conversation"),
					events: Array.from({ length: 30 }, (_, i) => ({
						at: i,
						kind: "reply",
						text: long,
					})),
				},
				entry("22222222", "dm"),
			],
			padding: "y".repeat(300 * 1024),
		});
		assert.notEqual(
			busy.error,
			"Invalid JSON body",
			"a large sync is read whole",
		);

		assert.equal(
			(await fetch(`${base}/api/butler/threads/11111111`)).status,
			401,
			"the view needs the board's sign-in",
		);
		const viewed = await fetch(`${base}/api/butler/threads/11111111`, {
			headers: authed,
		});
		assert.equal(viewed.status, 200);
		const view = await viewed.json();
		assert.equal(view.card.id, "thread-11111111");
		assert.equal(view.card.thread.kind, "conversation");
		assert.deepEqual(
			view.events.map((e: { text: string }) => e.text),
			["find the invoice"],
		);
		assert.equal(view.approvals[0].headline, "Send the reply?");
		assert.equal(
			(await fetch(`${base}/api/butler/threads/99999999`, { headers: authed }))
				.status,
			404,
		);
		assert.equal(
			(
				await fetch(`${base}/api/butler/threads/11111111`, {
					headers: { authorization: `Bearer ${runnerSecret}` },
				})
			).status,
			403,
			"a machine with the runner token never reads a thread's words",
		);

		const reply = "/api/butler/threads/11111111/messages";
		assert.equal((await page(reply, { text: "and pay it" })).status, 403);
		assert.equal(
			(
				await page(
					"/api/butler/threads/22222222/messages",
					{ text: "hi" },
					{ "x-kanban-csrf": "test-csrf" },
				)
			).status,
			202,
			"a reply to the DM queues for the Discord DM",
		);
		const dmView = await (
			await fetch(`${base}/api/butler/threads/22222222`, { headers: authed })
		).json();
		assert.equal(dmView.card.thread.kind, "dm");
		assert.equal(dmView.events.at(-1).text, "hi");
		assert.equal(
			(
				await page(
					reply,
					{ text: "and pay it" },
					{ "x-kanban-csrf": "test-csrf" },
				)
			).status,
			202,
		);
		const job = await page(
			"/api/butler/jobs",
			{ text: "book the dentist", viewport: { x: 0, y: 0, w: 800, h: 600 } },
			{ "x-kanban-csrf": "test-csrf" },
		);
		assert.equal(job.status, 201);
		const { thread } = await job.json();
		assert.equal(thread.job, true);
		assert.equal(thread.x, 400);
		assert.equal((await page("/api/butler/jobs", { text: "x" })).status, 403);

		const { messages } = JSON.parse((await tool("board_inbox", {})).text);
		const toCard = messages.find(
			(m: { thread: string }) => m.thread === "card-11111111",
		);
		assert.equal(toCard.target, "11111111");
		assert.equal(toCard.text, "and pay it");
		const toJob = messages.find(
			(m: { thread: string }) => m.thread === thread.id,
		);
		assert.equal(toJob.job, true);
		assert.equal(
			(await tool("board_ack", { ids: [toCard.id, toJob.id] })).text,
			"Took 2",
		);
		assert.equal(
			(
				await tool("board_reply", {
					thread: "card-11111111",
					message: toCard.id,
					text: "Paid.",
				})
			).ok,
			true,
		);
		const after = await (
			await fetch(`${base}/api/butler/threads/11111111`, { headers: authed })
		).json();
		assert.deepEqual(
			after.events.map(
				(e: { kind: string; text: string }) => `${e.kind} ${e.text}`,
			),
			["user find the invoice", "user and pay it", "reply Paid."],
		);
		comments.remove(thread.id);

		await tool("butler_threads", {
			threads: [entry("11111111", "conversation"), entry("22222222", "dm")],
			edges: [
				{
					from: "11111111",
					to: "22222222",
					via: "desk say",
					count: 1,
					lastAt: Date.now(),
					messages: [{ at: Date.now(), kind: "user", text: "the words" }],
				},
			],
		});
		const edgeUrl = `${base}/api/butler/edges?from=thread:11111111&to=thread:22222222`;
		assert.equal((await fetch(edgeUrl)).status, 401);
		assert.equal(
			(
				await fetch(edgeUrl, {
					headers: { authorization: `Bearer ${runnerSecret}` },
				})
			).status,
			403,
			"a machine with the runner token never reads an edge's words",
		);
		assert.equal(
			(
				await fetch(`${base}/api/butler/edges?from=note:1&to=x`, {
					headers: authed,
				})
			).status,
			400,
		);
		const edgeView = await (await fetch(edgeUrl, { headers: authed })).json();
		assert.deepEqual(
			edgeView.messages.map(
				(m: { via: string; text: string }) => `${m.via} ${m.text}`,
			),
			["desk say the words"],
		);
		await tool("butler_threads", { threads: [], edges: [] });
	});

	it("takes a Butler card's Approve only from the page signed in through the device gate", async () => {
		const tool = async (name: string, body: unknown) =>
			(await (
				await fetch(`${base}/api/butler/tools/${name}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				})
			).json()) as { ok: boolean; text: string };
		const nonce = "0123456789abcdef0123456789abcdef";
		await tool("butler_threads", {
			threads: [
				{
					id: "33333333",
					title: "Desk session: tidy",
					kind: "desk",
					state: "needs-you",
					status: "Waiting on Aaron: Mission request: tidy",
					link: "https://discord.com/channels/1/33333333",
					createdAt: 1,
					lastActiveAt: 2,
					private: false,
					events: [],
					approvals: [
						{
							at: 2,
							headline: "Mission request: tidy",
							code: "qwert",
							kind: "desk",
							nonce,
							safe: true,
						},
					],
				},
			],
		});
		const press = (extra: Record<string, string>) =>
			fetch(`${base}/api/butler/threads/33333333/approvals`, {
				method: "POST",
				headers: {
					...authed,
					"content-type": "application/json",
					origin,
					...extra,
				},
				body: JSON.stringify({ code: "qwert", decision: "approve" }),
			});
		const listed = await (
			await fetch(`${base}/api/butler/approvals`, { headers: authed })
		).json();
		assert.equal(listed.approvals[0].approval.answerable, true);
		assert.equal(
			JSON.stringify(listed).includes(nonce),
			false,
			"the page never sees a nonce",
		);
		const stale = await press({
			"x-device-gate-device": "ipad",
			"cf-connecting-ip": "10.100.0.13",
		});
		assert.equal(stale.status, 403, "no CSRF token");
		assert.equal(
			(await stale.json()).code,
			"stale-page",
			"the page can tell a stale token, refresh it and press again",
		);
		assert.equal(stale.headers.get("x-kanban-build"), "build-1");
		assert.equal(
			(await press({ "x-kanban-csrf": "test-csrf" })).status,
			403,
			"no device the gate signed in",
		);
		const ok = await press({
			"x-kanban-csrf": "test-csrf",
			"x-device-gate-device": "ipad",
			"cf-connecting-ip": "10.100.0.13",
		});
		assert.equal(ok.status, 202);
		const again = await press({
			"x-kanban-csrf": "test-csrf",
			"x-device-gate-device": "ipad",
			"cf-connecting-ip": "10.100.0.13",
		});
		assert.equal(again.status, 409);
		assert.match(
			(await again.json()).error,
			/Already approved from the board on ipad/,
		);
		const { messages } = JSON.parse((await tool("board_inbox", {})).text);
		const pressed = messages.find((m: { approval?: unknown }) => m.approval);
		assert.deepEqual(pressed.approval, {
			code: "qwert",
			nonce,
			decision: "approve",
			device: "ipad",
		});
		await tool("board_ack", { ids: [pressed.id] });
		await tool("butler_threads", { threads: [] });
	});

	it("takes what Aaron is working on only from the board's own page, for Butler to read", async () => {
		const report = (body: unknown, extra = {}) =>
			fetch(`${base}/api/butler/focus`, {
				method: "POST",
				headers: {
					...authed,
					"content-type": "application/json",
					origin,
					...extra,
				},
				body: JSON.stringify(body),
			});
		const focus = {
			client: "page-1",
			viewport: { x: 0, y: 0, w: 800, h: 600 },
		};
		assert.equal((await report(focus)).status, 403);
		assert.equal(
			(await report({ viewport: 1 }, { "x-kanban-csrf": "test-csrf" })).status,
			400,
		);
		assert.equal(
			(await report(focus, { "x-kanban-csrf": "test-csrf" })).status,
			204,
		);
		const read = await fetch(`${base}/api/butler/tools/board_focus`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		const { text } = (await read.json()) as { text: string };
		assert.deepEqual(JSON.parse(text).aaron.viewport, focus.viewport);
		assert.equal(
			(
				await report(
					{ client: "page-1", away: true },
					{ "x-kanban-csrf": "test-csrf" },
				)
			).status,
			204,
		);
	});

	it("answers peer hooks from loopback without browser headers", async () => {
		const call = (body: unknown, headers: Record<string, string> = {}) =>
			fetch(`${base}/api/hooks/peers`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
			});
		const hook = (sessionId: string) => ({
			hook_event_name: "UserPromptSubmit",
			session_id: sessionId,
			prompt: "hi",
		});
		const told = await call(hook("with-peers"));
		assert.equal(told.status, 200);
		assert.deepEqual(await told.json(), {
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: "peers here",
			},
		});
		assert.equal((await call(hook("alone"))).status, 204);
		assert.equal(
			(await call({ hook_event_name: "Stop", session_id: "with-peers" }))
				.status,
			204,
		);
		assert.equal(
			(await call({ ...hook("with-peers"), prompt: "x".repeat(200_000) }))
				.status,
			200,
			"a large prompt or tool batch still gets an answer",
		);
		assert.equal((await call(hook("with-peers"), { origin })).status, 403);
		assert.equal(
			(await call(hook("with-peers"), { "cf-ray": "abc" })).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/hooks/peers`, {
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: JSON.stringify(hook("with-peers")),
				})
			).status,
			415,
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
