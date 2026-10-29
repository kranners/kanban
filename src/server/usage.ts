import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage, UsageSample, UsageWindow } from "../shared/types.ts";
import { createStateFile, readState } from "./stateFile.ts";

export type UsageMonitor = {
	current(): Usage;
	check(): Promise<void>;
	saved(): Promise<void>;
};

export type UsageMonitorOptions = {
	file: string;
	initial: UsageSample[];
	token: () => Promise<string | null>;
	fetch: typeof fetch;
	now: () => number;
	onChange: (usage: Usage) => void;
};

export const usageUrl = "https://api.anthropic.com/api/oauth/usage";
export const usageIntervalMs = 5 * 60_000;
export const sampleWindowMs = 7 * 86_400_000;
const requestTimeoutMs = 15_000;

const isPercent = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const parseWindow = (value: unknown): UsageWindow | null => {
	if (typeof value !== "object" || value === null) return null;
	const { utilization, resets_at } = value as Record<string, unknown>;
	if (!isPercent(utilization)) return null;
	const resetsAt = typeof resets_at === "string" ? Date.parse(resets_at) : NaN;
	return {
		percent: utilization,
		resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
	};
};

export const parseUsageResponse = (
	body: unknown,
): Pick<Usage, "session" | "week"> | null => {
	if (typeof body !== "object" || body === null) return null;
	const { five_hour, seven_day } = body as Record<string, unknown>;
	const session = parseWindow(five_hour);
	const week = parseWindow(seven_day);
	return session || week ? { session, week } : null;
};

export const isSample = (value: unknown): value is UsageSample => {
	if (typeof value !== "object" || value === null) return false;
	const { at, session, week } = value as Record<string, unknown>;
	return isPercent(at) && isPercent(session) && isPercent(week);
};

export const parseSamples = (value: unknown): UsageSample[] =>
	Array.isArray(value) ? value.filter(isSample) : [];

export const loadUsageSamples = (file: string): Promise<UsageSample[]> =>
	readState(file, parseSamples);

const failure = (status: number): string => {
	if (status === 401 || status === 403) return "Claude Code sign-in expired";
	if (status === 429) return "Usage API rate limited";
	return `Usage API returned ${status}`;
};

export const createUsageMonitor = ({
	file,
	initial,
	token,
	fetch,
	now,
	onChange,
}: UsageMonitorOptions): UsageMonitor => {
	const stored = createStateFile<UsageSample[]>(file);
	let usage: Usage = {
		session: null,
		week: null,
		samples: initial,
		checkedAt: null,
		error: null,
		accounts: [],
	};

	const settle = (next: Partial<Usage>) => {
		usage = { ...usage, ...next, checkedAt: now() };
		onChange(usage);
	};

	const request = async (): Promise<Partial<Usage>> => {
		const bearer = await token();
		if (!bearer) return { error: "Not signed in to Claude Code" };
		const response = await fetch(usageUrl, {
			headers: {
				Authorization: `Bearer ${bearer}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: AbortSignal.timeout(requestTimeoutMs),
		});
		if (!response.ok) return { error: failure(response.status) };
		const parsed = parseUsageResponse(await response.json());
		if (!parsed) return { error: "Usage API sent an unexpected response" };
		const at = now();
		const recent = usage.samples.filter(
			(sample) => sample.at > at - sampleWindowMs,
		);
		const { session, week } = parsed;
		const samples =
			session && week
				? [...recent, { at, session: session.percent, week: week.percent }]
				: recent;
		stored.write(samples);
		return { session, week, samples, error: null };
	};

	return {
		current: () => usage,
		async check() {
			try {
				settle(await request());
			} catch {
				settle({ error: "Usage API unreachable" });
			}
		},
		saved: stored.saved,
	};
};

const credentialsOf = (text: string | null): string | null => {
	if (!text) return null;
	try {
		const token = JSON.parse(text)?.claudeAiOauth?.accessToken;
		return typeof token === "string" && token !== "" ? token : null;
	} catch {
		return null;
	}
};

export const keychainService = (claudeHome: string): string =>
	claudeHome === join(homedir(), ".claude")
		? "Claude Code-credentials"
		: `Claude Code-credentials-${createHash("sha256").update(claudeHome.normalize("NFC")).digest("hex").slice(0, 8)}`;

const keychainCredentials = (service: string): Promise<string | null> =>
	new Promise((resolve) => {
		if (process.platform !== "darwin") return resolve(null);
		execFile(
			"security",
			["find-generic-password", "-s", service, "-w"],
			{ timeout: 10_000 },
			(error, stdout) => resolve(error ? null : stdout.trim()),
		);
	});

export const claudeCodeToken =
	(claudeHome: string) => async (): Promise<string | null> =>
		credentialsOf(await keychainCredentials(keychainService(claudeHome))) ??
		credentialsOf(
			await readFile(join(claudeHome, ".credentials.json"), "utf8").catch(
				() => null,
			),
		);
