import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Board } from "../shared/types.ts";
import { createAgentTokens } from "./agentAuth.ts";
import { createAnnotationStore, loadAnnotations } from "./annotations.ts";
import { claudeAttachPty, createAttachHub } from "./attach.ts";
import { fileAudit } from "./audit.ts";
import { authenticatorFor } from "./auth.ts";
import {
	agentMarker,
	claudeAgentSpawner,
	createBoardAgent,
	isAgentDir,
} from "./boardAgent.ts";
import { createBoardTools, projectsOf } from "./boardTools.ts";
import { cmuxCli, createCmuxTargets } from "./cmux.ts";
import { createColourStore, loadColours } from "./colours.ts";
import { listCommands } from "./commands.ts";
import { createCommentStore, loadComments } from "./comments.ts";
import { type Config, isLoopback, loadConfig } from "./config.ts";
import { createConversationHub } from "./conversationHub.ts";
import {
	claudeAsker,
	claudeExitDeps,
	createExitRunner,
	exitSession,
	liveInteractiveEntry,
} from "./exit.ts";
import { createFeed, type Feed } from "./feed.ts";
import { listFiles } from "./files.ts";
import { createKanbanServer } from "./http.ts";
import { startBoard } from "./ingest/index.ts";
import { createLayoutStore, loadLayout } from "./layout.ts";
import { createMirrorHub } from "./mirror.ts";
import { createPromptSender } from "./prompts.ts";
import { createRegionStore, loadRegions } from "./regions.ts";
import {
	cardsOf,
	createRegionReportRunner,
	createReportRunner,
	regionMembersOf,
} from "./reports.ts";
import { claudeLauncher } from "./sessions.ts";
import { attachTty, cmuxTty, sharedAttachTty } from "./terminals.ts";
import {
	claudeCodeToken,
	createUsageMonitor,
	loadUsageSamples,
	usageIntervalMs,
} from "./usage.ts";

const configOrExit = (): Config => {
	try {
		return loadConfig();
	} catch (error) {
		console.error(`kanban: ${(error as Error).message}`);
		process.exit(1);
	}
};

const config = configOrExit();
const cmuxSyncMs = 5000;
const agentTimeoutMs = 15 * 60_000;
const audit = fileAudit(config.auditLog);

let feed: Feed | null = null;
const layoutFile = join(config.stateDir, "layout.json");
const layout = createLayoutStore({
	file: layoutFile,
	initial: await loadLayout(layoutFile),
	onChange: (next) => feed?.layout(next),
});
const annotationsFile = join(config.stateDir, "annotations.json");
const annotations = createAnnotationStore({
	file: annotationsFile,
	initial: await loadAnnotations(annotationsFile),
	onChange: (next) => feed?.annotations(next),
});
const coloursFile = join(config.stateDir, "colours.json");
const colours = createColourStore({
	file: coloursFile,
	initial: await loadColours(coloursFile),
	onChange: (next) => feed?.colours(next),
});
const regionsFile = join(config.stateDir, "regions.json");
const regions = createRegionStore({
	file: regionsFile,
	initial: await loadRegions(regionsFile),
	onChange: (next) => feed?.regions(next),
});
const commentsFile = join(config.stateDir, "comments.json");
const comments = createCommentStore({
	file: commentsFile,
	initial: await loadComments(commentsFile),
	onChange: (thread) => feed?.comment(thread),
	onRemove: (threads) => feed?.comments(threads),
});
const usageFile = join(config.stateDir, "usage.json");
const usage = createUsageMonitor({
	file: usageFile,
	initial: await loadUsageSamples(usageFile),
	token: claudeCodeToken(config.claudeHome),
	fetch,
	now: Date.now,
	onChange: (next) => feed?.usage(next),
});
void usage.check();
const usagePoll = setInterval(usage.check, usageIntervalMs);
const probes = new Set<string>();
const cmux = cmuxCli(config.cmuxBin);
const cmuxTargets = createCmuxTargets({
	cmux,
	live: async (session) =>
		(await liveInteractiveEntry(config.claudeHome, session)) !== null,
	onError: (error) => console.error(`kanban: ${error}`),
});
const syncCmux = async () => {
	if (await cmuxTargets.refresh()) source.refresh();
};
let interactivePids = "";
const syncCmuxOnNewPids = (board: Board) => {
	const pids = board.sessions
		.filter((s) => s.kind === "interactive" && s.pid !== null)
		.map((s) => s.pid)
		.sort()
		.join(",");
	if (pids === interactivePids) return;
	interactivePids = pids;
	void syncCmux();
};
const source = startBoard({
	claudeHome: config.claudeHome,
	ignore: (sessionId, cwd) =>
		probes.has(sessionId) || comments.owns(sessionId) || isAgentDir(cwd),
	inCmux: cmuxTargets.has,
	onChange: (board) => {
		feed?.board(board);
		layout.observe(board);
		syncCmuxOnNewPids(board);
	},
});
void syncCmux();
const cmuxPoll = setInterval(syncCmux, cmuxSyncMs);
layout.observe(source.board());
feed = createFeed({
	board: source.board,
	layout: layout.current,
	annotations: annotations.current,
	colours: colours.current,
	regions: regions.current,
	comments: comments.current,
	usage: usage.current,
});

