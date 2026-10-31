import { type FSWatcher, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	outstandingStates,
	subagentCountsBySession,
} from "../../shared/subagents.ts";
import type {
	Board,
	Link,
	Message,
	NodeRef,
	Session,
	Subagent,
	TokenUsage,
	TranscriptEntry,
} from "../../shared/types.ts";
import type { CloudSession } from "../cloud.ts";
import { firstLine, truncate } from "./json.ts";
import { locateTranscript, projectSlug } from "./locate.ts";
import {
	entryLimit,
	type PeerRef,
	type ResolvePeer,
	type TranscriptFacts,
} from "./records.ts";
import {
	activityOf,
	isAlive,
	type Job,
	type RegistryEntry,
	readJobs,
	readRegistry,
} from "./registry.ts";
import { shellsOf } from "./shells.ts";
import {
	abandoned,
	type FoundSubagent,
	type MetaCache,
	newestPerSession,
	runningWorkflows,
	scanSubagents,
	settleSubagents,
	workflowRunsOf,
} from "./subagents.ts";
import { advanceTail, createTail, readFacts, type Tail } from "./tail.ts";

export type BoardHandle = {
	board(): Board;
	transcript(sessionId: string, limit: number): Promise<TranscriptEntry[]>;
	transcriptPath(node: NodeRef): string | null;
	recentCwds(): string[];
	block(sessionId: string): Record<string, unknown> | null;
	refresh(): void;
	stop(): void;
};

type Owner = { node: NodeRef; facts: TranscriptFacts };

type Homed<T> = T & { home: string };

type Tracked = {
	id: string;
	home: string;
	entry: Homed<RegistryEntry> | null;
	job: Homed<Job> | null;
	tail: Tail | null;
};

const pollMs = 2000;
const debounceMs = 250;
const locateRetryMs = 10_000;
const stoppedJobWindowMs = 24 * 60 * 60_000;
const messageLimit = 200;
const goalLength = 100;

