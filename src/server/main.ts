import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { browseFolder } from "../runner/browse.ts";
import { createSignalSampler, listCheckouts } from "../runner/signals.ts";
import { fileVersion } from "../runner/update.ts";
import {
	createUsageSampler,
	type ProcessStat,
	processStats,
} from "../runner/usage.ts";
import { readKanbanEnv } from "../shared/envFile.ts";
import type { Project } from "../shared/projects.ts";
import type {
	PlacedSession,
	RunnerSignals,
	RunnerUsage,
} from "../shared/runners.ts";
import {
	type Activity,
	type Board,
	isRunnerTarget,
	landingId,
	type NewSessionRequest,
	type NewSessionResult,
	noButler,
	type Session,
} from "../shared/types.ts";
import {
	accountsIntervalMs,
	createAccountMonitor,
	cswapList,
	cswapSwitch,
	defaultOf,
	loadAccountSamples,
	planBlock,
	profileHomes,
	withAccounts,
} from "./accounts.ts";
import { createAnnotationStore, loadAnnotations } from "./annotations.ts";
import { createAnnouncer } from "./announce.ts";
import { createArchiveStore, loadArchive } from "./archive.ts";
import { claudeAttachPty, createAttachHub } from "./attach.ts";
import { fileAudit } from "./audit.ts";
import { authenticatorFor, runnerTokenCheck } from "./auth.ts";
import { createAutoAnswer, permissionsMode } from "./autoAnswer.ts";
import {
	createBoardTools,
	createPromptApprover,
	projectsOf,
	summariesOfBoard,
} from "./boardTools.ts";
import { buildIdReader } from "./build.ts";
import {
	type Butler,
	cardReplyThread,
	createButler,
	loadButlerState,
	threadCardPrefix,
} from "./butler.ts";
import { loadCardReplies } from "./butlerInbox.ts";
import {
	createThreadLogStore,
	loadLegacyThreadReplies,
	loadThreadLogs,
} from "./butlerThreads.ts";
import { agentMarker, isAgentDir } from "./claudeRuns.ts";
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
import {
	type Config,
	isLoopback,
	loadConfig,
	withFileSecrets,
} from "./config.ts";
import { createConversationHub } from "./conversationHub.ts";
import {
	createDigester,
	digestTickMs,
	digestTimeoutMs,
	loadDigests,
} from "./digests.ts";
import {
	createDocStoreRegistry,
	docStoresFileName,
	migrateDocStoreFiles,
} from "./docStores.ts";
import { loadDocFiles } from "./docs.ts";
import { createDocsHttp, sessionMcpConfig } from "./docsHttp.ts";
import {
	claudeAsker,
	claudeExitDeps,
	createExitRunner,
	exitSession,
	liveInteractiveEntry,
	runClaude,
} from "./exit.ts";
import { createFailover, type Failover } from "./failover.ts";
import { createFeed, type Feed } from "./feed.ts";
import { listFiles } from "./files.ts";
import { osascriptFolderPicker } from "./folders.ts";
import { gitMainLog, readHistory } from "./history.ts";
import { createKanbanServer, newCsrfToken } from "./http.ts";
import { createIgnoreStore, loadIgnores } from "./ignores.ts";
import { startBoard } from "./ingest/index.ts";
import { compareShadow } from "./jobCompare.ts";
import { createJobQueue } from "./jobQueue.ts";
import { createJobsHttp, jobsOffFile } from "./jobsHttp.ts";
import { createLastRunStore, loadLastRuns } from "./lastRuns.ts";
import { createLayoutStore, loadLayout } from "./layout.ts";
import { listenAll } from "./listen.ts";
import {
	createMessageEdgeStore,
	edgesFromAudit,
	loadEdges,
	readAuditTail,
} from "./messageEdges.ts";
import { createMirrorHub } from "./mirror.ts";
import { createNotificationStore, loadNotifications } from "./notifications.ts";
import { createPeerHook, peerHookSettings } from "./peers.ts";
import { createPermissions } from "./permissions.ts";
import { createProjectsSource } from "./projects.ts";
import { createPromptSender } from "./prompts.ts";
import { createRegionStore, loadRegions } from "./regions.ts";
import { createRelationStore, loadRelations } from "./relations.ts";
import { collectShots, reportShotsDir } from "./reportShots.ts";
import {
	cardsOf,
	createRegionReportRunner,
	createReportRunner,
	regionMembersOf,
} from "./reports.ts";
import { createDropRecorder, dropFile } from "./runnerDrops.ts";
import { createRunnerKeys, parseRunnerAddresses } from "./runnerKeys.ts";
import { createRunnerHub } from "./runners.ts";
import {
	claudeLauncher,
	routedLauncher,
	type SessionLauncher,
} from "./sessions.ts";
import { retireFile } from "./stateFile.ts";
import { attachTty, cmuxTty, sharedAttachTty } from "./terminals.ts";
import { boardParts, createUndo } from "./undo.ts";
import {
	claudeCodeToken,
	createUsageMonitor,
	loadUsageSamples,
	usageIntervalMs,
} from "./usage.ts";
import {
	createPlacementLog,
	placementReport,
	wouldPlaceOffFile,
} from "./wouldPlace.ts";

