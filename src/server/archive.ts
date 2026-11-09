import {
	type ArchiveEntry,
	type ArchiveKind,
	type ArchiveListing,
	type ArchiveOutcome,
	archiveKinds,
	archiveOutcomes,
	type ButlerCard,
	type ButlerThreadEvent,
	type Session,
} from "../shared/types.ts";
import { parseAnnotation, parseCardMachines } from "./annotations.ts";
import { parseThreadEvent } from "./butlerThreads.ts";
import { createStateFile, readState } from "./stateFile.ts";

// The board's archive: every card of Butler's whose work is over, and
// every board session once it has left the board, kept with what it was,
// when it ran, who asked and how it ended, for the sidebar's Archive view.
// It lives in `archive.json` in the board's state, written atomically
// like the rest, so spike's backups carry it. Nothing but the page reads
// it: board_snapshot, the agent's tools, the audit and digests never do.

/** How long after a card's work finished it goes to the archive on its own. */
export const archiveGraceMs = 30 * 60_000;
/** How long an entry keeps its report, links, log and card before it is compacted to a summary. */
export const archiveKeptMs = 90 * 24 * 60 * 60_000;
/** A session gone from the board this long has ended, not dropped out for a moment. */
export const sessionGoneMs = 10 * 60_000;
export const maxArchived = 5000;
const maxListed = 500;
const maxReport = 4000;
const maxLine = 300;

const line = (text: string, max = maxLine) =>
	text.replace(/\s+/g, " ").trim().slice(0, max);

/** The archive's kind for one of Butler's cards. */
export const kindOfCard = (card: ButlerCard): ArchiveKind => {
	if (card.selfFix && !card.thread) return "change";
	if (card.thread?.kind === "desk" || card.desk) return "desk";
	if (card.thread?.kind === "job" || card.thread?.kind === "scheduled") {
		return "job";
	}
	return "conversation";
};

/** When a card's work finished: the feed's word, else when its timeline last entered its state. */
export const finishedOf = (card: ButlerCard): number => {
	if (card.finishedAt !== undefined) return card.finishedAt;
	const history = card.history ?? [];
	let at = card.updatedAt;
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (!entry || entry.state !== card.state) break;
		at = entry.at;
	}
	return at;
};

export const outcomeOf = (card: ButlerCard): ArchiveOutcome => {
	if (card.outcome) return card.outcome;
	if (card.state === "failed") return "failed";
	// Closed before its work was done: something else took its place.
	if (card.state !== "done") return "superseded";
	// A change Aaron archived or marked done before it finished.
	if (card.selfFix && /^(archive|dismissed)/i.test(card.status ?? "")) {
		const finished = (card.history ?? []).some((h) =>
			/^finished/i.test(h.status ?? ""),
		);
		return finished ? "done" : "superseded";
	}
	return "done";
};

/**
 * Why a card may not go to the archive on its own, or null once it may:
 * only finished work, 30 minutes on, never anything needing Aaron,
 * working, idle with open work, failed (until he closes it) or pinned.
 */
export const keepsOnBoard = (card: ButlerCard, now: number): string | null => {
	if (card.pinned) return "pinned";
	if (card.state !== "done") return card.state;
	if (now - finishedOf(card) < archiveGraceMs) return "finished lately";
	return null;
};

export type CardContext = {
	project: string;
	parent?: { id: string; title: string };
	log?: ButlerThreadEvent[];
	cloudLink?: string;
};

/** The archive's entry for one of Butler's cards. */
export const entryOfCard = (
	card: ButlerCard,
	context: CardContext,
	reason: ArchiveEntry["reason"],
	now: number,
): ArchiveEntry => {
	const lastReply = [...(context.log ?? [])]
		.reverse()
		.find((e) => e.kind === "reply")?.text;
	const report = card.summary ?? lastReply;
	return {
		id: card.id,
		kind: kindOfCard(card),
		title: card.title,
		...(card.status ? { task: line(card.status) } : {}),
		project: context.project,
		...(card.startedAt !== undefined
			? { startedAt: card.startedAt }
			: card.history?.[0]
				? { startedAt: card.history[0].at }
				: {}),
		finishedAt:
			card.state === "done" || card.state === "failed" ? finishedOf(card) : now,
		archivedAt: now,
		outcome: outcomeOf(card),
		reason,
		...(context.parent ? { parent: context.parent } : {}),
		...(report ? { report: report.slice(0, maxReport) } : {}),
		...(card.thread?.link ? { discord: card.thread.link } : {}),
		...(card.link && !card.thread ? { session: card.link } : {}),
		...(context.cloudLink ? { session: context.cloudLink } : {}),
		...(card.machines?.length ? { machines: card.machines } : {}),
		...(context.log?.length ? { log: context.log } : {}),
		card,
	};
};

