import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Subagent } from "../../shared/types.ts";
import { asObject, asString, parseJson } from "./json.ts";

export type MetaCache = Map<
	string,
	{
		type: string;
		description: string;
		parentAgentId: string | null;
		startedAt: number;
	}
>;

export type FoundSubagent = { subagent: Subagent; transcriptPath: string };

export const subagentWindowMs = 30 * 60_000;
export const subagentLiveMs = 120_000;
export const subagentLimit = 40;
const metaFile = /(?:^|\/)agent-([^/]+)\.meta\.json$/;

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
	const found: FoundSubagent[] = [];
	for (const file of files) {
		const id = metaFile.exec(file)?.[1];
		if (!id) continue;
		const metaPath = join(dir, file);
		const transcriptPath = metaPath.replace(/\.meta\.json$/, ".jsonl");
		const meta = cachedMeta(cache, metaPath);
		if (!meta) continue;
		const updatedAt = mtimeOf(transcriptPath) ?? meta.startedAt;
		if (now - updatedAt > subagentWindowMs) continue;
		found.push({
			transcriptPath,
			subagent: {
				id,
				sessionId,
				parentAgentId: meta.parentAgentId,
				type: meta.type,
				description: meta.description,
				live: !finishedTasks.has(id) && now - updatedAt <= subagentLiveMs,
				startedAt: meta.startedAt,
				updatedAt,
			},
		});
	}
	return found
		.sort((a, b) => b.subagent.updatedAt - a.subagent.updatedAt)
		.slice(0, subagentLimit);
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
