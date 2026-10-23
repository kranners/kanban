import { join } from "node:path";
import { claudeAttachPty, createAttachHub } from "./attach.ts";
import { fileAudit } from "./audit.ts";
import { authenticatorFor } from "./auth.ts";
import { type Config, loadConfig } from "./config.ts";
import { claudeExitDeps, exitSession } from "./exit.ts";
import { createFeed, type Feed } from "./feed.ts";
import { createKanbanServer } from "./http.ts";
import { startBoard } from "./ingest/index.ts";
import { createLayoutStore, loadLayout } from "./layout.ts";
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
const audit = fileAudit(config.auditLog);

let feed: Feed | null = null;
const layoutFile = join(config.stateDir, "layout.json");
const layout = createLayoutStore({
	file: layoutFile,
	initial: await loadLayout(layoutFile),
	onChange: (next) => feed?.layout(next),
});
const probes = new Set<string>();
const previewer = createPreviewer({
	transcript: (sessionId, limit) => source.transcript(sessionId, limit),
	emit: (preview) => feed?.preview(preview),
});
const source = startBoard({
	claudeHome: config.claudeHome,
	ignore: (sessionId) => probes.has(sessionId),
	onChange: (board) => {
		feed?.board(board);
		layout.observe(board);
		void previewer.update(board);
	},
});
void previewer.update(source.board());
layout.observe(source.board());
feed = createFeed({
	board: source.board,
	previews: previewer.latest,
	layout: layout.current,
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
	attach: createAttachHub(claudeAttachPty(config.claudeBin), audit),
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
	server.close();
	server.closeAllConnections();
	setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
