import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Board, Session } from "../shared/types.ts";
import {
	accountsIntervalMs,
	createAccountMonitor,
	cswapList,
	cswapSwitch,
	defaultOf,
	loadAccountSamples,
	profileHomes,
	withAccounts,
} from "./accounts.ts";
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
import {
	createBoardTools,
	projectsOf,
	summariesOfBoard,
} from "./boardTools.ts";
import {
	type CloudApi,
	cloudCredentials,
	cloudLauncher,
	cloudTty,
	createCloudApi,
	createCloudSessions,
	remoteLauncher,
	runsOnBlocker,
} from "./cloud.ts";
import { cmuxCli, createCmuxTargets } from "./cmux.ts";
import { createColourStore, loadColours } from "./colours.ts";
import { listCommands } from "./commands.ts";
import { createCommentStore, loadComments } from "./comments.ts";
import { type Config, isLoopback, loadConfig } from "./config.ts";
import { createConversationHub } from "./conversationHub.ts";
import {
	createDigester,
	digestTickMs,
	digestTimeoutMs,
	loadDigests,
} from "./digests.ts";
import {
	claudeAsker,
	claudeExitDeps,
	createExitRunner,
	exitSession,
	liveInteractiveEntry,
	runClaude,
} from "./exit.ts";
import { createFeed, type Feed } from "./feed.ts";
import { listFiles } from "./files.ts";
import { osascriptFolderPicker } from "./folders.ts";
import { createKanbanServer } from "./http.ts";
import { createIgnoreStore, loadIgnores } from "./ignores.ts";
import { startBoard } from "./ingest/index.ts";
import { createLayoutStore, loadLayout } from "./layout.ts";
import { createMirrorHub } from "./mirror.ts";
import { createPeerHook, peerHookSettings } from "./peers.ts";
import { createPermissions } from "./permissions.ts";
import { createPromptSender } from "./prompts.ts";
import { createRegionStore, loadRegions } from "./regions.ts";
import { collectShots, reportShotsDir } from "./reportShots.ts";
import {
	cardsOf,
	createRegionReportRunner,
	createReportRunner,
	regionMembersOf,
} from "./reports.ts";
import { claudeLauncher, routedLauncher } from "./sessions.ts";
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
const ignoresFile = join(config.stateDir, "ignores.json");
const ignores = createIgnoreStore({
	file: ignoresFile,
	initial: await loadIgnores(ignoresFile),
	now: Date.now,
	onChange: (next) => feed?.ignores(next),
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
	onChange: () => feed?.usage(currentUsage()),
});
const accountsFile = join(config.stateDir, "accounts.json");
const accounts = createAccountMonitor({
	file: accountsFile,
	initial: await loadAccountSamples(accountsFile),
	list: cswapList(config.cswapBin),
	root: config.cswapRoot,
	now: Date.now,
	onChange: () => feed?.usage(currentUsage()),
});
const currentUsage = () => withAccounts(usage.current(), accounts.current());
const checkUsage = async () => {
	if (!(await accounts.check())) await usage.check();
};
void checkUsage();
const pollAccounts = async () => {
	const hadDefault = defaultOf(accounts.current()) !== null;
	if (!(await accounts.check()) && hadDefault) await usage.check();
};
const accountsPoll = setInterval(pollAccounts, accountsIntervalMs);
const usagePoll = setInterval(() => {
	if (!defaultOf(accounts.current())) void usage.check();
}, usageIntervalMs);
const switchAccount = cswapSwitch(config.cswapBin);
const makeDefault = async (account: number) => {
	const result = await switchAccount(account);
	if (result.ok) {
		cloudApis.delete(config.claudeHome);
		await accounts.check();
	}
	return result;
};
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
const cloudApis = new Map<string, CloudApi>();
const cloudApiFor = (configDir?: string): CloudApi => {
	const claudeHome =
		configDir === undefined ||
		configDir === defaultOf(accounts.current())?.configDir
			? config.claudeHome
			: configDir;
	const known = cloudApis.get(claudeHome);
	if (known) return known;
	const api = createCloudApi({
		credentials: cloudCredentials({ claudeBin: config.claudeBin, claudeHome }),
	});
	cloudApis.set(claudeHome, api);
	return api;
};
const cloud = await createCloudSessions({
	file: join(config.stateDir, "cloud.json"),
	dir: join(config.stateDir, "cloud"),
	apiFor: cloudApiFor,
	onChange: () => source.refresh(),
});
const source = startBoard({
	claudeHome: config.claudeHome,
	cloud: cloud.sessions,
	profiles: () => profileHomes(config.cswapRoot),
	ignore: (sessionId, cwd) =>
		probes.has(sessionId) || comments.owns(sessionId) || isAgentDir(cwd),
	inCmux: cmuxTargets.has,
	onChange: (board) => {
		layout.observe(board);
		feed?.board(board);
		syncCmuxOnNewPids(board);
	},
});
void syncCmux();
const cmuxPoll = setInterval(syncCmux, cmuxSyncMs);
layout.observe(source.board());
const agentDir = join(config.stateDir, "agent");
await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, agentMarker), "");
const digestsFile = join(config.stateDir, "digests.json");
const digests = createDigester({
	file: digestsFile,
	initial: await loadDigests(digestsFile),
	units: () =>
		summariesOfBoard(source.board(), { layout, annotations, regions }),
	transcript: source.transcript,
	run: (args) => runClaude(config.claudeBin, args, agentDir, digestTimeoutMs),
	watching: () => (feed?.size() ?? 0) > 0,
	now: Date.now,
	onChange: (next) => feed?.digests(next),
});
feed = createFeed({
	board: source.board,
	layout: layout.current,
	annotations: annotations.current,
	colours: colours.current,
	ignores: ignores.current,
	regions: regions.current,
	comments: comments.current,
	usage: currentUsage,
	digests: digests.current,
});
const digestTick = setInterval(digests.pump, digestTickMs);

