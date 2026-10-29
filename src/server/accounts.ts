import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
	AccountResult,
	AccountUsage,
	Usage,
	UsageSample,
	UsageWindow,
} from "../shared/types.ts";
import { lastLine } from "./ansi.ts";
import { asNumber, asObject, asString, asTime } from "./ingest/json.ts";
import { createStateFile, readState } from "./stateFile.ts";
import { parseSamples, sampleWindowMs } from "./usage.ts";

export type Listed = Omit<AccountUsage, "samples"> & {
	fetchedAt: number | null;
};

export type AccountsView = {
	accounts: AccountUsage[];
	checkedAt: number | null;
};

export type AccountMonitor = {
	current(): AccountsView;
	check(): Promise<boolean>;
	saved(): Promise<void>;
};

export const accountsIntervalMs = 60_000;

export const cswapRoot = (
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string => {
	if (platform !== "linux") return join(homedir(), ".claude-swap-backup");
	const xdg = env.XDG_DATA_HOME?.replace(/^~(?=$|\/)/, homedir()) ?? "";
	return join(
		isAbsolute(xdg) ? xdg : join(homedir(), ".local/share"),
		"claude-swap",
	);
};

export const profileDir = (
	root: string,
	number: number,
	email: string,
): string =>
	join(
		root,
		"sessions",
		`${number}-${email.normalize("NFC").replace(/[^A-Za-z0-9._-]/gu, "_")}`,
	);

export const profileHomes = (root: string): string[] => {
	const dir = join(root, "sessions");
	try {
		return readdirSync(dir).map((name) => join(dir, name));
	} catch {
		return [];
	}
};

export const accountId = (email: string, orgUuid: string): string =>
	`${email}|${orgUuid}`;

const statusPhrases: Record<string, string> = {
	token_expired: "Sign-in expired",
	relogin_required: "Needs a fresh login",
	api_key: "API-key account",
	unavailable: "Usage unavailable",
};

const statusError = (status: string | null): string | null =>
	status === "ok"
		? null
		: (statusPhrases[status ?? ""] ??
			(status ?? "unknown").replaceAll("_", " "));

const windowOf = (value: unknown): UsageWindow | null => {
	const record = asObject(value);
	const percent = asNumber(record?.pct);
	if (percent === null) return null;
	return { percent, resetsAt: asTime(record?.resetsAt) };
};

const listedOf = (value: unknown, root: string): Listed | null => {
	const row = asObject(value);
	const number = asNumber(row?.number);
	const email = asString(row?.email);
	if (!row || number === null || !email) return null;
	const usage = asObject(row.usage) ?? asObject(row.lastGoodUsage);
	const orgUuid = asString(row.organizationUuid) ?? "";
	return {
		id: accountId(email, orgUuid),
		number,
		email,
		alias: asString(row.alias) || null,
		organization: asString(row.organizationName) ?? "",
		configDir: profileDir(root, number, email),
		isDefault: row.active === true,
		session: windowOf(usage?.fiveHour),
		week: windowOf(usage?.sevenDay),
		error: statusError(asString(row.usageStatus)),
		fetchedAt: asTime(row.usageFetchedAt ?? row.lastGoodFetchedAt),
	};
};

export const parseAccounts = (body: unknown, root: string): Listed[] | null => {
	const record = asObject(body);
	if (record?.schemaVersion !== 1 || !Array.isArray(record.accounts)) {
		return null;
	}
	return record.accounts.flatMap((row) => {
		const listed = listedOf(row, root);
		return listed ? [listed] : [];
	});
};

export const parseAccountSamples = (
	value: unknown,
): Record<string, UsageSample[]> =>
	Object.fromEntries(
		Object.entries(asObject(value) ?? {}).map(([id, samples]) => [
			id,
			parseSamples(samples),
		]),
	);

export const loadAccountSamples = (
	file: string,
): Promise<Record<string, UsageSample[]>> =>
	readState(file, parseAccountSamples);

const run = (
	bin: string,
	args: string[],
	timeout: number,
): Promise<{ failed: boolean; stdout: string; stderr: string }> =>
	new Promise((resolve) => {
		execFile(bin, args, { timeout }, (error, stdout, stderr) =>
			resolve({ failed: error !== null, stdout, stderr }),
		);
	});

export const cswapList = (bin: string) => async (): Promise<unknown | null> => {
	const { failed, stdout } = await run(bin, ["list", "--json"], 30_000);
	if (failed) return null;
	try {
		return JSON.parse(stdout);
	} catch {
		return null;
	}
};

const envelopeError = (stdout: string): string | null => {
	try {
		return asString(asObject(asObject(JSON.parse(stdout))?.error)?.message);
	} catch {
		return null;
	}
};

export const switchResult = (
	failed: boolean,
	stdout: string,
	stderr: string,
): AccountResult => {
	const error = envelopeError(stdout);
	if (!failed && !error) return { ok: true };
	return {
		ok: false,
		error: error || lastLine(`${stdout}\n${stderr}`) || "cswap switch failed",
	};
};

export const cswapSwitch =
	(bin: string) =>
	async (account: number): Promise<AccountResult> => {
		const { failed, stdout, stderr } = await run(
			bin,
			["switch", String(account), "--json"],
			60_000,
		);
		return switchResult(failed, stdout, stderr);
	};

const withSample = (
	samples: UsageSample[],
	{ session, week, fetchedAt }: Listed,
): UsageSample[] =>
	session && week && fetchedAt !== null && fetchedAt > (samples.at(-1)?.at ?? 0)
		? [
				...samples,
				{ at: fetchedAt, session: session.percent, week: week.percent },
			]
		: samples;

export const createAccountMonitor = ({
	file,
	initial,
	list,
	root,
	now,
	onChange,
}: {
	file: string;
	initial: Record<string, UsageSample[]>;
	list: () => Promise<unknown | null>;
	root: string;
	now: () => number;
	onChange: () => void;
}): AccountMonitor => {
	const stored = createStateFile<Record<string, UsageSample[]>>(file);
	let history = initial;
	let view: AccountsView = { accounts: [], checkedAt: null };

	return {
		current: () => view,
		async check() {
			const listed = parseAccounts(await list(), root);
			if (!listed) {
				if (view.accounts.length) {
					view = { accounts: [], checkedAt: view.checkedAt };
					onChange();
				}
				return false;
			}
			const cutoff = now() - sampleWindowMs;
			const updated = { ...history };
			for (const account of listed) {
				updated[account.id] = withSample(updated[account.id] ?? [], account);
			}
			history = Object.fromEntries(
				Object.entries(updated).flatMap(([id, samples]) => {
					const recent = samples.filter((sample) => sample.at > cutoff);
					return recent.length ? [[id, recent]] : [];
				}),
			);
			stored.write(history);
			view = {
				accounts: listed.map(({ fetchedAt: _, ...account }) => ({
					...account,
					samples: history[account.id] ?? [],
				})),
				checkedAt: now(),
			};
			onChange();
			return defaultOf(view) !== null;
		},
		saved: stored.saved,
	};
};

export const defaultOf = (view: AccountsView): AccountUsage | null =>
	view.accounts.find((account) => account.isDefault) ?? null;

export const withAccounts = (usage: Usage, view: AccountsView): Usage => {
	const chosen = defaultOf(view);
	if (!chosen) return { ...usage, accounts: view.accounts };
	return {
		...usage,
		session: chosen.session,
		week: chosen.week,
		samples: chosen.samples,
		error: chosen.error,
		checkedAt: view.checkedAt,
		accounts: view.accounts,
	};
};

export const claudeEnv = (configDir?: string): NodeJS.ProcessEnv =>
	configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env;
