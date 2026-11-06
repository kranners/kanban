import { open } from "node:fs/promises";
import {
	type ButlerEdgeEnd,
	type ButlerEdgeMessage,
	type ButlerEdgeSummary,
	discordIdPattern,
} from "../shared/types.ts";
import { createStateFile, readState } from "./stateFile.ts";

// Messages between Butler's Discord threads and the board's sessions: a
// desk say from one thread to another, as the daemon reports it, and the
// prompts and first prompts Butler's threads sent sessions through the
// board. The board draws each pair as a dotted link with a count; the
// words stay here, apart from the feed, the snapshot and every agent tool,
// and only the page's edge view serves them.

/** One message an edge keeps. */
export type EdgeMessage = { at: number; text: string };

export type MessageEdge = ButlerEdgeSummary & { messages: EdgeMessage[] };

/** Where an edge came from: the daemon's thread cards file, or the board's own tools. */
export type EdgeSource = "daemon" | "board";

export type StoredEdges = Record<EdgeSource, MessageEdge[]>;

export const keptEdgeMessages = 5;
export const maxEdgeText = 600;
export const maxEdges = 200;
export const maxDaemonEdges = 200;
export const edgeKeptMs = 24 * 60 * 60_000;
const maxVia = 40;

const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const endKey = (end: ButlerEdgeEnd) => `${end.kind}:${end.id}`;

/** An end as the page names it, `thread:<discord id>` or `session:<id>`, or null. */
export const parseEndKey = (value: string | null): ButlerEdgeEnd | null => {
	if (!value) return null;
	const [kind, id] = [
		value.slice(0, value.indexOf(":")),
		value.slice(value.indexOf(":") + 1),
	];
	if (kind === "thread" && discordIdPattern.test(id)) return { kind, id };
	if (kind === "session" && sessionIdPattern.test(id)) return { kind, id };
	return null;
};

const parseEnd = (value: unknown): ButlerEdgeEnd | null => {
	if (!isFields(value)) return null;
	const { kind, id } = value;
	if (typeof id !== "string") return null;
	if (kind === "thread" && discordIdPattern.test(id)) return { kind, id };
	if (kind === "session" && sessionIdPattern.test(id)) return { kind, id };
	return null;
};

const oneLine = (value: string, max: number) =>
	value.replace(/\s+/g, " ").trim().slice(0, max);

const clipText = (text: string) => text.trim().slice(0, maxEdgeText);

const parseMessages = (value: unknown, userOnly: boolean): EdgeMessage[] =>
	Array.isArray(value)
		? value
				.flatMap((raw) => {
					if (!isFields(raw)) return [];
					const { at, text, kind } = raw;
					if (!isTime(at) || typeof text !== "string") return [];
					if (userOnly && kind !== "user") return [];
					const clipped = clipText(text);
					return clipped ? [{ at, text: clipped }] : [];
				})
				.sort((a, b) => a.at - b.at)
				.slice(-keptEdgeMessages)
		: [];

const parseVia = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const via = oneLine(value, maxVia);
	return via === "" ? null : via;
};

/**
 * One edge of the daemon's thread cards file, thread to thread, or null:
 * `{from, to, via, count, lastAt, messages: [{at, kind: "user", text}]}`.
 */
export const parseDaemonEdge = (value: unknown): MessageEdge | null => {
	if (!isFields(value)) return null;
	const { from, to, via, count, lastAt, messages } = value;
	if (typeof from !== "string" || !discordIdPattern.test(from)) return null;
	if (typeof to !== "string" || !discordIdPattern.test(to)) return null;
	if (from === to) return null;
	const how = parseVia(via);
	if (!how) return null;
	if (
		typeof count !== "number" ||
		!Number.isInteger(count) ||
		count < 1 ||
		count > 1_000_000
	) {
		return null;
	}
	if (!isTime(lastAt)) return null;
	if (messages !== undefined && !Array.isArray(messages)) return null;
	return {
		from: { kind: "thread", id: from },
		to: { kind: "thread", id: to },
		via: how,
		count,
		lastAt,
		messages: parseMessages(messages, true),
	};
};