const configOrExit = (): Config => {
	try {
		return loadConfig(withFileSecrets(process.env, readKanbanEnv()));
	} catch (error) {
		console.error(`kanban: ${(error as Error).message}`);
		process.exit(1);
	}
};

const config = configOrExit();
const cmuxSyncMs = 5000;
const docsFrameMs = 250;
const audit = fileAudit(config.auditLog);

let feed: Feed | null = null;
let failover: Failover | null = null;
let butler: Butler | null = null;
const layoutFile = join(config.stateDir, "layout.json");
const layout = createLayoutStore({
	file: layoutFile,
	initial: await loadLayout(layoutFile),
	onChange: (next) => feed?.layout(next),
});
const annotationsFile = join(config.stateDir, "annotations.json");
const relationsFile = join(config.stateDir, "relations.json");
const migratedDocStores = await migrateDocStoreFiles({
	stateDir: config.stateDir,
	annotationsFile,
	relationsFile,
});
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
const lastRunsFile = join(config.stateDir, "last-runs.json");
const lastRuns = createLastRunStore({
	file: lastRunsFile,
	initial: await loadLastRuns(lastRunsFile),
	onChange: (next) => feed?.lastRuns(next),
});
const ignoresFile = join(config.stateDir, "ignores.json");
const ignores = createIgnoreStore({
	file: ignoresFile,
	initial: await loadIgnores(ignoresFile),
	now: Date.now,
	onChange: (next) => feed?.ignores(next),
});
const notificationsFile = join(config.stateDir, "notifications.json");
const notifications = createNotificationStore({
	file: notificationsFile,
	initial: await loadNotifications(notificationsFile),
	now: Date.now,
	ignored: (session) => {
		const at = Date.now();
		return Object.entries(ignores.current()).some(
			([root, until]) =>
				until > at &&
				(session.cwd === root ||
					session.cwd.startsWith(`${root.replace(/\/+$/, "")}/`)),
		);
	},
	onChange: (next) => feed?.notifications(next),
});
const regionsFile = join(config.stateDir, "regions.json");
const regions = createRegionStore({
	file: regionsFile,
	initial: await loadRegions(regionsFile),
	onChange: (next) => feed?.regions(next),
});
const relations = createRelationStore({
	file: relationsFile,
	initial: await loadRelations(relationsFile),
	onChange: (next) => feed?.relations(next),
});
// Messages between Butler's threads and sessions, their words served to the page alone.
const messageEdgesFile = join(config.stateDir, "butler-edges.json");
const messageEdges = createMessageEdgeStore({
	file: messageEdgesFile,
	initial: await loadEdges(messageEdgesFile),
	onChange: (next) => feed?.butlerEdges(next),
});
// Butler's prompts from before the board kept edges, or from a lost file, come back from the audit log.
messageEdges.seed(edgesFromAudit(await readAuditTail(config.auditLog)));
let docsFrame: NodeJS.Timeout | undefined;
const docsChanged = () => {
	if (docsFrame) return;
	docsFrame = setTimeout(() => {
		docsFrame = undefined;
		feed?.docs();
	}, docsFrameMs);
};
const docs = await loadDocFiles({
	dir: join(config.stateDir, "docs"),
	onChange: docsChanged,
});
const docStores = createDocStoreRegistry({
	file: join(config.stateDir, docStoresFileName),
	initial: migratedDocStores,
	files: docs,
	onChange: docsChanged,
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
	planOf: async (account) => {
		const profile = await cloudApiFor(
			account.isDefault ? undefined : account.configDir,
		).profile();
		return profile.ok ? planBlock(profile.value, account.email) : undefined;
	},
});
const currentUsage = () => ({
	...withAccounts(usage.current(), accounts.current()),
	...(failover ? { failover: failover.view() } : {}),
});
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
const liveActivities: readonly Activity[] = [
	"working",
	"needs-you",
	"watching",
	"idle",
];
const sampleUsage = createUsageSampler();
let localUsage: RunnerUsage | null = null;
const sampleSignals = createSignalSampler({
	checkouts: () => listCheckouts([join(homedir(), "workspace")]),
});
let localSignals: RunnerSignals | null = null;
let localStats = new Map<number, ProcessStat>();
const localPlaced = (): Session[] =>
	source
		.board()
		.sessions.filter(
			(session) =>
				!session.cloud &&
				!session.runner &&
				liveActivities.includes(session.activity),
		);
