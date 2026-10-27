import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Board } from "../shared/types.ts";
import { createAgentTokens } from "./agentAuth.ts";
import { createAnnotationStore, loadAnnotations } from "./annotations.ts";
import { claudeAttachPty, createAttachHub } from "./attach.ts";
import { fileAudit } from "./audit.ts";
import { authenticatorFor } from "./auth.ts";
import { claudeAgentSpawner, createBoardAgent } from "./boardAgent.ts";
import { createBoardTools } from "./boardTools.ts";
import { cmuxCli, createCmuxTargets } from "./cmux.ts";
import { createColourStore, loadColours } from "./colours.ts";
import { createCommentStore, loadComments } from "./comments.ts";
import { type Config, isLoopback, loadConfig } from "./config.ts";
import {
	claudeAsker,
	claudeExitDeps,
	createExitRunner,
	exitSession,
	liveInteractiveEntry,
} from "./exit.ts";
import { createFeed, type Feed } from "./feed.ts";
import { createKanbanServer } from "./http.ts";
import { startBoard } from "./ingest/index.ts";
import { createLayoutStore, loadLayout } from "./layout.ts";
import { createMirrorHub } from "./mirror.ts";
import { createPreviewer } from "./preview.ts";
import { createPromptSender } from "./prompts.ts";
import { createRegionStore, loadRegions } from "./regions.ts";
import { claudeLauncher } from "./sessions.ts";

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
const previewer = createPreviewer({
	transcript: (sessionId, limit) => source.transcript(sessionId, limit),
	emit: (preview) => feed?.preview(preview),
});
const source = startBoard({
	claudeHome: config.claudeHome,
	ignore: (sessionId) => probes.has(sessionId) || comments.owns(sessionId),
	inCmux: cmuxTargets.has,
	onChange: (board) => {
		feed?.board(board);
		layout.observe(board);
		void previewer.update(board);
		syncCmuxOnNewPids(board);
	},
});
void syncCmux();
const cmuxPoll = setInterval(syncCmux, cmuxSyncMs);
void previewer.update(source.board());
layout.observe(source.board());
feed = createFeed({
	board: source.board,
	previews: previewer.latest,
	layout: layout.current,
	annotations: annotations.current,
	colours: colours.current,
	regions: regions.current,
	comments: comments.current,
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
const launch = claudeLauncher(config.claudeBin);
const attachPty = claudeAttachPty(config.claudeBin);
const attach = createAttachHub(attachPty, audit);
const agentTokens = createAgentTokens(agentTimeoutMs);
const agentDir = join(config.stateDir, "agent");
await mkdir(agentDir, { recursive: true });
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
	ask: claudeAsker({ claudeBin: config.claudeBin, probes }),
	prompt: createPromptSender({
		spawnPty: attachPty,
		attached: attach.attached,
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
	feed,
	audit,
});

server.listen(config.port, config.host, () => {
	console.log(
		`kanban listening on http://${config.host}:${config.port} (auth ${config.auth.mode})`,
	);
});

const shutdown = () => {
	source.stop();
	clearInterval(cmuxPoll);
	server.close();
	server.closeAllConnections();
	setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
