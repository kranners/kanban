import { join } from "node:path";
import type { Board } from "../shared/types.ts";
import { createAnnotationStore, loadAnnotations } from "./annotations.ts";
import { claudeAttachPty, createAttachHub } from "./attach.ts";
import { fileAudit } from "./audit.ts";
import { authenticatorFor } from "./auth.ts";
import { cmuxCli, createCmuxTargets } from "./cmux.ts";
import { type Config, loadConfig } from "./config.ts";
import { claudeExitDeps, exitSession, liveInteractiveEntry } from "./exit.ts";
import { createFeed, type Feed } from "./feed.ts";
import { createKanbanServer } from "./http.ts";
import { startBoard } from "./ingest/index.ts";
import { createLayoutStore, loadLayout } from "./layout.ts";
import { createMirrorHub } from "./mirror.ts";
import { createPreviewer } from "./preview.ts";
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
	ignore: (sessionId) => probes.has(sessionId),
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
});

const exitDeps = claudeExitDeps({
	claudeBin: config.claudeBin,
	claudeHome: config.claudeHome,
	probes,
});

const server = createKanbanServer({
	origins: config.origins,
	dist: config.dist,
	authenticate: authenticatorFor(config.auth),
	source,
	launch: claudeLauncher(config.claudeBin),
	exit: (session, force) => exitSession(exitDeps, session, force),
	layout,
	annotations,
	attach: createAttachHub(claudeAttachPty(config.claudeBin), audit),
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
