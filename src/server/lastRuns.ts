import { isRunsOn, type LastRun, type LastRuns } from "../shared/types.ts";
import { isAccountNumber } from "./sessions.ts";
import { createStateFile, readState } from "./stateFile.ts";

export type LastRunStore = {
	current(): LastRuns;
	/** Remembers where a project's session started, so the next one defaults there. */
	record(cwd: string, run: LastRun): void;
	saved(): Promise<void>;
};

export type LastRunStoreOptions = {
	file: string;
	initial: LastRuns;
	onChange: (lastRuns: LastRuns) => void;
};

export const maxLastRuns = 200;
const maxCwdLength = 4096;

const isCwd = (value: unknown): value is string =>
	typeof value === "string" &&
	value.startsWith("/") &&
	value.length <= maxCwdLength &&
	!value.includes("\0");

const parseLastRun = (value: unknown): LastRun | null => {
	if (typeof value !== "object" || value === null) return null;
	const { runsOn, account } = value as Record<string, unknown>;
	if (!isRunsOn(runsOn)) return null;
	return isAccountNumber(account) ? { runsOn, account } : { runsOn };
};

export const parseLastRuns = (value: unknown): LastRuns => {
	if (typeof value !== "object" || value === null) return {};
	const runs: LastRuns = {};
	for (const [cwd, entry] of Object.entries(value)) {
		const run = parseLastRun(entry);
		if (isCwd(cwd) && run) runs[cwd] = run;
	}
	return Object.fromEntries(Object.entries(runs).slice(-maxLastRuns));
};

export const loadLastRuns = (file: string): Promise<LastRuns> =>
	readState(file, parseLastRuns);

export const createLastRunStore = ({
	file,
	initial,
	onChange,
}: LastRunStoreOptions): LastRunStore => {
	let runs: LastRuns = { ...initial };
	const stored = createStateFile<LastRuns>(file);

	return {
		current: () => runs,
		record(cwd, run) {
			const before = runs[cwd];
			if (before?.runsOn === run.runsOn && before.account === run.account)
				return;
			const { [cwd]: _, ...rest } = runs;
			// The latest goes last, so the oldest projects fall off first.
			runs = Object.fromEntries(
				Object.entries({ ...rest, [cwd]: run }).slice(-maxLastRuns),
			);
			stored.write(runs);
			onChange(runs);
		},
		saved: stored.saved,
	};
};