let runnersFrame: NodeJS.Timeout | undefined;
let remoteSignature = "";
const runnersChanged = () => {
	const signature = JSON.stringify([
		runnerHub.sessions(),
		runnerHub.subagents(),
	]);
	if (signature !== remoteSignature) {
		remoteSignature = signature;
		source.refresh();
	}
	if (runnersFrame) return;
	runnersFrame = setTimeout(() => {
		runnersFrame = undefined;
		feed?.runners(runnerHub.views());
	}, 250);
};
const hubMachine = hostname().replace(/\.local$/, "");
// Runners update themselves to the runner.js this release serves.
const runnerDrops = createDropRecorder(
	dropFile(join(config.stateDir, "runner-drops.json")),
);
const servedRunner = await fileVersion(join(config.dist, "runner.js"));
const runnerKeys = createRunnerKeys({
	file: join(config.stateDir, "runner-keys.json"),
	sharedToken: config.runnerToken,
	addresses: parseRunnerAddresses(config.runnerAddresses),
	log: (line) => console.log(line),
});
const jobQueue = createJobQueue({
	file: join(config.stateDir, "jobs.sqlite"),
	log: (line) => console.log(line),
	compare: compareShadow,
});
const offloadOff = jobsOffFile(config.stateDir);
const runnerHub = createRunnerHub({
	jobs: jobQueue,
	jobsOff: () => existsSync(offloadOff),
	plainOnly: config.plainOnlyRunners,
	updateLast: config.updateLastRunners,
	keys: runnerKeys,
	runnerVersion: () => servedRunner,
	expected: config.expectedRunners,
	hubHome: homedir(),
	drops: runnerDrops,
	log: (line) => console.log(line),
	local: () => ({
		name: hubMachine,
		usage: localUsage,
		signals: localSignals,
		cap: config.runnerCap,
		sessions: localPlaced().map((session): PlacedSession => {
			const stat =
				session.pid === null ? undefined : localStats.get(session.pid);
			return {
				id: session.id,
				name: session.name,
				cwd: session.cwd,
				activity: session.activity,
				cpuPercent: stat?.cpuPercent ?? null,
				rss: stat?.rss ?? null,
			};
		}),
	}),
	onChange: runnersChanged,
});
const runnersTick = async () => {
	runnerHub.sweep();
	localUsage = await sampleUsage();
	localSignals = await sampleSignals().catch(() => localSignals);
	localStats = await processStats(
		localPlaced().flatMap((session) =>
			session.pid === null ? [] : [session.pid],
		),
	);
	if ((feed?.size() ?? 0) > 0) feed?.runners(runnerHub.views());
};
const runnersPoll = setInterval(() => void runnersTick(), 5_000);
const permissions = permissionsMode();
const answersByEffect = permissions !== "legacy";
const cloud = await createCloudSessions({
	file: join(config.stateDir, "cloud.json"),
	dir: join(config.stateDir, "cloud"),
	apiFor: cloudApiFor,
	effects: answersByEffect,
	onChange: () => source.refresh(),
});
const source = startBoard({
	claudeHome: config.claudeHome,
	cloud: cloud.sessions,
	remote: () => runnerHub.sessions(),
	remoteSubagents: () => runnerHub.subagents(),
	profiles: () => profileHomes(config.cswapRoot),
	ignore: (sessionId, cwd) =>
		probes.has(sessionId) || comments.owns(sessionId) || isAgentDir(cwd),
	inCmux: cmuxTargets.has,
	onChange: (board) => {
		layout.observe(board);
		relations.observe(board);
		notifications.observe(board);
		feed?.board(board);
		syncCmuxOnNewPids(board);
	},
});
void syncCmux();
const cmuxPoll = setInterval(syncCmux, cmuxSyncMs);
layout.observe(source.board());
relations.observe(source.board());
notifications.observe(source.board());
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
const pageBuild = buildIdReader(config.dist);
feed = createFeed({
	build: pageBuild,
	board: source.board,
	layout: layout.current,
	annotations: annotations.current,
	colours: colours.current,
	lastRuns: lastRuns.current,
	ignores: ignores.current,
	notifications: notifications.current,
	regions: regions.current,
	comments: comments.current,
	usage: currentUsage,
	digests: digests.current,
	relations: relations.current,
	docs: docs.index,
	docStores: docStores.current,
	butler: () => butler?.current() ?? noButler,
	butlerEdges: () => messageEdges.summaries(),
	runners: () => runnerHub.views(),
});
const digestTick = setInterval(digests.pump, digestTickMs);

