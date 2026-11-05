// Account failover on the board: new sessions start on the best cswap account,
// and a session that stopped on a usage limit moves to another account and
// carries on. See docs/design.md, "Accounts and failover".

import {
	accountName,
	bestAccount,
	type Cooldowns,
	continuePrompt,
	cooldownUntil,
	handoverPrompt,
	isLimitText,
	nextFree,
	unavailable,
} from "../shared/failover.ts";
import type {
	AccountUsage,
	Board,
	FailoverMove,
	FailoverView,
	NewSessionRequest,
	NewSessionResult,
	Session,
} from "../shared/types.ts";

/** A session moved within this long is left alone, so a slow resume never moves twice. */
export const retryMs = 10 * 60_000;
/** At most this many moves of one session a day, so a bad account can't loop it. */
export const maxMovesPerDay = 4;
const dayMs = 86_400_000;
const keepMoves = 50;

export type FailoverDeps = {
	accounts(): readonly AccountUsage[];
	now(): number;
	/** Stops a local background session, keeping its transcript to resume. */
	stop(session: Session): Promise<{ ok: boolean; output: string }>;
	launch(request: NewSessionRequest): Promise<NewSessionResult>;
	/** Raises a board notification; sessionId is the card it opens, if any. */
	notify(sessionId: string, title: string, body: string): void;
	audit(entry: Record<string, unknown>): void;
	onChange(): void;
};

export type Failover = {
	/** Picks the account a new session starts on. */
	place(request: NewSessionRequest): NewSessionRequest;
	/** Moves every session the board shows stopped on a usage limit. */
	observe(board: Board): Promise<void>;
	/** Whether a session is stopped on a usage limit, so finishing it may skip the readiness check. */
	limited(session: Session): boolean;
	view(): FailoverView;
};

export const isLimited = (session: Session): boolean =>
	session.activity !== "working" && isLimitText(session.doing);

/** The account a session runs on: the profile its config dir names, else the default login. */
export const accountOfSession = (
	session: Session,
	accounts: readonly AccountUsage[],
): AccountUsage | null =>
	session.configDir
		? (accounts.find((account) => account.configDir === session.configDir) ??
			null)
		: (accounts.find((account) => account.isDefault) ?? null);

const movable = (session: Session): "resume" | "handover" | null => {
	if (session.runner) return null; // the runner fails over on its own machine
	if (session.cloud) return "handover";
	if (session.kind === "background" && session.short !== null) return "resume";
	return null; // a terminal session belongs to its terminal
};

