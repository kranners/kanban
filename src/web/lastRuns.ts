import { signal } from "@preact/signals";
import { useState } from "preact/hooks";
import { unavailable } from "../shared/failover.ts";
import {
	type AccountUsage,
	defaultRunsOn,
	type LastRuns,
	type RunsOn,
} from "../shared/types.ts";
import { pickableAccounts, usage } from "./usage.ts";

/** Where each project's last session from the board ran, from the server. */
export const lastRuns = signal<LastRuns>({});

/** A project starts where its last session did, else in the cloud. */
export const runsOnDefault = (runs: LastRuns, cwd: string): RunsOn =>
	runs[cwd]?.runsOn ?? defaultRunsOn;

/**
 * The project's last account, while it is still one of the accounts and can
 * take a session; one at its limit or held out gives way to the server's pick
 * of the account with the most headroom.
 */
export const accountDefault = (
	runs: LastRuns,
	cwd: string,
	accounts: readonly AccountUsage[] | null,
): number | undefined => {
	const account = runs[cwd]?.account;
	const found = accounts?.find(({ number }) => number === account);
	return found && unavailable(found, {}, Date.now()) === null
		? found.number
		: undefined;
};

/** The account picker's value: the project's last account until one is picked. */
export function useAccount(
	cwd: string,
): [number | undefined, (account: number | undefined) => void] {
	const [picked, pick] = useState<{ account: number | undefined } | null>(null);
	const accounts = pickableAccounts(usage.value)?.accounts ?? null;
	const account = picked
		? picked.account
		: accountDefault(lastRuns.value, cwd, accounts);
	return [account, (next) => pick({ account: next })];
}
