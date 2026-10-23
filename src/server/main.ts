import { claudeAttachPty, createAttachHub } from "./attach.ts";
import { fileAudit } from "./audit.ts";
import { authenticatorFor } from "./auth.ts";
import { type Config, loadConfig } from "./config.ts";
import { createFeed, type Feed } from "./feed.ts";
import { createKanbanServer } from "./http.ts";
import { startBoard } from "./ingest/index.ts";
import { claudeLogs, createPreviewer } from "./preview.ts";
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
const source = startBoard({
	claudeHome: config.claudeHome,
	onChange: (board) => feed?.board(board),
});
const previewer = createPreviewer({
	board: source.board,
	logs: claudeLogs(config.claudeBin),
	emit: (preview) => feed?.preview(preview),
});
feed = createFeed({
	board: source.board,
	previews: previewer.latest,
	onFirstClient: previewer.start,
	onLastClient: previewer.stop,
});

const server = createKanbanServer({
	origins: config.origins,
	dist: config.dist,
	authenticate: authenticatorFor(config.auth),
	source,
	launch: claudeLauncher(config.claudeBin),
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
	previewer.stop();
	source.stop();
	server.close();
	server.closeAllConnections();
	setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
