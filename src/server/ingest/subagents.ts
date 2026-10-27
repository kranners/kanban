import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subagent } from "../../shared/types.ts";
import { asObject, asString, parseJson } from "./json.ts";
import type { TranscriptFacts } from "./records.ts";

export type MetaCache = Map<
	string,
	{
		type: string;
		description: string;
		parentAgentId: string | null;
		startedAt: number;
		teammate: boolean;
	}
>;

export type FoundSubagent = {
	subagent: Subagent;
	transcriptPath: string;
	teammate: boolean;
	workflowRun: string | null;
};

export const subagentWindowMs = 30 * 60_000;
export const subagentLiveMs = 120_000;
export const subagentLimit = 40;
const metaFile = /(?:^|\/)agent-([^/]+)\.meta\.json$/;
const workflowRun = /(?:^|\/)workflows\/([^/]+)\/agent-[^/]+$/;

export function scanSubagents(opts: {
	dir: string;
	sessionId: string;
	finishedTasks: Set<string>;
	now: number;
	cache: MetaCache;
}): FoundSubagent[] {
	const { dir, sessionId, finishedTasks, now, cache } = opts;
	let files: string[];
	try {
		files = readdirSync(dir, { recursive: true, encoding: "utf8" });
	} catch {
		return [];
	}
	const candidates = files.flatMap((file) => {
		const id = metaFile.exec(file)?.[1];
		if (!id) return [];
		const metaPath = join(dir, file);
		const transcriptPath = metaPath.replace(/\.meta\.json$/, ".jsonl");
		const meta = cachedMeta(cache, metaPath);
		if (!meta) return [];
		const updatedAt = mtimeOf(transcriptPath) ?? meta.startedAt;
		return [{ id, file, metaPath, transcriptPath, meta, updatedAt }];
	});
	const byId = new Map(
		candidates.map((candidate) => [candidate.id, candidate]),
	);
	const kept = new Set<string>();
	for (const candidate of candidates) {
		if (now - candidate.updatedAt > subagentWindowMs) continue;
		for (
			let at: (typeof candidates)[number] | undefined = candidate;
			at && !kept.has(at.id);
			at = byId.get(at.meta.parentAgentId ?? "")
		) {
			kept.add(at.id);
		}
	}
	const found: FoundSubagent[] = [];
	const journals = new Map<string, Set<string>>();
	for (const {
		id,
		file,
		metaPath,
		transcriptPath,
		meta,
		updatedAt,
	} of candidates) {
		if (!kept.has(id)) continue;
		const done =
			returned(finishedTasks, id, file) ||
			journalFinished(journals, dirname(metaPath)).has(id);
		found.push({
			transcriptPath,
			teammate: meta.teammate,
			workflowRun: workflowRun.exec(file)?.[1] ?? null,
			subagent: {
				id,
				sessionId,
				parentAgentId: meta.parentAgentId,
				type: meta.type,
				description: meta.description,
				live: !done && now - updatedAt <= subagentLiveMs,
				done,
				startedAt: meta.startedAt,
				updatedAt,
			},
		});
	}
	return found;
}

export function settleSubagents(
	found: readonly FoundSubagent[],
	factsOf: ReadonlyMap<string, TranscriptFacts>,
): FoundSubagent[] {
	const finished = new Set(
		[...factsOf.values()].flatMap((facts) => [...facts.finishedTasks]),
	);
	return found.map((entry) => {
		const { subagent, transcriptPath, teammate } = entry;
		const waitingOnTool = (factsOf.get(transcriptPath)?.tools.size ?? 0) > 0;
		const busy = subagent.live || waitingOnTool;
		const done =
			subagent.done ||
			returned(finished, subagent.id, transcriptPath) ||
			(teammate && !busy);
		return {
			...entry,
			subagent: { ...subagent, done, live: !done && busy },
		};
	});
}

export function workflowRunsOf(
	found: readonly FoundSubagent[],
): Record<string, string[]> {
	const runs: Record<string, string[]> = {};
	for (const { subagent, workflowRun } of found) {
		if (workflowRun)
			runs[workflowRun] = [...(runs[workflowRun] ?? []), subagent.id];
	}
	return runs;
}

export function abandoned(found: FoundSubagent): FoundSubagent {
	return { ...found, subagent: { ...found.subagent, live: false, done: true } };
}

export function newestPerSession(
	found: readonly FoundSubagent[],
): FoundSubagent[] {
	const kept = new Map<string, number>();
	return [...found]
		.sort((a, b) => b.subagent.updatedAt - a.subagent.updatedAt)
		.filter(({ subagent }) => {
			const count = kept.get(subagent.sessionId) ?? 0;
			kept.set(subagent.sessionId, count + 1);
			return count < subagentLimit;
		});
}

function returned(
	finished: ReadonlySet<string>,
	id: string,
	path: string,
): boolean {
	const run = workflowRun.exec(path)?.[1];
	return finished.has(id) || (run !== undefined && finished.has(run));
}

function journalFinished(
	journals: Map<string, Set<string>>,
	dir: string,
): Set<string> {
	const known = journals.get(dir);
	if (known) return known;
	const finished = new Set<string>();
	journals.set(dir, finished);
	let text: string;
	try {
		text = readFileSync(join(dir, "journal.jsonl"), "utf8");
	} catch {
		return finished;
	}
	for (const line of text.split("\n")) {
		const record = asObject(parseJson(line));
		const agentId = asString(record?.agentId);
		if (agentId && (record?.type === "result" || record?.type === "failed")) {
			finished.add(agentId);
		}
	}
	return finished;
}

function cachedMeta(cache: MetaCache, path: string) {
	const cached = cache.get(path);
	if (cached) return cached;
	try {
		const stat = statSync(path);
		const record = asObject(parseJson(readFileSync(path, "utf8")));
		if (!record) return null;
		const meta = {
			type: asString(record.agentType) ?? "agent",
			description: asString(record.description) ?? "",
			parentAgentId: asString(record.parentAgentId),
			startedAt: Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs),
			teammate: record.taskKind === "in_process_teammate",
		};
		cache.set(path, meta);
		return meta;
	} catch {
		return null;
	}
}

function mtimeOf(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}
