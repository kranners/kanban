import {
	parseReportedSubagents,
	type ReportedSubagent,
} from "./reportedSubagents.ts";
import {
	type Activity,
	type ArchiveOutcome,
	activityOrder,
	archiveOutcomes,
	type ButlerCard,
	type ButlerCardMission,
	type ButlerMood,
	type ButlerThreadApproval,
	type ButlerThreadEvent,
	type ButlerThreadEventKind,
	type ButlerThreadKind,
	butlerMoods,
	butlerThreadEventKinds,
	butlerThreadKinds,
	discordIdPattern,
	machinePattern,
	maxButlerTitle,
	maxCardMachines,
	maxMissionCovers,
	maxThreadApprovalBody,
	maxThreadApprovals,
	maxThreadEvents,
	maxThreadEventText,
	missionIdPattern,
} from "./types.ts";

// One entry of the daemon's thread cards file and the Butler card it makes:
// the board's server reads the file through it, and the card sheet draws a
// thread's card from the same entry, so both say the same of a thread.

type Fields = Record<string, unknown>;

export const threadCardPrefix = "thread-";
export const threadCardId = (thread: string) => `${threadCardPrefix}${thread}`;

export const oneLine = (value: string, max: number) =>
	value.replace(/\s+/g, " ").trim().slice(0, max);

export const isTime = (value: unknown): value is number =>
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

export const outcomeField = (value: unknown): { outcome?: ArchiveOutcome } =>
	archiveOutcomes.includes(value as ArchiveOutcome)
		? { outcome: value as ArchiveOutcome }
		: {};

export const isDiscordLink = (value: unknown): value is string => {
	if (typeof value !== "string" || value.length > 500) return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			(url.hostname === "discord.com" || url.hostname.endsWith(".discord.com"))
		);
	} catch {
		return false;
	}
};

/** A thread card's mission: its id and one line of what it covers, or null when it is not one. */
export const parseCardMission = (value: unknown): ButlerCardMission | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const { id, covers } = value as Record<string, unknown>;
	if (typeof id !== "string" || !missionIdPattern.test(id)) return null;
	if (typeof covers !== "string" || covers.length > maxMissionCovers) {
		return null;
	}
	return { id, covers };
};

/** A thread card's engine: one short line of letters, digits and `·`, or null when it is not one. */
export const parseCardEngine = (value: unknown): string | null =>
	typeof value === "string" &&
	/^[\p{L}\p{N}][\p{L}\p{N} ·._-]{0,39}$/u.test(value)
		? value
		: null;

/** A thread card's machines: distinct host names, at most maxCardMachines, or null when they are not. */
export const parseCardMachines = (value: unknown): string[] | null => {
	if (!Array.isArray(value) || value.length > maxCardMachines) return null;
	if (!value.every((m) => typeof m === "string" && machinePattern.test(m))) {
		return null;
	}
	return [...new Set(value as string[])];
};

const deskIdPattern = /^[A-Za-z0-9-]{1,40}$/;
const boardThreadPattern = /^[A-Za-z0-9-]{1,64}$/;
/** One entry of the daemon's thread cards file, checked and clipped, or null to drop it. */
export type ThreadEntry = {
	id: string;
	title: string;
	kind: ButlerThreadKind;
	state: Activity;
	status: string;
	link: string;
	createdAt: number;
	lastActiveAt: number;
	endedAt?: number;
	/** When its work finished and how, as the daemon says. */
	finishedAt?: number;
	outcome?: ArchiveOutcome;
	parent?: string;
	desk?: { id: string; task: string; state: string };
	boardThread?: string;
	mission?: ButlerCardMission;
	machines?: string[];
	/** What its latest turn ran on, as the daemon names it. */
	engine?: string;
	subagents?: ReportedSubagent[];
	/** The daemon's question to Aaron there has waited over 6 hours with nothing since. */
	stale?: boolean;
	private: boolean;
	/** The mood the daemon reads in Butler's latest reply there. */
	mood?: ButlerMood;
	events: ButlerThreadEvent[];
	approvals: ButlerThreadApproval[];
};

/** A thread's mission as the daemon sends it, its covers line folded and clipped; nothing when there is none. */
const threadMission = (raw: unknown): { mission?: ButlerCardMission } => {
	if (typeof raw !== "object" || raw === null) return {};
	const covers = (raw as Fields).covers;
	const mission = parseCardMission({
		id: (raw as Fields).id,
		covers: typeof covers === "string" ? oneLine(covers, maxMissionCovers) : "",
	});
	return mission ? { mission } : {};
};

/** The machines a thread drove, the valid names alone, at most maxCardMachines. */
const threadMachines = (raw: unknown): { machines?: string[] } => {
	if (!Array.isArray(raw)) return {};
	const named = raw
		.filter((m): m is string => typeof m === "string" && machinePattern.test(m))
		.slice(0, maxCardMachines);
	const machines = parseCardMachines(named);
	return machines && machines.length > 0 ? { machines } : {};
};