export function startBoard(opts: {
	claudeHome: string;
	onChange: (board: Board) => void;
	ignore?: (sessionId: string, cwd: string) => boolean;
	inCmux?: (pid: number) => boolean;
	profiles?: () => string[];
	cloud?: () => CloudSession[];
}): BoardHandle {
	const {
		claudeHome,
		onChange,
		ignore = () => false,
		inCmux = () => false,
		profiles = () => [],
		cloud = () => [],
	} = opts;
	const tails = new Map<string, Tail>();
	const agentTails = new Map<string, Tail>();
	const locateAttempts = new Map<string, number>();
	const metaCache: MetaCache = new Map();
	const byPid = new Map<number, string>();
	const bySocket = new Map<string, string>();
	const byName = new Map<string, string>();
	const subagentPaths = new Map<string, string>();
	let cwds: string[] = [];
	let cloudPaths = new Map<string, string>();
	let blocks = new Map<string, Record<string, unknown>>();

	const resolve: ResolvePeer = (ref: PeerRef) =>
		(ref.pid !== undefined ? byPid.get(ref.pid) : undefined) ??
		(ref.socket !== undefined ? bySocket.get(ref.socket) : undefined) ??
		(ref.name !== undefined ? byName.get(ref.name) : undefined) ??
		null;

	function tailFor(
		id: string,
		cwd: string,
		home: string,
		now: number,
	): Tail | null {
		const existing = tails.get(id);
		if (existing) return existing;
		if (now - (locateAttempts.get(id) ?? 0) < locateRetryMs) return null;
		locateAttempts.set(id, now);
		const path = locateTranscript(home, id, cwd);
		if (!path) return null;
		const tail = createTail(path);
		tails.set(id, tail);
		locateAttempts.delete(id);
		return tail;
	}

	function build(): Board {
		const now = Date.now();
		const homes = [claudeHome, ...profiles()];
		const clouds = cloud().filter((cs) => !ignore(cs.id, cs.cwd));
		const cloudIds = new Set(clouds.map((cs) => cs.id));
		const registry = homes
			.flatMap((home) =>
				readRegistry(home).map((entry) => ({ ...entry, home })),
			)
			.filter(
				(entry) =>
					!ignore(entry.sessionId, entry.cwd) &&
					!cloudIds.has(entry.bridgeSessionId ?? "") &&
					isAlive(entry.pid),
			);
		for (const entry of registry) {
			byPid.set(entry.pid, entry.sessionId);
			if (entry.socket) bySocket.set(entry.socket, entry.sessionId);
			if (entry.name) byName.set(entry.name, entry.sessionId);
		}
		const jobs = homes.flatMap((home) =>
			readJobs(home).map((job) => ({ ...job, home })),
		);
		const tracked = collectTracked(registry, jobs, now);
		cwds = recentCwdsOf(registry, jobs);
		blocks = new Map(
			[...tracked.values()].flatMap(({ id, job }) =>
				job?.block ? [[id, job.block]] : [],
			),
		);

		for (const item of tracked.values()) {
			const cwd = item.entry?.cwd ?? item.job?.cwd ?? "";
			item.tail = tailFor(item.id, cwd, item.home, now);
		}
		for (const item of [...tracked.values()].sort(byStartedAt)) {
			if (item.tail) advanceTail(item.tail, resolve);
		}
		const cloudTails = new Map(
			clouds.map((cs) => {
				const existing = tails.get(cs.id);
				const tail =
					existing?.path === cs.transcript
						? existing
						: createTail(cs.transcript);
				tails.set(cs.id, tail);
				advanceTail(tail, resolve);
				return [cs.id, tail] as const;
			}),
		);
		cloudPaths = new Map(clouds.map((cs) => [cs.id, cs.transcript]));
		for (const id of tails.keys()) {
			if (!tracked.has(id) && !cloudTails.has(id)) tails.delete(id);
		}
		for (const id of locateAttempts.keys()) {
			if (!tracked.has(id)) locateAttempts.delete(id);
		}

		const found = collectSubagents(tracked, now);
		const agentFacts = advanceSubagentTails(found);
		const settled = settleSubagents(found, agentFacts);
		const shown = newestPerSession(settled);
		const shells = collectShells(tracked, shown, agentFacts, now);
		const subagents = [...shown.map(({ subagent }) => subagent), ...shells];
		const workflows = runningWorkflows(settled, (id) => {
			const item = tracked.get(id);
			return item?.entry ? (item.tail?.facts ?? null) : null;
		});
		const subagentShells = shells.filter(
			(shell) => shell.parentAgentId !== null,
		);
		const watched = new Set([
			...[...settled.map(({ subagent }) => subagent), ...subagentShells]
				.filter((subagent) => subagent.live)
				.map((subagent) => subagent.sessionId),
			...workflows.map((workflow) => workflow.sessionId),
		]);
		const agentTokens = subagentTokensBySession(found, agentFacts);
		const sessions = [
			...[...tracked.values()].map((item) =>
				toSession(
					item,
					claudeHome,
					inCmux,
					watched.has(item.id),
					agentTokens.get(item.id) ?? [],
				),
			),
			...clouds.map((cs) => toCloudSession(cs, cloudTails.get(cs.id) ?? null)),
		].sort((a, b) => b.updatedAt - a.updatedAt);
		subagentPaths.clear();
		for (const { subagent, transcriptPath } of shown) {
			subagentPaths.set(subagent.id, transcriptPath);
		}
		const owners: Owner[] = [
			...[...tracked.values()].sort(byStartedAt).flatMap((item) =>
				item.tail
					? [
							{
								node: { kind: "session", id: item.id } as const,
								facts: item.tail.facts,
							},
						]
					: [],
			),
			...[...shown]
				.sort((a, b) => a.subagent.startedAt - b.subagent.startedAt)
				.flatMap(({ subagent, transcriptPath }) => {
					const facts = agentFacts.get(transcriptPath);
					return facts
						? [{ node: { kind: "subagent", id: subagent.id } as const, facts }]
						: [];
				}),
			...clouds.flatMap((cs) => {
				const tail = cloudTails.get(cs.id);
				return tail
					? [
							{
								node: { kind: "session", id: cs.id } as const,
								facts: tail.facts,
							},
						]
					: [];
			}),
		];
		return {
			sessions,
			subagents,
			subagentCounts: subagentCountsBySession(
				settled.map(({ subagent }) => subagent),
			),
			subagentStates: outstandingStates(
				settled.map(({ subagent }) => subagent),
			),
			workflowRuns: workflowRunsOf(settled),
			workflows,
			links: collectLinks(
				owners,
				shortsToSessions(jobs, registry),
				tracked,
				subagents,
			),
			messages: collectMessages(owners).filter(
				(message) =>
					onBoard(message.from, sessions, subagents) &&
					onBoard(message.to, sessions, subagents),
			),
			generatedAt: now,
		};
	}

	function advanceSubagentTails(
		found: FoundSubagent[],
	): Map<string, TranscriptFacts> {
		const paths = new Set(found.map(({ transcriptPath }) => transcriptPath));
		for (const path of agentTails.keys()) {
			if (!paths.has(path)) agentTails.delete(path);
		}
		const facts = new Map<string, TranscriptFacts>();
		for (const path of paths) {
			let tail = agentTails.get(path);
			if (!tail) {
				tail = createTail(path);
				agentTails.set(path, tail);
			}
			advanceTail(tail, resolve);
			facts.set(path, tail.facts);
		}
		return facts;
	}

	function collectSubagents(
		tracked: Map<string, Tracked>,
		now: number,
	): FoundSubagent[] {
		return [...tracked.values()].flatMap((item) => {
			const projects = join(item.home, "projects");
			const slug = projectSlug(item.entry?.cwd ?? item.job?.cwd ?? "");
			const dirs = new Set<string>();
			if (item.tail) {
				dirs.add(join(dirname(item.tail.path), item.id, "subagents"));
			}
			if (slug) dirs.add(join(projects, slug, item.id, "subagents"));
			const seen = new Map<string, FoundSubagent>();
			for (const dir of dirs) {
				for (const found of scanSubagents({
					dir,
					sessionId: item.id,
					finishedTasks: item.tail?.facts.finishedTasks ?? new Set(),
					now,
					cache: metaCache,
				})) {
					seen.set(found.subagent.id, found);
				}
			}
			const agents = [...seen.values()];
			return item.entry ? agents : agents.map(abandoned);
		});
	}

	let current = safeBuild() ?? emptyBoard();
	let currentKey = boardKey(current);
	let timer: NodeJS.Timeout | null = null;

	function safeBuild(): Board | null {
		try {
			return build();
		} catch (error) {
			console.error("kanban ingest: board rebuild failed", error);
			return null;
		}
	}

	function refresh() {
		timer = null;
		const next = safeBuild();
		if (!next) return;
		const key = boardKey(next);
		if (key === currentKey) return;
		current = next;
		currentKey = key;
		onChange(next);
	}

	function schedule() {
		timer ??= setTimeout(refresh, debounceMs);
	}

	const watchers = [
		watchQuietly(join(claudeHome, "sessions"), false, schedule),
		watchQuietly(join(claudeHome, "jobs"), true, schedule),
		watchQuietly(join(claudeHome, "projects"), true, schedule),
	].filter((watcher): watcher is FSWatcher => watcher !== null);
	const poll = setInterval(schedule, pollMs);

	return {
		board: () => current,
		async transcript(sessionId, limit) {
			const count = Math.max(0, Math.min(Math.floor(limit), entryLimit));
			if (count === 0) return [];
			const tail = tails.get(sessionId);
			if (tail) {
				advanceTail(tail, resolve);
				return tail.facts.entries.slice(-count);
			}
			const path =
				cloudPaths.get(sessionId) ??
				locateTranscript(claudeHome, sessionId, "");
			if (!path) return [];
			return (await readFacts(path, resolve)).entries.slice(-count);
		},
		transcriptPath(node) {
			if (node.kind === "subagent") return subagentPaths.get(node.id) ?? null;
			const session = current.sessions.find(({ id }) => id === node.id);
			if (!session) return null;
			if (session.cloud) return cloudPaths.get(node.id) ?? null;
			return (
				tails.get(node.id)?.path ??
				locateTranscript(session.configDir ?? claudeHome, node.id, session.cwd)
			);
		},
		recentCwds: () => cwds,
		block: (sessionId) => blocks.get(sessionId) ?? null,
		refresh: schedule,
		stop() {
			clearInterval(poll);
			if (timer) clearTimeout(timer);
			timer = null;
			for (const watcher of watchers) watcher.close();
		},
	};
}