/** The daemon's `edges`, each checked; an error when it is not a list the board takes. */
export const parseDaemonEdges = (
	value: unknown,
): MessageEdge[] | { error: string } => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > maxDaemonEdges) {
		return { error: `edges must be a list of at most ${maxDaemonEdges}` };
	}
	return value.flatMap((raw) => parseDaemonEdge(raw) ?? []);
};

const parseStoredEdge = (value: unknown): MessageEdge | null => {
	if (!isFields(value)) return null;
	const from = parseEnd(value.from);
	const to = parseEnd(value.to);
	const via = parseVia(value.via);
	const { count, lastAt } = value;
	if (!from || !to || !via || !isTime(lastAt)) return null;
	if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
		return null;
	}
	return {
		from,
		to,
		via,
		count,
		lastAt,
		messages: parseMessages(value.messages, false),
	};
};

export const parseStoredEdges = (value: unknown): StoredEdges => {
	const fields = isFields(value) ? value : {};
	const list = (raw: unknown) =>
		Array.isArray(raw)
			? raw.flatMap((e) => parseStoredEdge(e) ?? []).slice(-maxEdges)
			: [];
	return { daemon: list(fields.daemon), board: list(fields.board) };
};

export const loadEdges = (file: string): Promise<StoredEdges> =>
	readState(file, parseStoredEdges);

const edgeKey = (edge: Pick<MessageEdge, "from" | "to" | "via">) =>
	`${endKey(edge.from)}>${endKey(edge.to)}|${edge.via}`;

export type EdgeRecord = {
	from: ButlerEdgeEnd;
	to: ButlerEdgeEnd;
	via: string;
	text: string;
	at: number;
};

export type MessageEdgeStore = {
	/** Every edge of the last day, without its words, for the feed. */
	summaries(): ButlerEdgeSummary[];
	/** The words of every edge from one end to the other, oldest first. */
	messages(from: ButlerEdgeEnd, to: ButlerEdgeEnd): ButlerEdgeMessage[];
	/** Replaces the daemon's edges with its latest sync. */
	syncDaemon(edges: MessageEdge[]): void;
	/** Counts one message the board itself saw go. */
	record(entry: EdgeRecord): void;
	/** Seeds edges from earlier records, each edge only when the store holds none for it yet. */
	seed(entries: EdgeRecord[]): number;
	saved(): Promise<void>;
};

