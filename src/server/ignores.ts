import type { ProjectIgnores, ProjectIgnoreUpdate } from "../shared/ignores.ts";
import { createStateFile, readState } from "./stateFile.ts";

export type IgnoreStore = {
	current(): ProjectIgnores;
	set(update: ProjectIgnoreUpdate): boolean;
	saved(): Promise<void>;
};

export type IgnoreStoreOptions = {
	file: string;
	initial: ProjectIgnores;
	now: () => number;
	onChange: (ignores: ProjectIgnores) => void;
};

export const maxIgnores = 200;
export const longestIgnoreMs = 31 * 24 * 60 * 60 * 1000;
const maxCwdLength = 4096;

const isCwd = (value: unknown): value is string =>
	typeof value === "string" &&
	value.startsWith("/") &&
	value.length <= maxCwdLength &&
	!value.includes("\0");

const isUntil = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const parseIgnoreUpdate = (
	body: unknown,
	now: number,
): ProjectIgnoreUpdate | { error: string } => {
	if (typeof body !== "object" || body === null) {
		return { error: "Expected a JSON object with cwd and until" };
	}
	const { cwd, until } = body as Record<string, unknown>;
	if (!isCwd(cwd)) return { error: "cwd must be an absolute path" };
	if (until !== null && !isUntil(until)) {
		return { error: "until must be a time in milliseconds or null" };
	}
	if (until !== null && until > now + longestIgnoreMs) {
		return { error: "A project can be ignored for at most 31 days" };
	}
	return { cwd, until };
};

const unexpired = (ignores: ProjectIgnores, now: number): ProjectIgnores =>
	Object.fromEntries(
		Object.entries(ignores).filter(([, until]) => until > now),
	);

export const parseIgnores = (value: unknown): ProjectIgnores => {
	if (typeof value !== "object" || value === null) return {};
	return Object.fromEntries(
		Object.entries(value)
			.filter(([cwd, until]) => isCwd(cwd) && isUntil(until))
			.slice(0, maxIgnores),
	);
};

export const loadIgnores = (file: string): Promise<ProjectIgnores> =>
	readState(file, parseIgnores);

export const createIgnoreStore = ({
	file,
	initial,
	now,
	onChange,
}: IgnoreStoreOptions): IgnoreStore => {
	let ignores = unexpired(initial, now());
	const stored = createStateFile<ProjectIgnores>(file);

	return {
		current: () => ignores,
		set({ cwd, until }) {
			const { [cwd]: _, ...rest } = unexpired(ignores, now());
			const ignoring = until !== null && until > now();
			if (ignoring && Object.keys(rest).length >= maxIgnores) return false;
			ignores = ignoring ? { ...rest, [cwd]: until } : rest;
			stored.write(ignores);
			onChange(ignores);
			return true;
		},
		saved: stored.saved,
	};
};
