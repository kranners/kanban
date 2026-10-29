import { signal } from "@preact/signals";
import type {
	AccountResult,
	AccountUsage,
	Usage,
	UsageSample,
} from "../shared/types.ts";

export const usage = signal<Usage | null>(null);

export type Severity = "normal" | "warning" | "critical";

export const severity = (percent: number): Severity =>
	percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal";

export const chartSpanMs = 7 * 86_400_000;
const gapMs = 20 * 60_000;

export type Frame = { from: number; to: number; width: number; height: number };

export const xOf = (at: number, frame: Frame): number =>
	((at - frame.from) / (frame.to - frame.from)) * frame.width;

export const yOf = (percent: number, frame: Frame): number =>
	frame.height - (Math.min(100, Math.max(0, percent)) / 100) * frame.height;

const round = (value: number) => Math.round(value * 10) / 10;

export function linePath(
	samples: readonly UsageSample[],
	series: "session" | "week",
	frame: Frame,
): string {
	let previous: number | null = null;
	const commands: string[] = [];
	for (const sample of samples) {
		if (sample.at < frame.from || sample.at > frame.to) continue;
		const move = previous === null || sample.at - previous > gapMs;
		const point = `${round(xOf(sample.at, frame))} ${round(yOf(sample[series], frame))}`;
		commands.push(move ? `M${point} h0` : `L${point}`);
		previous = sample.at;
	}
	return commands.join(" ");
}

export function nearestSample(
	samples: readonly UsageSample[],
	at: number,
	frame: Frame,
): UsageSample | null {
	let best: UsageSample | null = null;
	for (const sample of samples) {
		if (sample.at < frame.from || sample.at > frame.to) continue;
		if (!best || Math.abs(sample.at - at) < Math.abs(best.at - at)) {
			best = sample;
		}
	}
	return best;
}

export function untilReset(resetsAt: number, now: number): string {
	const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	return `${minutes}m`;
}

export const defaultAccount = (usage: Usage | null): AccountUsage | null =>
	usage?.accounts.find((account) => account.isDefault) ?? null;

export const pickableAccounts = (
	usage: Usage | null,
): { accounts: AccountUsage[]; fallback: AccountUsage } | null => {
	const fallback = defaultAccount(usage);
	return usage && fallback && usage.accounts.length > 1
		? { accounts: usage.accounts, fallback }
		: null;
};

export const accountOf = (
	configDir: string,
	accounts: readonly AccountUsage[],
): AccountUsage | null =>
	accounts.find((account) => account.configDir === configDir) ?? null;

export const accountChip = (
	configDir: string,
	accounts: readonly AccountUsage[],
): string => {
	const account = accountOf(configDir, accounts);
	if (account) return accountLabel(account);
	const slot = configDir.split("/").at(-1)?.match(/^\d+/)?.[0];
	return slot ? `#${slot}` : "#?";
};

export const accountLabel = (account: AccountUsage): string =>
	account.alias ?? `#${account.number}`;

export async function makeDefault(account: number): Promise<AccountResult> {
	try {
		const response = await fetch("/api/accounts/default", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ account }),
		});
		return (await response.json()) as AccountResult;
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}
