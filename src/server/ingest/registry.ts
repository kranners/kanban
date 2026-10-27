import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Activity } from "../../shared/types.ts";
import { asNumber, asObject, asString, asTime, parseJson } from "./json.ts";

export type RegistryEntry = {
	pid: number;
	sessionId: string;
	cwd: string;
	kind: "interactive" | "bg";
	jobId: string | null;
	name: string | null;
	status: string | null;
	waitingFor: string | null;
	socket: string | null;
	startedAt: number;
	updatedAt: number;
};

export type Job = {
	short: string;
	sessionId: string;
	cwd: string;
	name: string | null;
	state: string | null;
	tempo: string | null;
	detail: string | null;
	needs: string | null;
	intent: string | null;
	createdAt: number;
	updatedAt: number;
};

const registryFile = /^\d+\.json$/;
const jobDir = /^[0-9a-f]{8}$/;

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readRegistry(claudeHome: string): RegistryEntry[] {
	const dir = join(claudeHome, "sessions");
	return listDir(dir)
		.filter((file) => registryFile.test(file))
		.flatMap((file) => {
			const entry = toRegistryEntry(readJson(join(dir, file)));
			return entry ? [entry] : [];
		});
}

export function readJobs(claudeHome: string): Job[] {
	const dir = join(claudeHome, "jobs");
	return listDir(dir)
		.filter((name) => jobDir.test(name))
		.flatMap((short) => {
			const job = toJob(short, readJson(join(dir, short, "state.json")));
			return job ? [job] : [];
		});
}

export function activityOf(
	entry: RegistryEntry | null,
	job: Job | null,
): Activity {
	const state = job?.state ?? null;
	if (!entry) {
		if (state === "failed" || state === "crashed") return "failed";
		if (state === "done") return "done";
		return "stopped";
	}
	if (entry.status === "busy") return "working";
	if (entry.status === "waiting") return "needs-you";
	switch (state) {
		case null:
			return "idle";
		case "blocked":
			return "needs-you";
		case "done":
			return "done";
		case "failed":
		case "crashed":
			return "failed";
		case "stopped":
			return "idle";
		default:
			if (entry.status !== "idle" && entry.status !== "shell") return "working";
			return job?.tempo === "blocked" ? "needs-you" : "idle";
	}
}

function toRegistryEntry(value: unknown): RegistryEntry | null {
	const record = asObject(value);
	if (!record) return null;
	const pid = asNumber(record.pid);
	const sessionId = asString(record.sessionId);
	const cwd = asString(record.cwd);
	const kind = record.kind;
	if (pid === null || !sessionId || !cwd) return null;
	if (kind !== "interactive" && kind !== "bg") return null;
	const startedAt = asTime(record.startedAt) ?? 0;
	return {
		pid,
		sessionId,
		cwd,
		kind,
		jobId: asString(record.jobId),
		name: asString(record.name),
		status: asString(record.status),
		waitingFor: asString(record.waitingFor) || null,
		socket: asString(record.messagingSocketPath),
		startedAt,
		updatedAt: Math.max(
			startedAt,
			asTime(record.updatedAt) ?? 0,
			asTime(record.statusUpdatedAt) ?? 0,
		),
	};
}

function toJob(short: string, value: unknown): Job | null {
	const record = asObject(value);
	if (!record) return null;
	const sessionId = asString(record.sessionId);
	const cwd = asString(record.cwd);
	if (!sessionId || !cwd) return null;
	const createdAt = asTime(record.createdAt) ?? 0;
	return {
		short,
		sessionId,
		cwd,
		name: asString(record.name),
		state: asString(record.state),
		tempo: asString(record.tempo),
		detail: asString(record.detail) || null,
		needs: asString(record.needs) || null,
		intent: asString(record.intent) || null,
		createdAt,
		updatedAt: asTime(record.updatedAt) ?? createdAt,
	};
}

function listDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function readJson(path: string): unknown {
	try {
		return parseJson(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