const folderOf = (cwd: string) =>
	cwd.replace(/\/+$/, "").split("/").pop() || cwd;

/** The archive's entry for a board session that has left the board. */
export const entryOfSession = (
	session: Session,
	gone: number,
	now: number,
): ArchiveEntry => ({
	id: `session:${session.id}`,
	kind: "session",
	title: session.name,
	...(session.goal || session.doing
		? { task: line(session.goal ?? session.doing ?? "") }
		: {}),
	project: folderOf(session.cwd),
	startedAt: session.startedAt,
	finishedAt: Math.min(gone, Math.max(session.updatedAt, session.startedAt)),
	archivedAt: now,
	outcome: session.activity === "failed" ? "failed" : "done",
	reason: "left",
	...(session.parent
		? {
				parent: {
					id: session.parent.card,
					title: session.parent.title ?? "Butler thread",
				},
			}
		: {}),
	...(session.doing ? { report: line(session.doing, maxReport) } : {}),
	...(session.cloud ? { session: session.cloud.url } : {}),
	...(session.runner ? { machines: [session.runner.name] } : {}),
});

/** Past 90 days an entry keeps only its summary line's fields. */
export const compact = (entry: ArchiveEntry, now: number): ArchiveEntry => {
	if (entry.compacted || now - entry.archivedAt < archiveKeptMs) return entry;
	const {
		report: _report,
		log: _log,
		card: _card,
		machines: _machines,
		discord: _discord,
		session: _session,
		...kept
	} = entry;
	return { ...kept, compacted: true };
};

const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

const text = (value: unknown, max: number): string | undefined =>
	typeof value === "string" && value.trim() !== ""
		? value.slice(0, max)
		: undefined;

const isLink = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length <= 500 &&
	/^https:\/\/[^\s]+$/.test(value);

/** One stored entry, checked, or null to drop it. */
export const parseArchiveEntry = (value: unknown): ArchiveEntry | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const f = value as Record<string, unknown>;
	if (typeof f.id !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(f.id)) {
		return null;
	}
	if (!archiveKinds.includes(f.kind as ArchiveKind)) return null;
	if (!archiveOutcomes.includes(f.outcome as ArchiveOutcome)) return null;
	const title = text(f.title, 200);
	const project = text(f.project, 200);
	if (!title || !project) return null;
	if (!isTime(f.finishedAt) || !isTime(f.archivedAt)) return null;
	const reason =
		f.reason === "auto" || f.reason === "closed" || f.reason === "left"
			? f.reason
			: "auto";
	const parent = f.parent as Record<string, unknown> | undefined;
	const machines =
		f.machines === undefined ? undefined : parseCardMachines(f.machines);
	const card =
		f.card === undefined ? undefined : parseAnnotation(String(f.id), f.card);
	const log = Array.isArray(f.log)
		? f.log.flatMap((e) => parseThreadEvent(e) ?? [])
		: [];
	return {
		id: f.id,
		kind: f.kind as ArchiveKind,
		title,
		...(text(f.task, maxLine) ? { task: text(f.task, maxLine) } : {}),
		project,
		...(isTime(f.startedAt) ? { startedAt: f.startedAt } : {}),
		finishedAt: f.finishedAt,
		archivedAt: f.archivedAt,
		outcome: f.outcome as ArchiveOutcome,
		reason,
		...(parent &&
		typeof parent.id === "string" &&
		typeof parent.title === "string"
			? {
					parent: {
						id: parent.id.slice(0, 160),
						title: parent.title.slice(0, 200),
					},
				}
			: {}),
		...(text(f.report, maxReport) ? { report: text(f.report, maxReport) } : {}),
		...(isLink(f.discord) ? { discord: f.discord } : {}),
		...(isLink(f.session) ? { session: f.session } : {}),
		...(machines ? { machines } : {}),
		...(log.length ? { log } : {}),
		...(card && !("error" in card) && card.kind === "butler-card"
			? { card }
			: {}),
		...(f.compacted === true ? { compacted: true as const } : {}),
	};
};

type Stored = { entries: ArchiveEntry[] };

export const parseArchive = (value: unknown): ArchiveEntry[] => {
	const entries = (value as Stored | null)?.entries;
	if (!Array.isArray(entries)) return [];
	const seen = new Set<string>();
	return entries
		.flatMap((raw) => {
			const entry = parseArchiveEntry(raw);
			if (!entry || seen.has(entry.id)) return [];
			seen.add(entry.id);
			return [entry];
		})
		.slice(-maxArchived);
};

