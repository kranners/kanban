import { type FSWatcher, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	Board,
	Link,
	Message,
	NodeRef,
	Session,
	Subagent,
	TranscriptEntry,
} from "../../shared/types.ts";
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
import {
	type FoundSubagent,
	type MetaCache,
	scanSubagents,
} from "./subagents.ts";
import { advanceTail, createTail, readFacts, type Tail } from "./tail.ts";

export type BoardHandle = {
	board(): Board;
	transcript(sessionId: string, limit: number): Promise<TranscriptEntry[]>;
	recentCwds(): string[];
	stop(): void;
};

type Owner = { node: NodeRef; facts: TranscriptFacts };

type Tracked = {
	id: string;
	entry: RegistryEntry | null;
	job: Job | null;
	tail: Tail | null;
};

const pollMs = 2000;
const debounceMs = 250;
const locateRetryMs = 10_000;
const stoppedJobWindowMs = 24 * 60 * 60_000;
const messageLimit = 200;

export function startBoard(opts: {
	claudeHome: string;
	onChange: (board: Board) => void;
}): BoardHandle {
	const { claudeHome, onChange } = opts;
	const tails = new Map<string, Tail>();
	const agentTails = new Map<string, Tail>();
	const locateAttempts = new Map<string, number>();
	const metaCache: MetaCache = new Map();
	const byPid = new Map<number, string>();
	const bySocket = new Map<string, string>();
	const byName = new Map<string, string>();
	let cwds: string[] = [];

	const resolve: ResolvePeer = (ref: PeerRef) =>
		(ref.pid !== undefined ? byPid.get(ref.pid) : undefined) ??
		(ref.socket !== undefined ? bySocket.get(ref.socket) : undefined) ??
		(ref.name !== undefined ? byName.get(ref.name) : undefined) ??
		null;

	function tailFor(id: string, cwd: string, now: number): Tail | null {
		const existing = tails.get(id);
		if (existing) return existing;
		if (now - (locateAttempts.get(id) ?? 0) < locateRetryMs) return null;
		locateAttempts.set(id, now);
		const path = locateTranscript(claudeHome, id, cwd);
		if (!path) return null;
		const tail = createTail(path);
		tails.set(id, tail);
		locateAttempts.delete(id);
		return tail;
	}

	function build(): Board {
		const now = Date.now();
		const registry = readRegistry(claudeHome).filter((entry) =>
			isAlive(entry.pid),
		);
		for (const entry of registry) {
			byPid.set(entry.pid, entry.sessionId);
			if (entry.socket) bySocket.set(entry.socket, entry.sessionId);
			if (entry.name) byName.set(entry.name, entry.sessionId);
		}
		const jobs = readJobs(claudeHome);
		const tracked = collectTracked(registry, jobs, now);
		cwds = recentCwdsOf(registry, jobs);

		for (const item of tracked.values()) {
			const cwd = item.entry?.cwd ?? item.job?.cwd ?? "";
			item.tail = tailFor(item.id, cwd, now);
		}
		for (const item of [...tracked.values()].sort(byStartedAt)) {
			if (item.tail) advanceTail(item.tail, resolve);
		}
		for (const id of tails.keys()) if (!tracked.has(id)) tails.delete(id);
		for (const id of locateAttempts.keys()) {
			if (!tracked.has(id)) locateAttempts.delete(id);
		}

		const sessions = [...tracked.values()]
			.map(toSession)
			.sort((a, b) => b.updatedAt - a.updatedAt);
		const found = collectSubagents(tracked, now);
		const subagents = found.map(({ subagent }) => subagent);
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
			...trackSubagentTails(found),
		];
		return {
			sessions,
			subagents,
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

	function trackSubagentTails(found: FoundSubagent[]): Owner[] {
		const paths = new Set(found.map(({ transcriptPath }) => transcriptPath));
		for (const path of agentTails.keys()) {
			if (!paths.has(path)) agentTails.delete(path);
		}
		return [...found]
			.sort((a, b) => a.subagent.startedAt - b.subagent.startedAt)
			.map(({ subagent, transcriptPath }) => {
				let tail = agentTails.get(transcriptPath);
				if (!tail) {
					tail = createTail(transcriptPath);
					agentTails.set(transcriptPath, tail);
				}
				advanceTail(tail, resolve);
				return {
					node: { kind: "subagent", id: subagent.id } as const,
					facts: tail.facts,
				};
			});
	}

	function collectSubagents(
		tracked: Map<string, Tracked>,
		now: number,
	): FoundSubagent[] {
		const projects = join(claudeHome, "projects");
		return [...tracked.values()].flatMap((item) => {
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
			return [...seen.values()];
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
			const path = locateTranscript(claudeHome, sessionId, "");
			if (!path) return [];
			return (await readFacts(path, resolve)).entries.slice(-count);
		},
		recentCwds: () => cwds,
		stop() {
			clearInterval(poll);
			if (timer) clearTimeout(timer);
			timer = null;
			for (const watcher of watchers) watcher.close();
		},
	};
}

function collectTracked(
	registry: RegistryEntry[],
	jobs: Job[],
	now: number,
): Map<string, Tracked> {
	const jobByShort = new Map(jobs.map((job) => [job.short, job]));
	const tracked = new Map<string, Tracked>();
	const claimedShorts = new Set<string>();
	for (const entry of [...registry].sort((a, b) => a.updatedAt - b.updatedAt)) {
		const job = entry.jobId ? (jobByShort.get(entry.jobId) ?? null) : null;
		if (job) claimedShorts.add(job.short);
		tracked.set(entry.sessionId, {
			id: entry.sessionId,
			entry,
			job,
			tail: null,
		});
	}
	for (const job of jobs) {
		if (claimedShorts.has(job.short) || tracked.has(job.sessionId)) continue;
		if (now - job.updatedAt > stoppedJobWindowMs) continue;
		tracked.set(job.sessionId, {
			id: job.sessionId,
			entry: null,
			job,
			tail: null,
		});
	}
	return tracked;
}

function toSession(item: Tracked): Session {
	const { entry, job, tail } = item;
	const cwd = entry?.cwd ?? job?.cwd ?? "";
	const project = basename(cwd);
	const kind = entry?.kind === "interactive" ? "interactive" : "background";
	const activity = activityOf(entry, job);
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
		needs: activity === "needs-you" ? (job?.needs ?? null) : null,
		startedAt: entry?.startedAt ?? job?.createdAt ?? 0,
		updatedAt: Math.max(
			entry?.updatedAt ?? 0,
			job?.updatedAt ?? 0,
			tail?.facts.lastAt ?? 0,
		),
		attachable: kind === "background" && job !== null,
	};
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
