import {
	type ButlerMessage,
	type ButlerThreadApproval,
	type ButlerThreadEvent,
	type ButlerThreadEventKind,
	butlerThreadEventKinds,
	maxButlerQueue,
	maxThreadApprovalBody,
	maxThreadApprovals,
	maxThreadEvents,
	maxThreadEventText,
} from "../shared/types.ts";
import { maxMessage } from "./comments.ts";
import { createStateFile, readState } from "./stateFile.ts";

// What each of Butler's thread cards says happened in its Discord thread.
// Aaron's replies waiting for spike queue in the Butler inbox with every
// other message to him. It is kept here, apart from the cards themselves, so nothing that reads the
// board, board_snapshot, board_history, an agent's tools, the audit or a
// digest, ever sees a thread's words: only the page's thread view does.

/** One card's log: the daemon's events and the board's own since. */
export type ThreadLog = {
	/** The daemon's events from its last sync, oldest first. */
	events: ButlerThreadEvent[];
	/** Aaron's replies and Butler's answers the board saw itself, newer than the daemon's. */
	local: ButlerThreadEvent[];
	approvals: ButlerThreadApproval[];
};

export type ThreadLogs = Record<string, ThreadLog>;

export type ThreadLogStore = {
	get(card: string): ThreadLog | undefined;
	/** The daemon's events and approvals, oldest first, merged with the board's own. */
	shown(card: string): {
		events: ButlerThreadEvent[];
		approvals: ButlerThreadApproval[];
	};
	sync(
		card: string,
		events: ButlerThreadEvent[],
		approvals: ButlerThreadApproval[],
	): void;
	append(card: string, event: ButlerThreadEvent): void;
	remove(card: string): void;
	/** Writes the logs again, dropping what an older board kept beside them. */
	rewrite(): void;
	saved(): Promise<void>;
};

const keptLocal = maxThreadEvents;

const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A thread event as the daemon sends it, clipped, or null when it is not one. */
export const parseThreadEvent = (value: unknown): ButlerThreadEvent | null => {
	if (typeof value !== "object" || value === null) return null;
	const { at, kind, text } = value as Record<string, unknown>;
	if (!isTime(at) || typeof text !== "string") return null;
	if (!butlerThreadEventKinds.includes(kind as ButlerThreadEventKind)) {
		return null;
	}
	return {
		at,
		kind: kind as ButlerThreadEventKind,
		text: text.slice(0, maxThreadEventText),
	};
};

export const parseThreadApproval = (
	value: unknown,
): ButlerThreadApproval | null => {
	if (typeof value !== "object" || value === null) return null;
	const { at, headline, code, kind, body, critical, nonce } = value as Record<
		string,
		unknown
	>;
	if (!isTime(at) || typeof headline !== "string") return null;
	const line = headline.replace(/\s+/g, " ").trim().slice(0, 300);
	if (line === "") return null;
	const coded = typeof code === "string" && /^[A-Za-z0-9-]{1,32}$/.test(code);
	return {
		at,
		headline: line,
		...(coded ? { code } : {}),
		...(kind === "call" || kind === "desk" ? { kind } : {}),
		...(typeof body === "string" && body.trim()
			? { body: body.slice(0, maxThreadApprovalBody) }
			: {}),
		...(critical === true ? { critical: true } : {}),
		...(coded && typeof nonce === "string" && /^[0-9a-f]{32}$/.test(nonce)
			? { nonce }
			: {}),
	};
};

const listOf = <T>(
	value: unknown,
	parse: (raw: unknown) => T | null,
	max: number,
): T[] =>
	Array.isArray(value)
		? value.flatMap((raw) => parse(raw) ?? []).slice(-max)
		: [];

const parseLegacyQueued = (value: unknown): ButlerMessage[] =>
	listOf(
		value,
		(raw) => {
			const { id, at, text } = (raw ?? {}) as Record<string, unknown>;
			return typeof id === "string" &&
				/^[A-Za-z0-9-]{1,64}$/.test(id) &&
				isTime(at) &&
				typeof text === "string"
				? { id, at, text: text.slice(0, maxMessage) }
				: null;
		},
		maxButlerQueue,
	);

export const parseThreadLogs = (value: unknown): ThreadLogs => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const logs: ThreadLogs = {};
	for (const [card, raw] of Object.entries(value).slice(0, 200)) {
		if (!/^thread-[0-9]{5,25}$/.test(card)) continue;
		const fields = (raw ?? {}) as Record<string, unknown>;
		logs[card] = {
			events: listOf(fields.events, parseThreadEvent, maxThreadEvents),
			local: listOf(fields.local, parseThreadEvent, keptLocal),
			approvals: listOf(
				fields.approvals,
				parseThreadApproval,
				maxThreadApprovals,
			),
		};
	}
	return logs;
};

export const loadThreadLogs = (file: string): Promise<ThreadLogs> =>
	readState(file, parseThreadLogs);

/** Replies an older board kept in its thread logs, which now queue in the Butler inbox. */
export const legacyThreadReplies = (
	value: unknown,
): { card: string; message: ButlerMessage }[] => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return [];
	}
	return Object.entries(value)
		.filter(([card]) => /^thread-[0-9]{5,25}$/.test(card))
		.flatMap(([card, raw]) =>
			parseLegacyQueued((raw as Record<string, unknown> | null)?.queued).map(
				(message) => ({ card, message }),
			),
		)
		.slice(-maxButlerQueue);
};

export const loadLegacyThreadReplies = (file: string) =>
	readState(file, legacyThreadReplies);

const empty = (): ThreadLog => ({
	events: [],
	local: [],
	approvals: [],
});

const same = (a: ButlerThreadEvent, b: ButlerThreadEvent) =>
	a.kind === b.kind && a.text === b.text;

export const createThreadLogStore = (options: {
	/** Where the logs are kept; absent keeps them in memory only. */
	file?: string;
	initial?: ThreadLogs;
}): ThreadLogStore => {
	let logs: ThreadLogs = { ...(options.initial ?? {}) };
	const stored = options.file
		? createStateFile<ThreadLogs>(options.file)
		: null;
	const save = () => stored?.write(logs);
	const set = (card: string, log: ThreadLog) => {
		logs = { ...logs, [card]: log };
		save();
	};

	return {
		get: (card) => logs[card],
		shown(card) {
			const log = logs[card] ?? empty();
			return {
				events: [...log.events, ...log.local].sort((a, b) => a.at - b.at),
				approvals: log.approvals,
			};
		},
		sync(card, events, approvals) {
			const log = logs[card] ?? empty();
			const latest = events.reduce((max, e) => Math.max(max, e.at), 0);
			// The board's own lines stay until the daemon reports something newer, or the same words.
			const local = log.local.filter(
				(e) => e.at > latest && !events.some((d) => same(d, e)),
			);
			const next = { ...log, events, approvals, local };
			if (JSON.stringify(next) === JSON.stringify(logs[card])) return;
			set(card, next);
		},
		append(card, event) {
			const log = logs[card] ?? empty();
			set(card, { ...log, local: [...log.local, event].slice(-keptLocal) });
		},
		remove(card) {
			const log = logs[card];
			if (!log) return;
			const { [card]: _gone, ...rest } = logs;
			logs = rest;
			save();
		},
		rewrite: save,
		saved: () => stored?.saved() ?? Promise.resolve(),
	};
};