export const loadArchive = (file: string): Promise<ArchiveEntry[]> =>
	readState(file, parseArchive);

export type ArchiveQuery = {
	q?: string;
	kind?: ArchiveKind;
	project?: string;
	outcome?: ArchiveOutcome;
	from?: number;
	to?: number;
};

/** The query string's filters, the unknown ones dropped. */
export const parseArchiveQuery = (url: URL): ArchiveQuery => {
	const p = url.searchParams;
	const time = (name: string) => {
		const raw = p.get(name);
		if (!raw) return undefined;
		const value = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
		return Number.isFinite(value) ? value : undefined;
	};
	const kind = p.get("kind");
	const outcome = p.get("outcome");
	const from = time("from");
	const to = time("to");
	return {
		...(p.get("q") ? { q: (p.get("q") as string).slice(0, 200) } : {}),
		...(archiveKinds.includes(kind as ArchiveKind)
			? { kind: kind as ArchiveKind }
			: {}),
		...(p.get("project")
			? { project: (p.get("project") as string).slice(0, 200) }
			: {}),
		...(archiveOutcomes.includes(outcome as ArchiveOutcome)
			? { outcome: outcome as ArchiveOutcome }
			: {}),
		...(from !== undefined ? { from } : {}),
		...(to !== undefined ? { to } : {}),
	};
};

/** The day an entry finished, in the board's own time zone. */
export const dayOf = (at: number): string => {
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const listArchive = (
	entries: readonly ArchiveEntry[],
	query: ArchiveQuery,
): ArchiveListing => {
	const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	const matched = entries
		.filter(
			(e) =>
				(!query.kind || e.kind === query.kind) &&
				(!query.project || e.project === query.project) &&
				(!query.outcome || e.outcome === query.outcome) &&
				(query.from === undefined || e.finishedAt >= query.from) &&
				(query.to === undefined || e.finishedAt <= query.to) &&
				words.every((w) =>
					[e.title, e.task, e.project, e.report, e.parent?.title]
						.join(" ")
						.toLowerCase()
						.includes(w),
				),
		)
		.sort((a, b) => b.finishedAt - a.finishedAt || a.id.localeCompare(b.id));
	const days = new Map<string, number>();
	for (const e of matched) {
		const day = dayOf(e.finishedAt);
		days.set(day, (days.get(day) ?? 0) + 1);
	}
	return {
		entries: matched.slice(0, maxListed),
		total: matched.length,
		days: [...days].map(([day, count]) => ({ day, count })),
		projects: [...new Set(entries.map((e) => e.project))].sort(),
	};
};

export type ArchiveStore = {
	current(): readonly ArchiveEntry[];
	get(id: string): ArchiveEntry | undefined;
	/** Keeps an entry, replacing one of the same id. */
	add(entry: ArchiveEntry): void;
	remove(id: string): ArchiveEntry | undefined;
	list(query: ArchiveQuery): ArchiveListing;
	/** Archives the board sessions that have been gone from the board for 10 minutes. */
	observe(sessions: readonly Session[]): number;
	saved(): Promise<void>;
};

export const createArchiveStore = (options: {
	file?: string;
	initial?: ArchiveEntry[];
	now?: () => number;
}): ArchiveStore => {
	const now = options.now ?? Date.now;
	let entries = (options.initial ?? []).map((e) => compact(e, now()));
	const stored = options.file ? createStateFile<Stored>(options.file) : null;
	const save = () => stored?.write({ entries });
	const live = new Map<string, Session>();
	const goneSince = new Map<string, number>();

	const add = (entry: ArchiveEntry) => {
		entries = [...entries.filter((e) => e.id !== entry.id), entry]
			.map((e) => compact(e, now()))
			.slice(-maxArchived);
		save();
	};

	return {
		current: () => entries,
		get: (id) => entries.find((e) => e.id === id),
		add,
		remove(id) {
			const found = entries.find((e) => e.id === id);
			if (!found) return undefined;
			entries = entries.filter((e) => e.id !== id);
			save();
			return found;
		},
		list: (query) => listArchive(entries, query),
		observe(sessions) {
			const at = now();
			const here = new Set(sessions.map((s) => s.id));
			for (const session of sessions) {
				live.set(session.id, session);
				goneSince.delete(session.id);
			}
			let archived = 0;
			for (const [id, session] of live) {
				if (here.has(id)) continue;
				const since = goneSince.get(id) ?? at;
				goneSince.set(id, since);
				if (at - since < sessionGoneMs) continue;
				live.delete(id);
				goneSince.delete(id);
				add(entryOfSession(session, since, at));
				archived += 1;
			}
			return archived;
		},
		saved: () => stored?.saved() ?? Promise.resolve(),
	};
};