function collectShells(
	tracked: Map<string, Tracked>,
	shown: FoundSubagent[],
	agentFacts: Map<string, TranscriptFacts>,
	now: number,
): Subagent[] {
	const ofSessions = [...tracked.values()].flatMap((item) =>
		item.tail
			? shellsOf(
					{
						sessionId: item.id,
						parentAgentId: null,
						facts: item.tail.facts,
						endedAt: item.entry ? null : item.tail.facts.lastAt,
					},
					now,
				)
			: [],
	);
	const ofSubagents = shown.flatMap(({ subagent, transcriptPath }) => {
		const facts = agentFacts.get(transcriptPath);
		return facts
			? shellsOf(
					{
						sessionId: subagent.sessionId,
						parentAgentId: subagent.id,
						facts,
						endedAt: subagent.done ? subagent.updatedAt : null,
					},
					now,
				)
			: [];
	});
	return [...ofSessions, ...ofSubagents];
}

function collectTracked(
	registry: Homed<RegistryEntry>[],
	jobs: Homed<Job>[],
	now: number,
): Map<string, Tracked> {
	const jobKey = (home: string, short: string) => `${home}\0${short}`;
	const jobByShort = new Map(
		jobs.map((job) => [jobKey(job.home, job.short), job]),
	);
	const tracked = new Map<string, Tracked>();
	const claimed = new Set<Homed<Job>>();
	for (const entry of [...registry].sort((a, b) => a.updatedAt - b.updatedAt)) {
		const job = entry.jobId
			? (jobByShort.get(jobKey(entry.home, entry.jobId)) ?? null)
			: null;
		if (job) claimed.add(job);
		tracked.set(entry.sessionId, {
			id: entry.sessionId,
			home: entry.home,
			entry,
			job,
			tail: null,
		});
	}
	for (const job of jobs) {
		if (claimed.has(job) || tracked.has(job.sessionId)) continue;
		if (now - job.updatedAt > stoppedJobWindowMs) continue;
		tracked.set(job.sessionId, {
			id: job.sessionId,
			home: job.home,
			entry: null,
			job,
			tail: null,
		});
	}
	return tracked;
}