export const createFailover = (deps: FailoverDeps): Failover => {
	const cooldowns: Record<number, number> = {};
	const attempts = new Map<string, number[]>();
	let moves: FailoverMove[] = [];
	let allLimited: FailoverView["allLimited"] = null;
	let busy = false;

	const live = (now: number): Cooldowns => {
		for (const [number, until] of Object.entries(cooldowns)) {
			if (until <= now) delete cooldowns[Number(number)];
		}
		return cooldowns;
	};
	const rotating = () => deps.accounts().filter((a) => !a.disabled);

	const place: Failover["place"] = (request) => {
		const accounts = deps.accounts();
		if (accounts.length < 2) return request;
		const now = deps.now();
		const asked =
			request.account === undefined
				? null
				: (accounts.find((a) => a.number === request.account) ?? null);
		if (asked && unavailable(asked, live(now), now) === null) return request;
		const best = bestAccount(accounts, live(now), now);
		if (!best) return request; // nothing better: let it start and say why
		const { account: _, ...rest } = request;
		return best.isDefault ? rest : { ...rest, account: best.number };
	};

	const markAllLimited = (now: number, limited: boolean) => {
		if (!limited) {
			if (allLimited) {
				allLimited = null;
				deps.onChange();
			}
			return;
		}
		const until = nextFree(rotating(), live(now), now);
		if (allLimited) {
			if (allLimited.until !== until) {
				allLimited = { ...allLimited, until };
				deps.onChange();
			}
			return;
		}
		allLimited = { since: now, until };
		const when = until
			? ` The first frees up ${new Date(until).toLocaleString()}.`
			: "";
		deps.notify(
			"accounts",
			"Every Claude account is at its limit",
			`Sessions stopped on a limit stay where they are and move on their own once an account frees up.${when}`,
		);
		deps.audit({ action: "failover-all-limited", until });
		deps.onChange();
	};

	const moveOne = async (session: Session, now: number): Promise<boolean> => {
		const how = movable(session);
		if (!how) return false;
		const tried = (attempts.get(session.id) ?? []).filter(
			(at) => now - at < dayMs,
		);
		if (tried.some((at) => now - at < retryMs)) return false;
		if (tried.length >= maxMovesPerDay) return false;
		const accounts = deps.accounts();
		const from = accountOfSession(session, accounts);
		if (from) {
			cooldowns[from.number] = Math.max(
				cooldowns[from.number] ?? 0,
				cooldownUntil(from, now),
			);
		}
		const to = bestAccount(
			accounts,
			live(now),
			now,
			new Set(from ? [from.number] : []),
		);
		if (!to) {
			markAllLimited(now, true);
			return false;
		}
		attempts.set(session.id, [...tried, now]);
		const fromName = accountName(from);
		const toName = accountName(to);
		let result: NewSessionResult;
		if (how === "resume") {
			const stopped = await deps.stop(session);
			if (!stopped.ok) {
				deps.audit({
					action: "failover-move",
					sessionId: session.id,
					from: fromName,
					to: toName,
					result: `stop failed: ${stopped.output}`,
				});
				return false;
			}
			result = await deps.launch({
				cwd: session.cwd,
				name: session.name,
				prompt: continuePrompt(fromName, toName),
				resume: session.id,
				runsOn: "local",
				...(to.isDefault ? {} : { account: to.number }),
			});
		} else {
			result = await deps.launch({
				cwd: session.cwd,
				name: session.name,
				prompt: handoverPrompt(
					session,
					session.cloud?.url ?? null,
					session.steps.slice(-8).map((step) => step.text),
				),
				runsOn: "cloud",
				...(to.isDefault ? {} : { account: to.number }),
			});
		}
		deps.audit({
			action: "failover-move",
			sessionId: session.id,
			how,
			from: fromName,
			to: toName,
			result: result.ok ? "moved" : result.error,
		});
		if (!result.ok) {
			deps.notify(
				session.id,
				`Couldn't move ${session.name} off ${fromName}`,
				`It hit ${fromName}'s limit; starting it on ${toName} failed: ${result.error}`,
			);
			return false;
		}
		moves = [
			{
				sessionId: session.id,
				name: session.name,
				from: fromName,
				to: toName,
				at: now,
			},
			...moves,
		].slice(0, keepMoves);
		deps.notify(
			session.id,
			`${session.name}: moved from ${fromName} to ${toName} (limit)`,
			how === "resume"
				? `It hit ${fromName}'s usage limit, so the board resumed it on ${toName} and told it to carry on.`
				: `It hit ${fromName}'s usage limit, so the board started a new cloud session on ${toName} with a handover from it. The old one is kept.`,
		);
		return true;
	};

	return {
		place,
		limited: isLimited,
		async observe(board) {
			if (busy || deps.accounts().length < 2) return;
			busy = true;
			try {
				const now = deps.now();
				const stuck = board.sessions.filter(isLimited);
				let changed = false;
				for (const session of stuck) {
					if (await moveOne(session, now)) changed = true;
				}
				const anyFree = bestAccount(deps.accounts(), live(now), now) !== null;
				markAllLimited(now, !anyFree && rotating().length > 0);
				if (changed) deps.onChange();
			} finally {
				busy = false;
			}
		},
		view: () => ({
			cooldowns: { ...live(deps.now()) },
			moves,
			allLimited,
		}),
	};
};