const exitDeps = claudeExitDeps({
	claudeBin: config.claudeBin,
	claudeHome: config.claudeHome,
	probes,
});
const runExit = createExitRunner({
	exit: (session, force) => exitSession(exitDeps, session, force),
	audit,
	announce: (sessionId, result) => feed?.exit(sessionId, result),
});
const ask = claudeAsker({ claudeBin: config.claudeBin, probes });
const runReport = createReportRunner({
	ask,
	annotations,
	cards: () => cardsOf(source.board(), layout.current()),
	audit,
	announce: (sessionId, result) => feed?.report(sessionId, result),
});
const runRegionReport = createRegionReportRunner({
	ask,
	annotations,
	members: (regionId) =>
		regionMembersOf(
			source.board(),
			projectsOf(source.board(), { layout, annotations, regions }),
			regionId,
		),
	cards: () => cardsOf(source.board(), layout.current()),
	audit,
	announce: (regionId, result) => feed?.regionReport(regionId, result),
});
const launch = claudeLauncher(
	config.claudeBin,
	join(config.stateDir, "images"),
);
const attachPty = claudeAttachPty(config.claudeBin);
const attach = createAttachHub(attachPty, audit, (short) =>
	conversation.release(short),
);
const conversation = createConversationHub({
	session: (id) =>
		source.board().sessions.find((session) => session.id === id) ?? null,
	transcriptPath: source.transcriptPath,
	tty: (session) => {
		const short = session.short;
		if (session.kind === "background" && session.attachable && short) {
			return attach.screen(short)
				? sharedAttachTty({ live: () => attach.screen(short) })
				: attachTty({ spawnPty: attachPty, short, cwd: session.cwd });
		}
		return session.cmux
			? cmuxTty({ cmux, resolve: cmuxTargets.resolve, session })
			: null;
	},
	audit,
});
const attachedAnywhere = () => [
	...attach.attached(),
	...conversation.attached(),
];
const agentTokens = createAgentTokens(agentTimeoutMs);
const agentDir = join(config.stateDir, "agent");
await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, agentMarker), "");
const agentHost = isLoopback(config.host) ? config.host : "127.0.0.1";
const agent = createBoardAgent({
	store: comments,
	tokens: agentTokens,
	spawn: claudeAgentSpawner(config.claudeBin, agentDir),
	boardUrl: `http://${agentHost.includes(":") ? `[${agentHost}]` : agentHost}:${config.port}`,
	mcpScript: resolve(import.meta.dirname, "../agent/mcp.ts"),
	node: process.execPath,
	timeoutMs: agentTimeoutMs,
});
const tools = createBoardTools({
	source,
	layout,
	annotations,
	colours,
	regions,
	comments,
	launch,
	exit: runExit,
	ask,
	prompt: createPromptSender({
		spawnPty: attachPty,
		attached: attachedAnywhere,
		cmux,
		resolve: cmuxTargets.resolve,
	}),
	audit,
});

const server = createKanbanServer({
	origins: config.origins,
	dist: config.dist,
	authenticate: authenticatorFor(config.auth),
	source,
	launch,
	exit: runExit,
	report: runReport,
	regionReport: runRegionReport,
	layout,
	annotations,
	colours,
	regions,
	comments,
	agent,
	agentTokens,
	tools,
	attach,
	mirror: createMirrorHub({ cmux, resolve: cmuxTargets.resolve, audit }),
	conversation,
	files: (cwd, query) =>
		listFiles({ cwd, query, claudeHome: config.claudeHome }),
	commands: (cwd) => listCommands({ claudeHome: config.claudeHome, cwd }),
	feed,
	audit,
});

server.listen(config.port, config.host, () => {
	console.log(
		`kanban listening on http://${config.host}:${config.port} (auth ${config.auth.mode})`,
	);
});

const shutdown = () => {
	agent.stopAll();
	source.stop();
	clearInterval(cmuxPoll);
	clearInterval(usagePoll);
	server.close();
	server.closeAllConnections();
	setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