// cmd+z on the board: your edits and Butler's, and cloud sessions exited,
// which come back by unarchiving them on claude.ai.
const undo = createUndo({
	parts: boardParts({
		layout,
		annotations,
		regions,
		colours,
		relations,
		cloud,
	}),
});
const undoable = {
	layout: undo.track("layout", layout, ["set", "setMany"]),
	annotations: undo.track("annotations", annotations, ["put", "remove"]),
	regions: undo.track("regions", regions, ["create", "update", "remove"]),
	colours: undo.track("colours", colours, ["set"]),
	relations: undo.track("relations", relations, ["create", "remove"]),
};
/** Lets a card taken off the board go: a pinned spot no longer holds it there. */
const unpin = (key: string) => {
	const placement = layout.current()[key];
	if (!placement?.pinned) return;
	const { pinned: _, ...rest } = placement;
	layout.set({ key, placement: rest });
};
const archiveCloud = async (id: string) => {
	const record = cloud.record(id);
	const archived = await cloud.archive(id);
	if (archived.ok && record) undo.note("cloud", id, record, null);
	if (archived.ok && !archived.value.remote) unpin(`session:${id}`);
	return archived;
};

const exitDeps = claudeExitDeps({
	claudeBin: config.claudeBin,
	claudeHome: config.claudeHome,
	probes,
	archive: archiveCloud,
});
const runExit = createExitRunner({
	exit: (session, force) =>
		session.runner
			? runnerHub.stop(session, force)
			: exitSession(exitDeps, session, force),
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
const agentHost = config.hosts.find(isLoopback) ?? "127.0.0.1";
const boardUrl = `http://${agentHost.includes(":") ? `[${agentHost}]` : agentHost}:${config.port}`;
const profileOf = (number: number) =>
	accounts
		.current()
		.accounts.find((account) => account.number === number && !account.isDefault)
		?.configDir ?? null;
const accountApi = (account?: number) =>
	cloudApiFor((account === undefined ? null : profileOf(account)) ?? undefined);
const accountOf = (account?: number) =>
	accounts
		.current()
		.accounts.find((candidate) =>
			account === undefined
				? candidate.isDefault
				: candidate.number === account,
		);
const routed = routedLauncher(
	claudeLauncher(config.claudeBin, join(config.stateDir, "images"), {
		cswapBin: config.cswapBin,
		profileOf,
		settings: peerHookSettings(boardUrl),
		mcpConfig: sessionMcpConfig(
			process.execPath,
			resolve(import.meta.dirname, "../agent/sessionMcp.ts"),
			boardUrl,
		),
	}),
	cloudLauncher({
		claudeBin: config.claudeBin,
		cswapBin: config.cswapBin,
		profileOf,
	}),
	remoteLauncher({ apiFor: cloudApiFor, profileOf }),
	cloud.add,
	(account) => accountOf(account)?.configDir,
);
const placements = createPlacementLog({
	off: () => existsSync(wouldPlaceOffFile(config.stateDir)),
});
// Only notes where a machine launch would have gone, judged on the machines as
// they stood before it; it still goes where asked.
const isMachineLaunch = (runsOn: string | undefined): runsOn is string =>
	runsOn === "local" || (runsOn !== undefined && isRunnerTarget(runsOn));
const machinesNow = () => {
	try {
		return runnerHub.candidates();
	} catch (error) {
		console.error(`would-place: ${(error as Error).message}`);
		return null;
	}
};
const notePlacement = (
	asked: NewSessionRequest,
	candidates: ReturnType<typeof runnerHub.candidates>,
	result: NewSessionResult,
) => {
	const runsOn = asked.runsOn ?? "";
	try {
		placements.record(
			{
				id: result.ok ? landingId(result) : null,
				cwd: asked.cwd,
				runsOn,
				label:
					candidates.find((candidate) => candidate.view.runsOn === runsOn)?.view
						.label ?? runsOn,
			},
			candidates,
		);
	} catch (error) {
		console.error(`would-place: ${(error as Error).message}`);
	}
};
const launch: SessionLauncher = async (asked) => {
	const before =
		isMachineLaunch(asked.runsOn) && placements.enabled()
			? machinesNow()
			: null;
	const result = await launchAsked(asked);
	if (before) notePlacement(asked, before, result);
	return result;
};
const launchAsked: SessionLauncher = async (asked) => {
	if (asked.runsOn && isRunnerTarget(asked.runsOn)) {
		return runnerHub.launch(asked);
	}
	// A new session starts on the account with the most headroom, unless the one asked for can take it.
	const request = failover?.place(asked) ?? asked;
	const blocked = accountOf(request.account)?.blocked;
	return blocked ? { ok: false, error: blocked } : routed(request);
};
failover = createFailover({
	accounts: () => accounts.current().accounts,
	now: Date.now,
	stop: (session) => exitDeps.stop(session),
	launch: routed,
	notify: (sessionId, title, body) =>
		notifications.raise(sessionId, title, body),
	audit,
	onChange: () => feed?.usage(currentUsage()),
});
const failoverPoll = setInterval(
	() => void failover?.observe(source.board()),
	accountsIntervalMs,
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
const announce = createAnnouncer({
	board: () => source.board(),
	prompt: conversation.prompt,
	audit,
});
const promptApprover = createPromptApprover({ cloud, terminal: conversation });
const boardTools = createBoardTools({
	source,
	edges: messageEdges,
	...undoable,
	comments,
	launch,
	exit: runExit,
	limited: (session) => failover?.limited(session) ?? false,
	ask,
	prompt: createPromptSender({
		spawnPty: attachPty,
		attached: attachedAnywhere,
		cmux,
		resolve: cmuxTargets.resolve,
		cloudSend: cloud.send,
	}),
	announce,
	answer: conversation.respond,
	approver: promptApprover,
	namesEffects: answersByEffect,
	history: (since) =>
		readHistory(
			{
				homes: () => [config.claudeHome, ...profileHomes(config.cswapRoot)],
				board: source.board,
				gitLog: gitMainLog,
			},
			since,
		),
	audit,
});
// Butler's changes for one thread are recorded as one undo step per request.
const tools: typeof boardTools = (threadId, call) =>
	undo.as(`butler:${threadId}`, () => boardTools(threadId, call));
const butlerFile = join(config.stateDir, "butler.json");
// Thread cards' events and approvals, which only the page's thread view reads.
const threadLogsFile = join(config.stateDir, "butler-threads.json");
// Aaron's replies from thread cards and the DM, waiting for spike in the one Butler inbox.
const repliesFile = join(config.stateDir, "butler-replies.json");
const savedReplies = await loadCardReplies(repliesFile);
const threadLogs = createThreadLogStore({
	file: threadLogsFile,
	initial: await loadThreadLogs(threadLogsFile),
});
const legacyReplies = (await loadLegacyThreadReplies(threadLogsFile)).filter(
	({ message }) => !savedReplies.some((reply) => reply.id === message.id),
);
// Cards and sessions whose work is over, for the sidebar's Archive view.
const archiveFile = join(config.stateDir, "archive.json");
const archive = createArchiveStore({
	file: archiveFile,
	initial: await loadArchive(archiveFile),
});
const projectsSource = createProjectsSource({
	config: config.projects,
	readFile: (file) => readFile(file, "utf8"),
});
// Until the first good read Tidy lays nothing out, so a slow or failed read never folds every project region into Unsorted.
let projects: readonly Project[] | null =
	config.projects.mode === "off" ? [] : null;
let projectsShape = "";
/** Rereads Butler's projects and tidies the board when one he keeps a region for changed. */
const refreshProjects = async () => {
	const listing = await projectsSource.list();
	if (listing.status !== "ok" && listing.status !== "fixture") return;
	const shape = JSON.stringify(
		listing.projects.map((p) => [
			p.id,
			p.title,
			p.stage,
			p.parent,
			p.links,
			p.sessions,
			p.keywords,
		]),
	);
	if (shape === projectsShape) return;
	projectsShape = shape;
	projects = listing.projects;
	butler?.tidy();
};
butler = createButler({
	source,
	layout,
	annotations,
	regions,
	tools,
	projects: () => projects,
	audit,
	file: butlerFile,
	...(await loadButlerState(butlerFile)),
	threads: threadLogs,
	cloud: () => cloud.overview(),
	edges: messageEdges,
	onChange: (next) => feed?.butler(next),
	comments,
	repliesFile,
	initialReplies: [
		...savedReplies,
		...legacyReplies.map(({ card, message }) => {
			const target = card.slice(threadCardPrefix.length);
			return {
				id: message.id,
				thread: cardReplyThread(target),
				target,
				at: message.at,
				text: message.text,
			};
		}),
	],
	archive,
	schedule: (run, ms) => {
		setTimeout(run, ms).unref();
	},
});
// An older board's replies now wait in butler-replies.json, so its thread logs drop them once that is saved.
if (legacyReplies.length > 0) {
	await butler.saved();
	const kept = new Set((await loadCardReplies(repliesFile)).map((r) => r.id));
	if (legacyReplies.every(({ message }) => kept.has(message.id))) {
		threadLogs.rewrite();
	}
}
const autoAnswer =
	permissions === "legacy"
		? null
		: createAutoAnswer({
				sessions: () => source.board().sessions,
				approver: promptApprover,
				audit,
				mode: permissions,
			});
const autoAnswerPoll = setInterval(() => void autoAnswer?.(), 3000);
const relayCheck = setInterval(() => {
	butler?.inbox?.check();
	butler?.check();
	archive.observe(source.board().sessions);
	void refreshProjects().catch(() => {});
}, 5000);
// Scheduled reports were the retired board agent's. Their file is kept
// aside, not deleted, so Aaron can ask Butler to schedule them as jobs.
await retireFile(join(config.stateDir, "schedules.json"));

const server = createKanbanServer({
	origins: config.origins,
	dist: config.dist,
	authenticate: authenticatorFor(config.auth),
	runnerToken: (req) => {
		const held = runnerKeys.credential(req);
		if (held.kind === "own") return "ok";
		return held.kind === "shared"
			? runnerTokenCheck(config.runnerToken)(req)
			: held.kind;
	},
	runnerKeys,
	jobs: createJobsHttp({
		queue: jobQueue,
		offFile: offloadOff,
		runners: () => runnerHub.views(),
	}),
	source,
	launch,
	exit: runExit,
	report: runReport,
	regionReport: runRegionReport,
	reportShots: shotsDir,
	...undoable,
	lastRuns,
	ignores,
	notifications,
	undo,
	docs: createDocsHttp({ files: docs, stores: docStores }),
	comments,
	tools,
	butler,
	edges: messageEdges,
	archive,
	projects: projectsSource,
	csrf: newCsrfToken(),
	build: pageBuild,
	peerHook: createPeerHook({
		units: () =>
			summariesOfBoard(source.board(), { layout, annotations, regions }),
		digests: digests.current,
		sessions: () => source.board().sessions,
		relations: relations.current,
		docStores: docStores.current,
		docs: docs.index,
	}),
	attach,
	mirror: createMirrorHub({ cmux, resolve: cmuxTargets.resolve, audit }),
	conversation,
	files: (cwd, query) =>
		listFiles({ cwd, query, claudeHome: config.claudeHome }),
	commands: (cwd) => listCommands({ claudeHome: config.claudeHome, cwd }),
	cloudBlocker: async (cwd, runsOn, account) =>
		isRunnerTarget(runsOn)
			? runnerHub.blocker(runsOn)
			: runsOnBlocker(accountApi)(cwd, runsOn, account),
	runners: runnerHub,
	placement: () =>
		placementReport(
			runnerHub.candidates(),
			runnerDrops.records(),
			placements,
			wouldPlaceOffFile(config.stateDir),
		),
	remoteHosts: (account) => accountApi(account).hosts(),
	pickFolder: osascriptFolderPicker(),
	browseFolders: (runsOn, path) =>
		isRunnerTarget(runsOn)
			? runnerHub.browse(runsOn, path)
			: browseFolder(path, { machine: hubMachine, home: homedir() }),
	makeDefault,
	permissions: createPermissions({
		sessions: () => source.board().sessions,
		isExiting: runExit.isExiting,
		ask,
	}),
	announce,
	feed,
	audit,
});

const listening = listenAll(server, config.hosts, config.port, (host) => {
	const shown = host.includes(":") ? `[${host}]` : host;
	console.log(
		`kanban listening on http://${shown}:${config.port} (auth ${config.auth.mode}${config.runnerToken ? ", runner token set" : ""})`,
	);
});

const shutdown = () => {
	clearInterval(relayCheck);
	clearInterval(autoAnswerPoll);
	source.stop();
	cloud.stop();
	clearInterval(cmuxPoll);
	clearInterval(runnersPoll);
	runnerHub.stopAll();
	jobQueue.close();
	clearInterval(usagePoll);
	clearInterval(accountsPoll);
	clearInterval(failoverPoll);
	clearInterval(digestTick);
	listening.close();
	server.close();
	server.closeAllConnections();
	setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