export const createMessageEdgeStore = (options: {
	file?: string;
	initial?: StoredEdges;
	now?: () => number;
	onChange?: (edges: ButlerEdgeSummary[]) => void;
}): MessageEdgeStore => {
	const now = options.now ?? Date.now;
	let edges: StoredEdges = options.initial ?? { daemon: [], board: [] };
	const stored = options.file
		? createStateFile<StoredEdges>(options.file)
		: null;

	const fresh = (list: MessageEdge[]) =>
		list.filter((edge) => now() - edge.lastAt < edgeKeptMs);

	const summaries = (): ButlerEdgeSummary[] =>
		[...fresh(edges.daemon), ...fresh(edges.board)]
			.sort((a, b) => a.lastAt - b.lastAt)
			.map(({ from, to, via, count, lastAt }) => ({
				from,
				to,
				via,
				count,
				lastAt,
			}));

	const set = (next: StoredEdges) => {
		const pruned = {
			daemon: fresh(next.daemon).slice(-maxDaemonEdges),
			board: fresh(next.board)
				.sort((a, b) => a.lastAt - b.lastAt)
				.slice(-maxEdges),
		};
		if (JSON.stringify(pruned) === JSON.stringify(edges)) return;
		edges = pruned;
		stored?.write(edges);
		options.onChange?.(summaries());
	};

	const added = (
		list: MessageEdge[],
		entry: EdgeRecord,
	): MessageEdge[] | null => {
		const text = clipText(entry.text);
		if (!parseEnd(entry.from) || !parseEnd(entry.to)) return null;
		const via = parseVia(entry.via);
		if (!via || !isTime(entry.at)) return null;
		const key = edgeKey({ ...entry, via });
		const existing = list.find((edge) => edgeKey(edge) === key);
		const message = text ? [{ at: entry.at, text }] : [];
		const edge: MessageEdge = existing
			? {
					...existing,
					count: existing.count + 1,
					lastAt: Math.max(existing.lastAt, entry.at),
					messages: [...existing.messages, ...message]
						.sort((a, b) => a.at - b.at)
						.slice(-keptEdgeMessages),
				}
			: {
					from: entry.from,
					to: entry.to,
					via,
					count: 1,
					lastAt: entry.at,
					messages: message,
				};
		return [...list.filter((e) => edgeKey(e) !== key), edge];
	};

	return {
		summaries,
		messages(from, to) {
			const a = endKey(from);
			const b = endKey(to);
			return [...fresh(edges.daemon), ...fresh(edges.board)]
				.filter((edge) => endKey(edge.from) === a && endKey(edge.to) === b)
				.flatMap((edge) =>
					edge.messages.map((m) => ({ at: m.at, via: edge.via, text: m.text })),
				)
				.sort((x, y) => x.at - y.at);
		},
		syncDaemon(next) {
			set({ ...edges, daemon: next });
		},
		record(entry) {
			const board = added(edges.board, entry);
			if (board) set({ ...edges, board });
		},
		seed(entries) {
			const held = new Set(edges.board.map(edgeKey));
			let board = edges.board;
			let seeded = 0;
			for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
				if (now() - entry.at >= edgeKeptMs) continue;
				const via = parseVia(entry.via);
				if (!via || held.has(edgeKey({ ...entry, via }))) continue;
				const next = added(board, entry);
				if (!next) continue;
				board = next;
				seeded += 1;
			}
			if (seeded > 0) set({ ...edges, board });
			return seeded;
		},
		saved: () => stored?.saved() ?? Promise.resolve(),
	};
};

/** How much of the audit log's end a backfill reads. */
export const backfillBytes = 8 * 1024 * 1024;

const cloudStarted = /\(cloud session (session_[A-Za-z0-9]+)\)/;
const localStarted = /\(short id ([A-Za-z0-9_-]{1,64})\)/;

/**
 * The edges in the board's audit log: each send_prompt and start_session
 * a Butler thread asked for, which the board audits with that thread as
 * its `parent`. Lines it cannot read are skipped.
 */
export const edgesFromAudit = (text: string): EdgeRecord[] =>
	text.split("\n").flatMap((line) => {
		if (!line.startsWith("{")) return [];
		let entry: Fields;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isFields(parsed)) return [];
			entry = parsed;
		} catch {
			return [];
		}
		if (entry.action !== "board-agent") return [];
		const { parent, tool, target, input, result } = entry;
		if (typeof parent !== "string" || !discordIdPattern.test(parent)) {
			return [];
		}
		const at = typeof entry.at === "string" ? Date.parse(entry.at) : NaN;
		if (!Number.isFinite(at) || typeof result !== "string") return [];
		if (result.startsWith("error:")) return [];
		const text = typeof input === "string" ? input : "";
		const from = { kind: "thread" as const, id: parent };
		if (tool === "send_prompt" && typeof target === "string") {
			if (!sessionIdPattern.test(target)) return [];
			return [
				{ from, to: { kind: "session", id: target }, via: "prompt", text, at },
			];
		}
		if (tool === "start_session") {
			const id = (cloudStarted.exec(result) ?? localStarted.exec(result))?.[1];
			return id
				? [{ from, to: { kind: "session", id }, via: "start", text, at }]
				: [];
		}
		return [];
	});

/** The end of the audit log, from its first whole line, or nothing when it cannot be read. */
export const readAuditTail = async (
	file: string,
	bytes = backfillBytes,
): Promise<string> => {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(file, "r");
		const { size } = await handle.stat();
		const start = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const text = buffer.toString("utf8");
		return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
	} catch {
		return "";
	} finally {
		await handle?.close();
	}
};