/** A thread's subagents, nothing when the list is empty or not a valid one. */
const threadSubagents = (raw: unknown): { subagents?: ReportedSubagent[] } => {
	const subagents = parseReportedSubagents(raw);
	return subagents && subagents.length > 0 ? { subagents } : {};
};

export const parseThreadEntry = (value: unknown): ThreadEntry | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const f = value as Fields;
	if (typeof f.id !== "string" || !discordIdPattern.test(f.id)) return null;
	if (typeof f.title !== "string") return null;
	const title = oneLine(f.title, maxButlerTitle);
	if (title === "") return null;
	if (!butlerThreadKinds.includes(f.kind as ButlerThreadKind)) return null;
	if (!activityOrder.includes(f.state as Activity)) return null;
	if (typeof f.status !== "string") return null;
	if (!isDiscordLink(f.link)) return null;
	if (!isTime(f.createdAt) || !isTime(f.lastActiveAt)) return null;
	if (typeof f.private !== "boolean") return null;
	const desk = f.desk as Fields | undefined;
	const listed = <T>(
		raw: unknown,
		parse: (v: unknown) => T | null,
		max: number,
	) =>
		Array.isArray(raw) ? raw.flatMap((v) => parse(v) ?? []).slice(-max) : [];
	return {
		id: f.id,
		title,
		kind: f.kind as ButlerThreadKind,
		state: f.state as Activity,
		status: oneLine(f.status, maxButlerTitle),
		link: f.link,
		createdAt: f.createdAt,
		lastActiveAt: f.lastActiveAt,
		...(isTime(f.endedAt) ? { endedAt: f.endedAt } : {}),
		...(isTime(f.finishedAt) ? { finishedAt: f.finishedAt } : {}),
		...outcomeField(f.outcome),
		...(typeof f.parent === "string" &&
		discordIdPattern.test(f.parent) &&
		f.parent !== f.id
			? { parent: f.parent }
			: {}),
		...(typeof desk === "object" &&
		desk !== null &&
		typeof desk.id === "string" &&
		deskIdPattern.test(desk.id)
			? {
					desk: {
						id: desk.id,
						task: typeof desk.task === "string" ? oneLine(desk.task, 200) : "",
						state:
							typeof desk.state === "string" ? oneLine(desk.state, 40) : "",
					},
				}
			: {}),
		...(typeof f.boardThread === "string" &&
		boardThreadPattern.test(f.boardThread)
			? { boardThread: f.boardThread }
			: {}),
		...threadMission(f.mission),
		...threadMachines(f.machines),
		...(parseCardEngine(f.engine) ? { engine: f.engine as string } : {}),
		...threadSubagents(f.subagents),
		...(f.stale === true ? { stale: true } : {}),
		private: f.private,
		...(butlerMoods.includes(f.mood as ButlerMood)
			? { mood: f.mood as ButlerMood }
			: {}),
		events: listed(f.events, parseThreadEvent, maxThreadEvents),
		approvals: listed(f.approvals, parseThreadApproval, maxThreadApprovals),
	};
};

/** When a thread's work finished and how, once it has. */
export const threadFinish = (
	entry: Pick<
		ThreadEntry,
		"state" | "endedAt" | "finishedAt" | "outcome" | "lastActiveAt"
	>,
): Pick<ButlerCard, "finishedAt" | "outcome"> => {
	if (entry.state !== "done" && entry.state !== "failed") return {};
	return {
		finishedAt: entry.finishedAt ?? entry.endedAt ?? entry.lastActiveAt,
		outcome: entry.outcome ?? (entry.state === "failed" ? "failed" : "done"),
	};
};

/** What a Butler card says of the thread an entry describes, all but where it sits and what Aaron kept on it. */
export const threadCardFields = (
	entry: ThreadEntry,
): Omit<
	ButlerCard,
	| "id"
	| "kind"
	| "x"
	| "y"
	| "w"
	| "h"
	| "z"
	| "updatedAt"
	| "pinned"
	| "movedAt"
> => ({
	title: entry.title,
	state: entry.state,
	...(entry.status ? { status: entry.status } : {}),
	link: entry.link,
	thread: {
		id: entry.id,
		kind: entry.kind,
		link: entry.link,
		private: entry.private,
	},
	...(entry.parent ? { parent: threadCardId(entry.parent) } : {}),
	...(entry.desk ? { desk: entry.desk.id } : {}),
	...(entry.boardThread ? { boardThread: entry.boardThread } : {}),
	...(entry.mission ? { mission: entry.mission } : {}),
	...(entry.machines ? { machines: entry.machines } : {}),
	...(entry.engine ? { engine: entry.engine } : {}),
	...(entry.subagents ? { subagents: entry.subagents } : {}),
	...(entry.stale ? { stale: true } : {}),
	startedAt: entry.createdAt,
	lastActiveAt: entry.lastActiveAt,
	...threadFinish(entry),
});