function toSession(
	item: Tracked,
	claudeHome: string,
	inCmux: (pid: number) => boolean,
	watching: boolean,
	agentTokens: TokenUsage[],
): Session {
	const { entry, job, tail } = item;
	const cwd = entry?.cwd ?? job?.cwd ?? "";
	const project = basename(cwd);
	const kind = entry?.kind === "interactive" ? "interactive" : "background";
	const activity = activityOf(entry, job, watching);
	const transcriptDoing = tail?.facts.doing ?? null;
	return {
		id: item.id,
		short: entry?.jobId ?? job?.short ?? null,
		pid: entry?.pid ?? null,
		name: entry?.name || job?.name || project,
		cwd,
		project,
		kind,
		activity,
		doing:
			kind === "background"
				? (job?.detail ?? transcriptDoing)
				: transcriptDoing,
		needs:
			activity === "needs-you"
				? (job?.needs ?? entry?.waitingFor ?? null)
				: null,
		goal: goalOf(tail?.facts ?? null, job),
		startedAt: entry?.startedAt ?? job?.createdAt ?? 0,
		updatedAt: Math.max(
			entry?.updatedAt ?? 0,
			job?.updatedAt ?? 0,
			tail?.facts.lastAt ?? 0,
		),
		attachable: kind === "background" && job !== null,
		cmux: kind === "interactive" && entry !== null && inCmux(entry.pid),
		artifacts: [...(tail?.facts.artifacts.values() ?? [])].reverse(),
		tasks: [...(tail?.facts.tasks.values() ?? [])],
		steps: [...(tail?.facts.steps ?? [])],
		...tokensField(tail ? [tail.facts.tokens, ...agentTokens] : []),
		...(item.home !== claudeHome ? { configDir: item.home } : {}),
	};
}

