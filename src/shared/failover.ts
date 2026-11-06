// Account failover: which Claude account a session should run on, and when a
// session has stopped because its account hit a usage limit. Shared by the
// board (local and cloud sessions) and the runner (its headless sessions), so
// both judge an account the same way. See docs/design.md, "Accounts and failover".
import type { AccountUsage, UsageWindow } from "./types.ts";

/** Above this percentage of either window an account counts as at its limit. */
export const limitPercent = 98;

/** How long an account cools down after a limit when cswap names no reset. */
export const fallbackCooldownMs = 60 * 60_000;

// Claude Code's own words when an account runs out, which it ends the turn
// with: "You've hit your weekly limit · resets Nov 6 at 10pm", "You've hit
// your usage limit", "Claude AI usage limit reached|1730000000", "5-hour limit
// reached ∙ resets 3pm". Matched only at the start, so a session that merely
// talks about limits is never taken for one that hit one.
const limitPattern =
	/^(?:api error:\s*)?(?:(?:you'?ve|you have) (?:hit|reached) your (?:[\w-]+ )?(?:usage )?limit\b|(?:claude (?:ai )?)?usage limit reached\b|(?:weekly|session|5-hour|opus|sonnet) limit (?:reached|hit)\b)/i;

export const isLimitText = (text: string | null | undefined): boolean =>
	typeof text === "string" && limitPattern.test(text.trim());

/** Account number to the time it may be tried again. */
export type Cooldowns = Readonly<Record<number, number>>;

const full = (window: UsageWindow | null): boolean =>
	(window?.percent ?? 0) >= limitPercent;

export const atLimit = (account: AccountUsage): boolean =>
	full(account.session) || full(account.week);

/** Why an account can't take a session now, or null when it can. */
export const unavailable = (
	account: AccountUsage,
	cooldowns: Cooldowns,
	now: number,
): string | null => {
	if (account.disabled) return "held out of rotation";
	if (account.blocked) return account.blocked;
	if (!account.session || !account.week) return "usage unknown";
	if (atLimit(account)) return "at its limit";
	const until = cooldowns[account.number];
	if (until !== undefined && until > now) return "cooling down after a limit";
	return null;
};

export const headroom = (account: AccountUsage): number =>
	Math.min(
		100 - (account.session?.percent ?? 100),
		100 - (account.week?.percent ?? 100),
	);

/**
 * The account with the most 5-hour and weekly headroom that can take a
 * session now, the default first on a tie; null when none can.
 */
export const bestAccount = (
	accounts: readonly AccountUsage[],
	cooldowns: Cooldowns,
	now: number,
	exclude: ReadonlySet<number> = new Set(),
): AccountUsage | null =>
	accounts
		.filter(
			(account) =>
				!exclude.has(account.number) &&
				unavailable(account, cooldowns, now) === null,
		)
		.sort(
			(a, b) =>
				headroom(b) - headroom(a) || Number(b.isDefault) - Number(a.isDefault),
		)[0] ?? null;

/**
 * When an account that just hit a limit may be tried again: the reset of the
 * window it filled, else of its fuller window, else an hour from now.
 */
export const cooldownUntil = (
	account: AccountUsage | null,
	now: number,
): number => {
	const windows = [account?.week ?? null, account?.session ?? null].filter(
		(window): window is UsageWindow =>
			window !== null && window.resetsAt !== null && window.resetsAt > now,
	);
	const filled = windows.filter(full);
	const pick = (filled.length ? filled : windows).sort(
		(a, b) => b.percent - a.percent,
	)[0];
	return pick?.resetsAt ?? now + fallbackCooldownMs;
};

/** The earliest time any rotating account frees up, when all are spent. */
export const nextFree = (
	accounts: readonly AccountUsage[],
	cooldowns: Cooldowns,
	now: number,
): number | null => {
	const times = accounts
		.filter((account) => !account.disabled && !account.blocked)
		.map((account) =>
			Math.max(
				cooldowns[account.number] ?? 0,
				atLimit(account) ? cooldownUntil(account, now) : 0,
			),
		)
		.filter((at) => at > now);
	return times.length ? Math.min(...times) : null;
};

export const accountName = (account: AccountUsage | null): string =>
	account ? (account.alias ?? `#${account.number}`) : "the default account";

/** The prompt a moved session gets once it resumes on its new account. */
export const continuePrompt = (from: string, to: string): string =>
	`The kanban board moved this session from Claude account ${from} to ${to} because ${from} hit its usage limit. Carry on with the task where you left off.`;

/** How every failover handover prompt begins, so the board can tell one from a prompt Aaron or Butler wrote. */
export const handoverOpening =
	"You are taking over a Claude Code session named";

/** A fresh session's first prompt, for a session that can't be resumed. */
export const handoverPrompt = (
	from: { name: string; goal: string | null; doing: string | null },
	link: string | null,
	steps: readonly string[],
): string =>
	[
		`${handoverOpening} "${from.name}" that stopped because its Claude account hit its usage limit.`,
		link ? `The earlier session: ${link}` : null,
		from.goal ? `Its goal: ${from.goal}` : null,
		steps.length
			? `Its last steps:\n${steps.map((s) => `- ${s}`).join("\n")}`
			: null,
		"Check the working tree and branch first, then carry on with the task where it left off.",
	]
		.filter(Boolean)
		.join("\n\n");

/** At most this many moves of one runner session, so a bad account can't loop it. */
export const maxRunnerMoves = 4;