const exitDeps = claudeExitDeps({
	claudeBin: config.claudeBin,
	claudeHome: config.claudeHome,
	probes,
	archive: cloud.archive,
});
const runExit = createExitRunner({
	exit: (session, force) => exitSession(exitDeps, session, force),
	audit,
	announce: (sessionId, result) => feed?.exit(sessionId, result),
});
const ask = claudeAsker({ claudeBin: config.claudeBin, probes });
const shotsDir = reportShotsDir(config.stateDir);
const shots = (session: Session) =>
	collectShots(session, { dir: shotsDir, claudeHome: config.claudeHome });
const runReport = createReportRunner({
	ask,
	shots,
	annotations,
	cards: () => cardsOf(source.board(), layout.current()),
	audit,
	announce: (sessionId, result) => feed?.report(sessionId, result),
});
const runRegionReport = createRegionReportRunner({
	ask,
	shots,
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
const agentHost = isLoopback(config.host) ? config.host : "127.0.0.1";
const boardUrl = `http://${agentHost.includes(":") ? `[${agentHost}]` : agentHost}:${config.port}`;
const profileOf = (number: number) =>
	accounts
		.current()
		.accounts.find((account) => account.number === number && !account.isDefault)
		?.configDir ?? null;
const accountApi = (account?: number) =>
	cloudApiFor((account === undefined ? null : profileOf(account)) ?? undefined);
const launch = routedLauncher(
	claudeLauncher(config.claudeBin, join(config.stateDir, "images"), {
		cswapBin: config.cswapBin,
		profileOf,
		settings: peerHookSettings(boardUrl),
	}),
	cloudLauncher({
		claudeBin: config.claudeBin,
		cswapBin: config.cswapBin,
		profileOf,
	}),
	remoteLauncher({ apiFor: cloudApiFor, profileOf }),
	cloud.add,
	(account) =>
		accounts
			.current()
			.accounts.find((candidate) =>
				account === undefined
					? candidate.isDefault
					: candidate.number === account,
			)?.configDir,
);
const attachPty = claudeAttachPty(config.claudeBin);
const attach = createAttachHub(attachPty, audit, (short) =>
	conversation.release(short),
);
const conversation = createConversationHub({
	session: (id) =>
		source.board().sessions.find((session) => session.id === id) ?? null,
	transcriptPath: source.transcriptPath,
	block: source.block,
	tty: (session) => {
		if (session.cloud) {
			return cloudTty(cloud, session.id);
		}
		const short = session.short;
		if (session.kind === "background" && session.attachable && short) {
			return attach.screen(short)
				? sharedAttachTty({ live: () => attach.screen(short) })
				: attachTty({
						spawnPty: attachPty,
						short,
						cwd: session.cwd,
						configDir: session.configDir,
					});
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
const agent = createBoardAgent({
	store: comments,
	tokens: agentTokens,
	spawn: claudeAgentSpawner(config.claudeBin, agentDir),
	boardUrl,
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
		cloudSend: cloud.send,
	}),
	answer: conversation.respond,
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
	reportShots: shotsDir,
	layout,
	annotations,
	colours,
	ignores,
	regions,
	comments,
	agent,
	agentTokens,
	tools,
	peerHook: createPeerHook({
		units: () =>
			summariesOfBoard(source.board(), { layout, annotations, regions }),
		digests: digests.current,
	}),
	attach,
	mirror: createMirrorHub({ cmux, resolve: cmuxTargets.resolve, audit }),
	conversation,
	files: (cwd, query) =>
		listFiles({ cwd, query, claudeHome: config.claudeHome }),
	commands: (cwd) => listCommands({ claudeHome: config.claudeHome, cwd }),
	cloudBlocker: runsOnBlocker(accountApi),
	remoteHosts: (account) => accountApi(account).hosts(),
	pickFolder: osascriptFolderPicker(),
	makeDefault,
	permissions: createPermissions({
		sessions: () => source.board().sessions,
		isExiting: runExit.isExiting,
		ask,
	}),
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
	cloud.stop();
	clearInterval(cmuxPoll);
	clearInterval(usagePoll);
	clearInterval(accountsPoll);
	clearInterval(digestTick);
	server.close();
	server.closeAllConnections();
	setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