function toCloudSession(cs: CloudSession, tail: Tail | null): Session {
	const facts = tail?.facts ?? null;
	return {
		id: cs.id,
		short: null,
		pid: null,
		name: cs.name,
		cwd: cs.cwd,
		project: basename(cs.cwd),
		kind: "background",
		activity: cs.activity,
		doing:
			cs.activity === "working" && cs.detail
				? cs.detail
				: (facts?.doing ?? null),
		needs: cs.activity === "needs-you" ? cs.detail : null,
		goal: goalOf(facts, null) ?? cs.name,
		startedAt: cs.createdAt,
		updatedAt: Math.max(cs.updatedAt, facts?.lastAt ?? 0),
		attachable: false,
		cmux: false,
		artifacts: [...(facts?.artifacts.values() ?? [])].reverse(),
		tasks: [...(facts?.tasks.values() ?? [])],
		steps: [...(facts?.steps ?? [])],
		cloud: { url: cs.url },
		...(cs.configDir ? { configDir: cs.configDir } : {}),
	};
}

function subagentTokensBySession(
	found: FoundSubagent[],
	agentFacts: Map<string, TranscriptFacts>,
): Map<string, TokenUsage[]> {
	const bySession = new Map<string, TokenUsage[]>();
	for (const { subagent, transcriptPath } of found) {
		const facts = agentFacts.get(transcriptPath);
		if (!facts) continue;
		const list = bySession.get(subagent.sessionId) ?? [];
		list.push(facts.tokens);
		bySession.set(subagent.sessionId, list);
	}
	return bySession;
}

export function sumTokens(usages: TokenUsage[]): TokenUsage {
	const total: TokenUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	for (const usage of usages) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
	}
	return total;
}

function tokensField(usages: TokenUsage[]): { tokens?: TokenUsage } {
	const tokens = sumTokens(usages);
	const total =
		tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
	return total > 0 ? { tokens } : {};
}

export function goalOf(
	facts: TranscriptFacts | null,
	job: Job | null,
): string | null {
	if (facts?.aiTitle) return facts.aiTitle;
	const prompt = firstLine(facts?.lastPrompt ?? job?.intent ?? "");
	return prompt === ""
		? null
		: truncate(prompt.replace(/\s+/g, " "), goalLength);
}

function collectLinks(
	owners: Owner[],
	sessionByShort: Map<string, string>,
	tracked: Map<string, Tracked>,
	subagents: Subagent[],
): Link[] {
	const links: Link[] = [];
	const seen = new Set<string>();
	const add = (link: Link) => {
		const key = `${link.kind}:${link.from.id}>${link.to.id}`;
		if (seen.has(key) || link.from.id === link.to.id) return;
		seen.add(key);
		links.push(link);
	};
	for (const { node, facts } of owners) {
		for (const short of facts.spawnedShorts) {
			const child = sessionByShort.get(short);
			if (child && tracked.has(child)) {
				add({
					from: node,
					to: { kind: "session", id: child },
					kind: "spawned",
				});
			}
		}
		for (const child of facts.forkedChildren) {
			if (tracked.has(child)) {
				add({ from: node, to: { kind: "session", id: child }, kind: "forked" });
			}
		}
	}
	const subagentIds = new Set(subagents.map((subagent) => subagent.id));
	for (const subagent of subagents) {
		const parent: NodeRef =
			subagent.parentAgentId && subagentIds.has(subagent.parentAgentId)
				? { kind: "subagent", id: subagent.parentAgentId }
				: { kind: "session", id: subagent.sessionId };
		add({
			from: parent,
			to: { kind: "subagent", id: subagent.id },
			kind: "subagent",
		});
	}
	return links;
}

type Edge = {
	at: number;
	summary: string;
	sender: NodeRef | null;
	recipient: NodeRef | null;
	resolvedFrom: string | null;
	resolvedTo: string | null;
};

function collectMessages(owners: Owner[]): Message[] {
	const edges = new Map<string, Edge>();
	const edgeFor = (id: string, at: number, summary: string): Edge => {
		const existing = edges.get(id);
		if (existing) return existing;
		const edge: Edge = {
			at,
			summary,
			sender: null,
			recipient: null,
			resolvedFrom: null,
			resolvedTo: null,
		};
		edges.set(id, edge);
		return edge;
	};
	const messages: Message[] = [];
	for (const { node, facts } of owners) {
		for (const [id, sent] of facts.sent) {
			const edge = edgeFor(id, sent.at, sent.summary);
			if (edge.sender) continue;
			edge.sender = node;
			edge.at = sent.at;
			edge.summary = sent.summary;
			edge.resolvedTo = sent.to;
		}
		for (const [id, received] of facts.received) {
			const edge = edgeFor(id, received.at, received.summary);
			if (edge.recipient) continue;
			edge.recipient = node;
			edge.resolvedFrom = received.from;
		}
		for (const handback of facts.handbacks) {
			messages.push({
				id: `handback:${handback.agentId}:${handback.at}`,
				from: { kind: "subagent", id: handback.agentId },
				to: node,
				at: handback.at,
				summary: handback.summary,
			});
		}
	}
	for (const [id, edge] of edges) {
		const from = edge.sender ?? sessionRef(edge.resolvedFrom);
		const to = edge.recipient ?? sessionRef(edge.resolvedTo);
		if (!from || !to) continue;
		messages.push({ id, from, to, at: edge.at, summary: edge.summary });
	}
	return messages.sort((a, b) => a.at - b.at).slice(-messageLimit);
}

function onBoard(
	ref: NodeRef,
	sessions: Session[],
	subagents: Subagent[],
): boolean {
	const nodes = ref.kind === "session" ? sessions : subagents;
	return nodes.some((node) => node.id === ref.id);
}

function sessionRef(id: string | null): NodeRef | null {
	return id ? { kind: "session", id } : null;
}

function shortsToSessions(
	jobs: Job[],
	registry: RegistryEntry[],
): Map<string, string> {
	const sessionByShort = new Map<string, string>();
	for (const job of jobs) sessionByShort.set(job.short, job.sessionId);
	for (const entry of registry) {
		if (entry.jobId) sessionByShort.set(entry.jobId, entry.sessionId);
	}
	return sessionByShort;
}

function recentCwdsOf(registry: RegistryEntry[], jobs: Job[]): string[] {
	const dated = [
		...registry.map((entry) => ({ cwd: entry.cwd, at: entry.updatedAt })),
		...jobs.map((job) => ({ cwd: job.cwd, at: job.updatedAt })),
	].sort((a, b) => b.at - a.at);
	return [...new Set(dated.map((item) => item.cwd))];
}

function byStartedAt(a: Tracked, b: Tracked): number {
	return startedAtOf(a) - startedAtOf(b);
}

function startedAtOf(item: Tracked): number {
	return item.entry?.startedAt ?? item.job?.createdAt ?? 0;
}

function boardKey(board: Board): string {
	return JSON.stringify({ ...board, generatedAt: 0 });
}

function emptyBoard(): Board {
	return {
		sessions: [],
		subagents: [],
		subagentCounts: {},
		subagentStates: {},
		workflowRuns: {},
		workflows: [],
		links: [],
		messages: [],
		generatedAt: Date.now(),
	};
}

function watchQuietly(
	path: string,
	recursive: boolean,
	listener: () => void,
): FSWatcher | null {
	try {
		const watcher = watch(path, { recursive, persistent: false }, listener);
		watcher.on("error", () => watcher.close());
		return watcher;
	} catch {
		return null;
	}
}
