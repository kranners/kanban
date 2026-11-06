import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { parseToolCall, type ToolCall } from "../agent/tools.ts";
import { handoverOpening } from "../shared/failover.ts";
import {
	type AaronFocus,
	type Annotation,
	type ArchiveEntry,
	type ArchiveOutcome,
	aaronFocusStaleMs,
	archiveOutcomes,
	type Board,
	type BoardContext,
	type BoardRect,
	type ButlerApprovalPress,
	type ButlerCard,
	type ButlerCardEvent,
	type ButlerCardMission,
	type ButlerCardState,
	type ButlerDm,
	type ButlerMood,
	type ButlerPresence,
	type ButlerSpot,
	type ButlerThreadApproval,
	type ButlerThreadEvent,
	type ButlerThreadKind,
	type ButlerThreadView,
	type ButlerWaitingApproval,
	butlerCardStates,
	butlerMoods,
	butlerThreadKinds,
	type CommentThread,
	discordIdPattern,
	type FocusReport,
	machinePattern,
	maxButlerHistory,
	maxButlerQueue,
	maxButlerSummary,
	maxButlerTitle,
	maxCardMachines,
	maxMissionCovers,
	maxNoteText,
	maxThreadApprovals,
	maxThreadEvents,
	maxThreadEventText,
	type Note,
	type NoteColor,
	noteColors,
	type Point,
	type Region,
} from "../shared/types.ts";
import { snap } from "../web/grid.ts";
import { nodeKey } from "../web/layout.ts";
import {
	butlerBylineHeight,
	clearOf,
	noteSizeFor,
	topZ,
} from "../web/notes.ts";
import type { Rect } from "../web/placement.ts";
import {
	type AnnotationStore,
	parseAnnotation,
	parseCardMachines,
	parseCardMission,
} from "./annotations.ts";
import {
	type ArchiveStore,
	type CardContext,
	entryOfCard,
	keepsOnBoard,
} from "./archive.ts";
import type { Audit } from "./audit.ts";
import {
	arranged,
	type BoardToolDeps,
	type BoardTools,
	findSession,
	occupied,
	type ToolOutcome,
} from "./boardTools.ts";
import {
	type ButlerInbox,
	createButlerInbox,
	type InboxMessage,
	type Refused,
} from "./butlerInbox.ts";
import {
	createThreadLogStore,
	parseThreadApproval,
	parseThreadEvent,
	type ThreadLogStore,
} from "./butlerThreads.ts";
import type { CloudRecord } from "./cloud.ts";
import { type CommentStore, parseRect } from "./comments.ts";
import type { BoardSource } from "./http.ts";
import { fromLoopback } from "./loopback.ts";
import { createStateFile, readState } from "./stateFile.ts";
import { isTidyRegion, planTidy, tidyTopics, topicOf } from "./tidy.ts";

// Butler, Aaron's assistant bot on spike, reaches the board over ssh and
// curl on the Mac's loopback. He gets the board agent's own tools under
// his own name, plus his cards, notes, presence and the sessions he
// watches. Which of those need Aaron's say-so is decided on spike, by the
// rules of the command that calls this, as for his other tools.
//
// He sees what Aaron is working on: the board's page reports the session
// Aaron has open and the part of the board on screen, and every board_inbox
// poll, board_focus and board_snapshot hands it to him. On the board his
// face shows what he is looking at and his cursor what he is working on;
// neither follows Aaron.

export const butlerIdentity = "butler";
export const maxWatching = 100;
export const maxSelfFixes = 50;
/** The most thread cards one butler_threads sync takes; the daemon sends at most 60. */
export const maxThreadCards = 80;
export const threadCardPrefix = "thread-";
/** How long a closed thread card stays closed after the daemon stops listing it. */
export const dismissedKeptMs = 2 * 24 * 60 * 60_000;
export const threadCardId = (thread: string) => `${threadCardPrefix}${thread}`;
/** A reply from a thread card goes to spike as a message of this board thread. */
export const cardReplyThread = (thread: string) => `card-${thread}`;

/** At most this many approvals from the board in any window, as the daemon also holds them to. */
export const maxPresses = 30;
export const pressWindowMs = 10 * 60_000;

/** A press of Approve or Decline, as spike's relay hands it to the daemon. */
/** A press refused, with the status the page gets. */
export type ApprovalRefused = { error: string; status: 400 | 404 | 409 | 429 };

type ApprovalPressMessage = InboxMessage & {
	approval: {
		code: string;
		nonce: string;
		decision: "approve" | "decline";
		held?: true;
		device?: string;
		bulk?: true;
	};
};
export const selfFixPattern = /^[0-9]{8}-[0-9]{6}-[0-9]+$/;

const cardSize = { w: 312, h: 216 };
const gap = 48;
const noteColor: NoteColor = "blue";

/** The board agent's tools that only read a session: Butler looks at it rather than works on it. */
const readingTools = new Set<ToolCall["tool"]>([
	"ask_session",
	"read_transcript",
]);

/** At most this many cards listed as on Aaron's screen. */
export const maxOnScreen = 20;

/** Tools that act through a session: never Butler's own cards or notes. */
export const sessionTools = new Set<ToolCall["tool"]>([
	"ask_session",
	"send_prompt",
	"announce",
	"answer_prompt",
	"approve_safe_prompts",
	"finish_session",
	"start_session",
]);

/**
 * What Aaron, or Butler on his word, did to a self-fix's card on the
 * board: closing it archives the fix's cloud session, marking it done
 * stops spike reporting it as needing him. Spike reads these back from
 * each self_fixes sync and acts on them; moving a card is never one.
 */
export type SelfFixAction = "archive" | "dismiss";
export const selfFixActions: readonly SelfFixAction[] = ["archive", "dismiss"];

export type Butler = {
	current(): ButlerPresence;
	tool(name: string, body: unknown): Promise<ToolOutcome>;
	/** Records an action Aaron took on a self-fix's card from the board. */
	selfFixAction(fixId: string, action: SelfFixAction): ToolOutcome;
	/** Aaron's messages to Butler, when the board keeps comments. */
	inbox: ButlerInbox | null;
	/** What a page of the board says Aaron has in front of him. */
	focus(report: FocusReport): void;
	/** What Aaron is working on, or null while no page has told the board lately. */
	aaron(): AaronFocus | null;
	/** A thread card's whole view for the page, or null when there is no such card. */
	threadView(thread: string): ButlerThreadView | null;
	/** Queues Aaron's reply from a thread card for spike to post in that Discord thread. */
	sendToThread(thread: string, text: string): { ok: true } | Refused;
	/** Every request waiting on Aaron on Butler's thread cards, oldest first, without their nonces. */
	approvalsWaiting(): ButlerWaitingApproval[];
	/**
	 * Aaron's press of Approve or Decline on a thread card's request, queued
	 * for spike with the nonce the daemon issued for it, which only the board
	 * holds. The caller has checked the press came from his signed-in page.
	 */
	answerApproval(
		thread: string,
		code: string,
		decision: "approve" | "decline",
		options: { held?: boolean; device?: string; bulk?: boolean },
	): { ok: true; text: string } | ApprovalRefused;
	/** Approves every request that lists nothing critical, and says what it left. */
	approveAllSafe(device?: string): {
		approved: ButlerWaitingApproval[];
		left: (ButlerWaitingApproval & { why: string })[];
	};
	/** Starts a Butler job: a / thread whose first message is flagged as a job. */
	startJob(draft: {
		x: number;
		y: number;
		text: string;
		viewport?: BoardRect;
	}): CommentThread | Refused;
	/** Aaron deleting a thread card: it stays off the board until the thread is active again. */
	closeThreadCard(cardId: string): ToolOutcome;
	/** Archives finished cards and lays out the rest; `sessions` also re-lays out the sessions Aaron has not pinned. */
	tidy(options?: { sessions?: boolean }): ToolOutcome;
	/** Puts an archived card back on the board, pinned where it lands. */
	restore(id: string): ToolOutcome;
	/** Forgets what Aaron was working on once his pages have gone quiet. */
	check(): void;
	saved(): Promise<void>;
};

type ButlerState = {
	watching: string[];
	selfFixActions: Record<string, SelfFixAction>;
	watchedFixes: string[];
	/** Thread cards Aaron closed, by Discord thread id, and when. */
	dismissedThreads: Record<string, number>;
};

/** What the board knows of its cloud sessions, for the orphan report. */
export type CloudOverview = {
	records: Pick<CloudRecord, "prompt" | "parent">[];
	reachable: boolean | null;
};

export type ButlerDeps = Pick<
	BoardToolDeps,
	"layout" | "annotations" | "regions"
> & {
	source: BoardSource;
	annotations: AnnotationStore;
	tools: BoardTools;
	audit: Audit;
	file: string;
	initial: string[];
	initialActions?: Record<string, SelfFixAction>;
	initialWatchedFixes?: string[];
	initialDismissedThreads?: Record<string, number>;
	/** Where thread cards' events and approvals are kept, never in the annotations. */
	threads?: ThreadLogStore;
	/** The board's cloud sessions, for the orphan report butler_threads returns. */
	cloud?: () => CloudOverview;
	onChange: (presence: ButlerPresence) => void;
	/** Where Aaron's messages to Butler are kept, in their comment threads. */
	comments?: CommentStore;
	/** Where cards go once their work is over; absent keeps no archive. */
	archive?: ArchiveStore;
	/** Runs the tidy pass a little after a burst of syncs; absent tidies only when asked. */
	schedule?: (run: () => void, ms: number) => void;
	newId?: () => string;
	now?: () => number;
};

/** How long after a sync the board waits for more before it tidies. */
export const tidyDebounceMs = 5000;

export const parseWatching = (value: unknown): string[] => {
	const list =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as { watching?: unknown }).watching
			: null;
	if (!Array.isArray(list)) return [];
	return list
		.filter((id): id is string => typeof id === "string" && id.length <= 128)
		.slice(0, maxWatching);
};

export const loadWatching = (file: string): Promise<string[]> =>
	readState(file, parseWatching);

const parseFixIds = (value: unknown): string[] =>
	Array.isArray(value)
		? value
				.filter(
					(id): id is string =>
						typeof id === "string" && selfFixPattern.test(id),
				)
				.slice(0, maxSelfFixes)
		: [];

export const parseSelfFixActions = (
	value: unknown,
): Record<string, SelfFixAction> => {
	const raw =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as { selfFixActions?: unknown }).selfFixActions
			: null;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const actions: Record<string, SelfFixAction> = {};
	for (const [id, action] of Object.entries(raw).slice(0, maxSelfFixes)) {
		if (
			selfFixPattern.test(id) &&
			selfFixActions.includes(action as SelfFixAction)
		) {
			actions[id] = action as SelfFixAction;
		}
	}
	return actions;
};

export const parseDismissedThreads = (
	value: unknown,
): Record<string, number> => {
	const raw =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as { dismissedThreads?: unknown }).dismissedThreads
			: null;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	return Object.fromEntries(
		Object.entries(raw)
			.filter(
				([id, at]) =>
					discordIdPattern.test(id) &&
					typeof at === "number" &&
					Number.isFinite(at),
			)
			.slice(0, 200),
	) as Record<string, number>;
};

/** Everything butler.json keeps, for createButler's initial state. */
export const loadButlerState = (file: string) =>
	readState(file, (value) => ({
		initial: parseWatching(value),
		initialActions: parseSelfFixActions(value),
		initialDismissedThreads: parseDismissedThreads(value),
		initialWatchedFixes: parseFixIds(
			typeof value === "object" && value !== null
				? (value as { watchedFixes?: unknown }).watchedFixes
				: null,
		),
	}));

const clientPattern = /^[A-Za-z0-9-]{1,64}$/;

/** A page's report of what Aaron has in front of him, or why it is not one. */
export const parseFocusReport = (
	body: unknown,
): FocusReport | { error: string } => {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { error: "Expected a JSON object" };
	}
	const { client, session, viewport, away } = body as Record<string, unknown>;
	if (typeof client !== "string" || !clientPattern.test(client)) {
		return { error: "client must be the page's id" };
	}
	if (away === true) return { client, away: true };
	if (
		session !== undefined &&
		(typeof session !== "string" || session.length > 128)
	) {
		return { error: "session must be a session id" };
	}
	const rect = viewport === undefined ? undefined : parseRect(viewport);
	if (rect === null) {
		return { error: "viewport must be x, y, w and h board coordinates" };
	}
	return {
		client,
		...(session === undefined ? {} : { session: session as string }),
		...(rect === undefined ? {} : { viewport: rect }),
	};
};

/** Butler's calls come only from a process on this Mac, never a page. */
export const butlerAllowed = (req: IncomingMessage): boolean =>
	fromLoopback(req) && req.headers.origin === undefined;

const done = (text: string): ToolOutcome => ({ ok: true, text });
const refused = (error: string): Refusal => ({ ok: false, error });

type Fields = Record<string, unknown>;

const text = (
	fields: Fields,
	key: string,
	max: number,
	required = false,
): string | undefined | Refusal => {
	const value = fields[key];
	if (value === undefined || value === null) {
		return required ? refused(`${key} is required`) : undefined;
	}
	if (typeof value !== "string" || value.length > max) {
		return refused(`${key} must be a string of at most ${max} characters`);
	}
	return value;
};

type Refusal = { ok: false; error: string };

const isOutcome = (value: unknown): value is Refusal =>
	typeof value === "object" && value !== null && "ok" in value;

const only = (fields: Fields, allowed: string[]): ToolOutcome | null => {
	const unknown = Object.keys(fields).find((key) => !allowed.includes(key));
	return unknown ? refused(`Unknown argument ${unknown}`) : null;
};

const number = (fields: Fields, key: string): number | undefined => {
	const value = fields[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
};

/** Folds a self-fix's free-text state, from `self-fix list`, into a card state. */
export const selfFixState = (state: string): ButlerCardState => {
	const s = state.toLowerCase();
	if (s.startsWith("waiting on input")) return "needs-you";
	if (s.startsWith("finished with an error") || s.startsWith("failed"))
		return "failed";
	if (
		s.startsWith("finished") ||
		s.startsWith("archive") ||
		s.startsWith("dismissed")
	)
		return "done";
	if (s === "running" || s.startsWith("still starting")) return "working";
	return "idle";
};

export const selfFixCardId = (id: string) => `self-fix-${id}`;

/** A self-fix id stands for its card wherever a tool takes a card id. */
const cardRef = (ref: string) =>
	selfFixPattern.test(ref) ? selfFixCardId(ref) : ref;

const dismissedStatus = (status: string): string =>
	status.startsWith("dismissed")
		? status
		: `dismissed on the board; ${status}`.slice(0, maxButlerTitle);

const eventOf = (
	card: Pick<ButlerCard, "state" | "status">,
	at: number,
): ButlerCardEvent => ({
	at,
	state: card.state,
	...(card.status === undefined ? {} : { status: card.status }),
});

/**
 * The card's timeline once it is saved: what it had before (a card spike
 * rebuilds each sync carries none of its own), and a new entry whenever its
 * state or status line changed. A card from before timelines starts from
 * its last update.
 */
export const withHistory = (
	before: ButlerCard | undefined,
	next: ButlerCard,
	at: number,
): ButlerCard => {
	const kept =
		before?.history ?? (before ? [eventOf(before, before.updatedAt)] : []);
	const last = kept.at(-1);
	const history =
		last && last.state === next.state && last.status === next.status
			? kept
			: [...kept, eventOf(next, at)].slice(-maxButlerHistory);
	return { ...next, history };
};

const sameCard = (a: ButlerCard, b: ButlerCard): boolean =>
	a.title === b.title &&
	a.state === b.state &&
	a.status === b.status &&
	a.summary === b.summary &&
	a.link === b.link &&
	a.watching === b.watching &&
	JSON.stringify(a.thread) === JSON.stringify(b.thread) &&
	a.parent === b.parent &&
	a.desk === b.desk &&
	a.boardThread === b.boardThread &&
	JSON.stringify(a.mission) === JSON.stringify(b.mission) &&
	JSON.stringify(a.machines) === JSON.stringify(b.machines) &&
	a.startedAt === b.startedAt &&
	a.finishedAt === b.finishedAt &&
	a.outcome === b.outcome;

/** A change's times and outcome as spike sends them, the valid ones alone. */
const changeTimes = (
	fix: Record<string, unknown>,
): Pick<ButlerCard, "startedAt" | "finishedAt" | "outcome"> => ({
	...(isTime(fix.startedAt) ? { startedAt: fix.startedAt } : {}),
	...(isTime(fix.finishedAt) ? { finishedAt: fix.finishedAt } : {}),
	...outcomeField(fix.outcome),
});

/** When a thread's work finished and how, once it has. */
const threadFinish = (
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

/** What a card keeps across syncs that spike knows nothing of: Aaron's pin and when he last moved it. */
const kept = (card: ButlerCard | undefined) => ({
	...(card?.pinned ? { pinned: true } : {}),
	...(card?.movedAt !== undefined ? { movedAt: card.movedAt } : {}),
});

const outcomeField = (value: unknown): { outcome?: ArchiveOutcome } =>
	archiveOutcomes.includes(value as ArchiveOutcome)
		? { outcome: value as ArchiveOutcome }
		: {};

const regionNamed = (regions: readonly Region[], name: string) =>
	regions.find(
		(r) =>
			(r.name ?? r.cwd.split("/").pop() ?? "").trim().toLowerCase() === name,
	);

const centreIn = (card: Rect, box: Rect) => {
	const x = card.x + card.w / 2;
	const y = card.y + card.h / 2;
	return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
};

const oneLine = (value: string, max: number) =>
	value.replace(/\s+/g, " ").trim().slice(0, max);

const isDiscordLink = (value: unknown): value is string => {
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

const deskIdPattern = /^[A-Za-z0-9-]{1,40}$/;
const boardThreadPattern = /^[A-Za-z0-9-]{1,64}$/;
const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** One entry of the daemon's thread cards file, checked and clipped, or null to drop it. */
export type ThreadEntry = {
	id: string;
	title: string;
	kind: ButlerThreadKind;
	state: ButlerCardState;
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
	if (!butlerCardStates.includes(f.state as ButlerCardState)) return null;
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
		state: f.state as ButlerCardState,
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
		private: f.private,
		...(butlerMoods.includes(f.mood as ButlerMood)
			? { mood: f.mood as ButlerMood }
			: {}),
		events: listed(f.events, parseThreadEvent, maxThreadEvents),
		approvals: listed(f.approvals, parseThreadApproval, maxThreadApprovals),
	};
};

/**
 * Why a cloud session on the board has no Butler thread: Butler started
 * it without a parent (its prompt carries his context), the failover
 * handed it over, or it was started on the board.
 */
export const orphanReport = (cloud: CloudOverview | undefined): string => {
	const records = cloud?.records ?? [];
	let linked = 0;
	let butler = 0;
	let failover = 0;
	let board = 0;
	for (const record of records) {
		const prompt = record.prompt ?? "";
		if (record.parent) linked += 1;
		else if (
			prompt.includes("Context pack") ||
			prompt.includes("Context from Butler")
		)
			butler += 1;
		else if (prompt.startsWith(handoverOpening)) failover += 1;
		else board += 1;
	}
	const reachable =
		cloud?.reachable === true
			? "reachable"
			: cloud?.reachable === false
				? "unreachable"
				: "unknown";
	return `Cloud sessions on the board: ${records.length}; linked to a Butler thread: ${linked}; unlinked: ${butler + failover + board} (Butler start_session without a parent: ${butler}, failover handover: ${failover}, started on the board: ${board}); cloud API: ${reachable}`;
};

export const createButler = (deps: ButlerDeps): Butler => {
	const newId = deps.newId ?? randomUUID;
	const now = deps.now ?? Date.now;
	const file = createStateFile<ButlerState>(deps.file);
	let watching = [...deps.initial];
	let actions: Record<string, SelfFixAction> = {
		...(deps.initialActions ?? {}),
	};
	let watchedFixes = new Set(deps.initialWatchedFixes ?? []);
	let dismissedThreads: Record<string, number> = {
		...(deps.initialDismissedThreads ?? {}),
	};
	const threadLogs = deps.threads ?? createThreadLogStore({});
	const persist = () =>
		file.write({
			watching,
			selfFixActions: actions,
			watchedFixes: [...watchedFixes],
			dismissedThreads,
		});
	let looking: ButlerSpot | null = null;
	let working: ButlerSpot | null = null;
	let aaron:
		| (Omit<FocusReport, "away"> & {
				target: string | null;
				at: number;
				since: number;
		  })
		| null = null;

	let inbox: ButlerInbox | null = null;
	/** The DM thread, the latest the daemon listed: drawn as Butler's face, never a card. */
	let dm: ThreadEntry | null = null;
	const dmPresence = (entry: ThreadEntry): ButlerDm => ({
		thread: entry.id,
		state: entry.state,
		status: entry.status,
		link: entry.link,
		waiting: entry.approvals.length,
		updatedAt: entry.lastActiveAt,
		...(entry.mood ? { mood: entry.mood } : {}),
	});
	const isDm = (cardId: string | undefined) =>
		dm !== null && cardId === threadCardId(dm.id);
	const current = (): ButlerPresence => {
		const relay = inbox?.relay();
		return {
			looking,
			working,
			watching,
			...(relay ? { relay } : {}),
			...(dm ? { dm: dmPresence(dm) } : {}),
		};
	};
	const changed = () => deps.onChange(current());

	const board = (): Board => deps.source.board();
	const taken = () => occupied(board(), deps);
	const annotation = (id: string) =>
		deps.annotations.current()[id] ?? deps.annotations.current()[cardRef(id)];

	/** A session's id or short id, or the id of a card or note. */
	const resolve = (
		ref: string,
	): { id: string; rect: Rect; label: string } | null => {
		const session = findSession(board(), ref);
		if (session) {
			const node = arranged(board(), deps).nodes.get(
				nodeKey({ kind: "session", id: session.id }),
			);
			return node ? { id: session.id, rect: node, label: session.name } : null;
		}
		const found = annotation(ref);
		if (!found) return null;
		const label =
			found.kind === "butler-card"
				? found.title
				: found.kind === "note"
					? "a note"
					: "a sticker";
		return { id: found.id, rect: found, label };
	};

	/** Butler's face goes to what he is reading. */
	const lookAt = (id: string, label = "Butler") => {
		looking = { target: id, label, at: now() };
		changed();
	};

	/** Butler's cursor goes to what he is changing, and his eyes with it. */
	const workOn = (id: string, label = "Butler") => {
		const at = now();
		working = { target: id, label, at };
		looking = { target: id, label, at };
		changed();
	};

	const put = (given: Annotation): ToolOutcome | null => {
		const before = deps.annotations.current()[given.id];
		const next =
			given.kind === "butler-card"
				? withHistory(
						before?.kind === "butler-card" ? before : undefined,
						given,
						now(),
					)
				: given;
		const parsed = parseAnnotation(next.id, next);
		if ("error" in parsed) return refused(parsed.error);
		const stored = deps.annotations.put(parsed);
		return "error" in stored ? refused(stored.error) : null;
	};

	/** Somewhere clear, right of everything on the board, for a new card. */
	const freshSpot = () => {
		const bounds = arranged(board(), deps).bounds;
		const empty = !Number.isFinite(bounds.width) || bounds.width <= 0;
		return {
			x: snap(empty ? 0 : bounds.x + bounds.width + gap),
			y: snap(empty ? 0 : bounds.y),
		};
	};

	const placeCard = (card: ButlerCard, fresh: boolean): ButlerCard =>
		fresh ? clearOf(card, taken()) : card;

	/**
	 * A change's id, once called a self-fix, given as `change` or, its old
	 * name, `selfFix`, which spike and Butler still send.
	 */
	const changeRef = (fields: Fields): string | undefined | Refusal =>
		text(fields, fields.change !== undefined ? "change" : "selfFix", 64);

	const putCard = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, [
			"id",
			"change",
			"selfFix",
			"title",
			"state",
			"status",
			"summary",
			"link",
			"watching",
			"x",
			"y",
			"w",
			"h",
		]);
		if (unknown) return unknown;
		const fixRef = changeRef(fields);
		if (isOutcome(fixRef)) return fixRef;
		if (fixRef !== undefined && !selfFixPattern.test(fixRef)) {
			return refused("change must be a change id");
		}
		const given = text(fields, "id", 64);
		if (isOutcome(given)) return given;
		const id =
			fixRef !== undefined
				? selfFixCardId(fixRef)
				: given === undefined
					? undefined
					: cardRef(given);
		const title = text(fields, "title", maxButlerTitle);
		const status = text(fields, "status", maxButlerTitle);
		const summary = text(fields, "summary", maxButlerSummary);
		const link = text(fields, "link", 500);
		for (const value of [id, title, status, summary, link]) {
			if (isOutcome(value)) return value;
		}
		const state = fields.state;
		if (
			state !== undefined &&
			!butlerCardStates.includes(state as ButlerCardState)
		) {
			return refused(`state must be one of ${butlerCardStates.join(", ")}`);
		}
		const existing = id ? annotation(id as string) : undefined;
		if (id && existing && existing.kind !== "butler-card") {
			return refused(`${id} is not one of Butler's cards`);
		}
		if (id && !existing && findSession(board(), id as string)) {
			return refused(
				`${id} is a session: move it with arrange and close it with finish_session`,
			);
		}
		if (existing?.kind === "butler-card" && existing.selfFix) {
			const synced = [
				"title",
				"state",
				"status",
				"summary",
				"link",
				"watching",
			];
			const kept = synced.find((key) => fields[key] !== undefined);
			if (kept) {
				return refused(
					`Spike keeps a change card's ${synced.join(", ")} in step; move it here, note it with note, watch it with watch, or close it with close_card, which archives the change`,
				);
			}
		} else if (id?.startsWith("self-fix-")) {
			return refused(
				`No card for change ${id.slice("self-fix-".length)} yet; spike adds every change's card within a few minutes, so never make one`,
			);
		}
		if (existing?.kind === "butler-card" && existing.thread) {
			const kept = [
				"title",
				"state",
				"status",
				"summary",
				"link",
				"watching",
			].find((key) => fields[key] !== undefined);
			if (kept) {
				return refused(
					"Spike keeps a thread card in step with its Discord thread; move it here, note it with note, or close it with close_card",
				);
			}
		} else if (id?.startsWith(threadCardPrefix)) {
			return refused(
				"Spike adds a card for each of Butler's Discord threads itself, so never make one",
			);
		}
		if (!existing && !title) return refused("A new card needs a title");
		const spot = freshSpot();
		const base: ButlerCard = (existing as ButlerCard | undefined) ?? {
			id: (id as string | undefined) ?? `butler-${newId()}`,
			kind: "butler-card",
			title: "",
			state: "idle",
			...spot,
			...cardSize,
			z: topZ(deps.annotations.current()) + 1,
			updatedAt: now(),
		};
		const x = number(fields, "x");
		const y = number(fields, "y");
		const w = number(fields, "w");
		const h = number(fields, "h");
		const card: ButlerCard = {
			...base,
			...(title === undefined ? {} : { title: title as string }),
			...(state === undefined ? {} : { state: state as ButlerCardState }),
			...(status === undefined ? {} : { status: status as string }),
			...(summary === undefined ? {} : { summary: summary as string }),
			...(link === undefined ? {} : { link: link as string }),
			...(typeof fields.watching === "boolean"
				? { watching: fields.watching }
				: {}),
			...(x === undefined ? {} : { x: snap(x) }),
			...(y === undefined ? {} : { y: snap(y) }),
			...(w === undefined ? {} : { w: snap(w) }),
			...(h === undefined ? {} : { h: snap(h) }),
			updatedAt: now(),
		};
		const placed = placeCard(card, !existing && x === undefined);
		const failed = put(placed);
		if (failed) return failed;
		workOn(placed.id);
		return done(
			`${existing ? "Updated" : "Created"} card '${placed.title}' (id ${placed.id}) at ${placed.x},${placed.y}`,
		);
	};

	/** Takes a card off the board with Butler's notes on it and a thread card's log; the notes it took. */
	const removeCard = (card: ButlerCard): Note[] => {
		deps.annotations.remove(card.id);
		const notes = Object.values(deps.annotations.current()).filter(
			(a): a is Note =>
				a.kind === "note" && a.author === "butler" && a.session === card.id,
		);
		for (const note of notes) deps.annotations.remove(note.id);
		if (card.thread) threadLogs.remove(card.id);
		if (looking?.target === card.id || working?.target === card.id) {
			if (looking?.target === card.id) looking = null;
			if (working?.target === card.id) working = null;
			changed();
		}
		return notes;
	};

	/** Beside a card, to its right, for a card that came from it. */
	const besideCard = (id: string | undefined) => {
		const parent = id ? deps.annotations.current()[id] : undefined;
		return parent
			? { x: snap(parent.x + parent.w + gap), y: snap(parent.y) }
			: null;
	};

	const closeCard = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["id", "change", "selfFix"]);
		if (unknown) return unknown;
		const fixRef = changeRef(fields);
		if (isOutcome(fixRef)) return fixRef;
		const id = fixRef === undefined ? text(fields, "id", 64, true) : fixRef;
		if (isOutcome(id)) return id;
		const card = annotation(id as string);
		if (card?.kind !== "butler-card") {
			return findSession(board(), id as string)
				? refused(`${id} is a session: close it with finish_session`)
				: refused(`No card ${id} of Butler's on the board`);
		}
		archiveCard(card, "closed");
		const notes = removeCard(card);
		if (card.thread) {
			dismissedThreads = { ...dismissedThreads, [card.thread.id]: now() };
			persist();
		}
		const archiving = card.selfFix ? record(card.selfFix, "archive") : "";
		return done(
			`Closed card '${card.title}'${notes.length ? ` and its ${notes.length} note${notes.length === 1 ? "" : "s"}` : ""}${archiving}`,
		);
	};

	const note = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["id", "target", "text", "color"]);
		if (unknown) return unknown;
		const id = text(fields, "id", 64);
		const target = text(fields, "target", 128);
		const body = text(fields, "text", maxNoteText, true);
		for (const value of [id, target, body]) {
			if (isOutcome(value)) return value;
		}
		const color = fields.color ?? noteColor;
		if (!noteColors.includes(color as NoteColor)) {
			return refused(`color must be one of ${noteColors.join(", ")}`);
		}
		const existing = id ? annotation(id as string) : undefined;
		if (id && (existing?.kind !== "note" || existing.author !== "butler")) {
			return refused(`No note ${id} of Butler's`);
		}
		const at = target ? resolve(target as string) : null;
		if (target && !at) return refused(`No card or session ${target}`);
		const fitted = noteSizeFor(body as string);
		const size = { w: fitted.w, h: fitted.h + butlerBylineHeight };
		const beside = at
			? { x: snap(at.rect.x + at.rect.w + 24), y: snap(at.rect.y) }
			: freshSpot();
		const draft: Note = {
			...(existing ?? {
				id: `butler-note-${newId()}`,
				...beside,
				...size,
				z: topZ(deps.annotations.current()) + 1,
			}),
			kind: "note",
			text: body as string,
			color: color as NoteColor,
			author: "butler",
			...(at ? { session: at.id } : {}),
		} as Note;
		const placed = existing ? draft : clearOf(draft, taken());
		const failed = put(placed);
		if (failed) return failed;
		if (at) workOn(at.id);
		return done(
			`${existing ? "Updated" : "Added"} note (id ${placed.id})${at ? ` on ${at.label}` : ""} at ${placed.x},${placed.y}`,
		);
	};

	const watch = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["target", "watching"]);
		if (unknown) return unknown;
		const target = text(fields, "target", 128, true);
		if (isOutcome(target)) return target;
		const on = fields.watching !== false;
		const card = annotation(target as string);
		if (card?.kind === "butler-card") {
			if (card.selfFix) {
				if (on) watchedFixes.add(card.selfFix);
				else watchedFixes.delete(card.selfFix);
				persist();
			}
			const failed = put({ ...card, watching: on, updatedAt: now() });
			return (
				failed ??
				done(`${on ? "Watching" : "Stopped watching"} '${card.title}'`)
			);
		}
		const session = findSession(board(), target as string);
		if (!session) return refused(`No card or session ${target}`);
		const others = watching.filter((id) => id !== session.id);
		if (on && others.length >= maxWatching) {
			return refused(`Butler already watches ${maxWatching} sessions`);
		}
		watching = on ? [...others, session.id] : others;
		persist();
		if (on) lookAt(session.id);
		else changed();
		return done(`${on ? "Watching" : "Stopped watching"} ${session.name}`);
	};

	/** Puts his face (look) or his cursor (work) on a card, or takes it off the board. */
	const place =
		(kind: "look" | "work") =>
		(fields: Fields): ToolOutcome => {
			const unknown = only(fields, ["target", "label"]);
			if (unknown) return unknown;
			const target = text(fields, "target", 128);
			const label = text(fields, "label", 40);
			for (const value of [target, label]) if (isOutcome(value)) return value;
			if (!target) {
				if (kind === "look") looking = null;
				else working = null;
				changed();
				return done(
					kind === "look"
						? "Butler stopped looking at the board"
						: "Butler stopped working on the board",
				);
			}
			const at = resolve(target as string);
			if (!at) return refused(`No card or session ${target}`);
			const name = (label as string | undefined) || "Butler";
			if (kind === "look") lookAt(at.id, name);
			else workOn(at.id, name);
			return done(
				`Butler is ${kind === "look" ? "looking at" : "working on"} ${at.label}`,
			);
		};
	const look = place("look");
	const work = place("work");

	/** Keeps a board action for spike to read back; the latest one wins. */
	const record = (fixId: string, action: SelfFixAction): string => {
		actions = { ...actions, [fixId]: action };
		persist();
		deps.audit({
			action: "butler",
			tool: "self_fix_action",
			result: `${action} ${fixId}`,
		});
		return action === "archive"
			? "; spike archives the change's cloud session within a few minutes"
			: "; spike stops reporting it as needing Aaron within a few minutes";
	};

	const selfFixAction = (fixId: string, action: SelfFixAction): ToolOutcome => {
		if (!selfFixPattern.test(fixId)) return refused("Not a change id");
		if (!selfFixActions.includes(action)) {
			return refused(`action must be one of ${selfFixActions.join(", ")}`);
		}
		const card = annotation(selfFixCardId(fixId));
		if (card?.kind !== "butler-card" || card.selfFix !== fixId) {
			return refused(`No card for change ${fixId}`);
		}
		if (action === "archive") return closeCard({ selfFix: fixId });
		const failed = put({
			...card,
			state: "done",
			status: dismissedStatus(card.status ?? ""),
			watching: false,
			updatedAt: now(),
		});
		if (failed) return failed;
		watchedFixes.delete(fixId);
		return done(`Marked '${card.title}' done${record(fixId, "dismiss")}`);
	};

	/** Mirrors `self-fix list`: one card each, kept where it was put. */
	const selfFixes = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["fixes"]);
		if (unknown) return unknown;
		const fixes = fields.fixes;
		if (!Array.isArray(fixes) || fixes.length > maxSelfFixes) {
			return refused(`fixes must be a list of at most ${maxSelfFixes}`);
		}
		const seen = new Set<string>();
		const fixIds = new Set<string>();
		let changedCards = 0;
		for (const raw of fixes) {
			if (typeof raw !== "object" || raw === null) {
				return refused("each change must be an object");
			}
			const fix = raw as Fields;
			const fixId = fix.id;
			if (typeof fixId !== "string" || !selfFixPattern.test(fixId)) {
				return refused("each change needs its change id");
			}
			const thread =
				typeof fix.thread === "string" && discordIdPattern.test(fix.thread)
					? fix.thread
					: undefined;
			const parent = thread ? threadCardId(thread) : undefined;
			const status = text(fix, "state", maxButlerTitle, true);
			const title = text(fix, "title", maxButlerTitle);
			const summary = text(fix, "summary", maxButlerSummary);
			const link = text(fix, "link", 500);
			for (const value of [status, title, summary, link]) {
				if (isOutcome(value)) return refused(`${fixId}: ${value.error}`);
			}
			const id = selfFixCardId(fixId);
			fixIds.add(fixId);
			const times = changeTimes(fix);
			// A card Aaron closed stays closed while spike archives its fix.
			if (actions[fixId] === "archive") {
				backfillChange(fixId, fix, times, parent);
				continue;
			}
			const dismissed = actions[fixId] === "dismiss";
			const archived = deps.archive?.get(id);
			if (archived) {
				// Archived on its own once finished, it stays archived unless it starts again.
				const state = dismissed ? "done" : selfFixState(status as string);
				if (state === "done" || state === "failed") continue;
				deps.archive?.remove(id);
			}
			seen.add(id);
			const existing = annotation(id);
			const base: ButlerCard =
				existing?.kind === "butler-card"
					? existing
					: {
							id,
							kind: "butler-card",
							title: "",
							state: "idle",
							...(besideCard(parent) ?? freshSpot()),
							...cardSize,
							z: topZ(deps.annotations.current()) + 1,
							updatedAt: now(),
						};
			const card: ButlerCard = {
				id: base.id,
				kind: "butler-card",
				x: base.x,
				y: base.y,
				w: base.w,
				h: base.h,
				z: base.z,
				updatedAt: base.updatedAt,
				title: (title as string | undefined)?.trim() || `Self-fix ${fixId}`,
				state: dismissed ? "done" : selfFixState(status as string),
				status: dismissed
					? dismissedStatus(status as string)
					: (status as string),
				selfFix: fixId,
				...(summary ? { summary: summary as string } : {}),
				...(link ? { link: link as string } : {}),
				...(!dismissed && (fix.watching === true || watchedFixes.has(fixId))
					? { watching: true }
					: {}),
				...(parent ? { parent } : {}),
				...kept(existing?.kind === "butler-card" ? existing : undefined),
				...times,
			};
			if (existing?.kind === "butler-card" && sameCard(existing, card)) {
				continue;
			}
			const placed = placeCard(
				{ ...card, updatedAt: now() },
				existing === undefined,
			);
			const failed = put(placed);
			if (failed && !failed.ok) return refused(`${fixId}: ${failed.error}`);
			changedCards += 1;
		}
		const gone = Object.values(deps.annotations.current()).filter(
			(a) =>
				a.kind === "butler-card" && a.selfFix && !a.thread && !seen.has(a.id),
		);
		for (const card of gone) {
			if (card.kind === "butler-card") archiveCard(card, "auto");
			deps.annotations.remove(card.id);
		}
		if (changedCards > 0 || gone.length > 0) tidySoon();
		// Forget what was done to fixes spike no longer lists, a week on.
		const keptActions = Object.fromEntries(
			Object.entries(actions).filter(([id]) => fixIds.has(id)),
		);
		const keptWatches = new Set(
			[...watchedFixes].filter((id) => fixIds.has(id)),
		);
		if (
			Object.keys(keptActions).length !== Object.keys(actions).length ||
			keptWatches.size !== watchedFixes.size
		) {
			actions = keptActions;
			watchedFixes = keptWatches;
			persist();
		}
		const requested = (action: SelfFixAction) =>
			Object.entries(actions)
				.filter(([, a]) => a === action)
				.map(([id]) => id)
				.sort();
		return done(
			`${fixes.length} change card${fixes.length === 1 ? "" : "s"}: ${changedCards} updated, ${gone.length} removed\nBoard actions: ${JSON.stringify({ archive: requested("archive"), dismiss: requested("dismiss") })}`,
		);
	};

	/** Where a new thread card goes: beside the card of the thread that started it, in Butler's region, or somewhere clear. */
	const newThreadSpot = (parent: string | undefined) => {
		const beside = besideCard(parent);
		if (beside) return beside;
		const region = regionNamed(deps.regions.current(), "butler");
		return region
			? { x: snap(region.x + 24), y: snap(region.y + 48) }
			: freshSpot();
	};

	/**
	 * Mirrors the daemon's thread cards file: one card for each of Butler's
	 * Discord threads active in the last day, kept where it was put, with
	 * its events and approvals kept apart from the board, and every thread
	 * card no longer listed taken off.
	 */
	const butlerThreads = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["threads"]);
		if (unknown) return unknown;
		const listed = fields.threads;
		if (!Array.isArray(listed) || listed.length > maxThreadCards) {
			return refused(`threads must be a list of at most ${maxThreadCards}`);
		}
		const entries = listed
			.flatMap((raw) => parseThreadEntry(raw) ?? [])
			// Parents first, so a thread's card can go beside its parent's.
			.sort((a, b) => a.createdAt - b.createdAt);
		const seen = new Set<string>();
		const listedThreads = new Set(entries.map((entry) => entry.id));
		let changedCards = 0;
		// The DM is Butler's face on the page, not a card: its log is kept, any old card goes.
		const dmEntry = entries.find((entry) => entry.kind === "dm") ?? null;
		const dmBefore = dm ? JSON.stringify(dmPresence(dm)) : "";
		dm = dmEntry;
		if (dmEntry) {
			const id = threadCardId(dmEntry.id);
			threadLogs.sync(id, dmEntry.events, dmEntry.approvals);
			if (annotation(id)?.kind === "butler-card") {
				deps.annotations.remove(id);
				changedCards += 1;
			}
		}
		if ((dm ? JSON.stringify(dmPresence(dm)) : "") !== dmBefore) changed();
		for (const entry of entries) {
			if (entry.kind === "dm") continue;
			const id = threadCardId(entry.id);
			const archived = deps.archive?.get(id);
			if (archived) {
				// An archived thread stays archived until it is active again.
				if (entry.lastActiveAt <= archived.archivedAt) continue;
				deps.archive?.remove(id);
			}
			const closedAt = dismissedThreads[entry.id];
			if (closedAt !== undefined) {
				if (entry.lastActiveAt <= closedAt) {
					// A card Aaron closed before the board kept an archive goes into it now.
					backfillThread(entry, closedAt);
					continue;
				}
				const { [entry.id]: _reopened, ...rest } = dismissedThreads;
				dismissedThreads = rest;
				persist();
			}
			if (seen.has(id)) continue;
			seen.add(id);
			const existing = annotation(id);
			const before = existing?.kind === "butler-card" ? existing : undefined;
			const parent = entry.parent ? threadCardId(entry.parent) : undefined;
			const base: ButlerCard = before ?? {
				id,
				kind: "butler-card",
				title: "",
				state: "idle",
				...newThreadSpot(parent),
				...cardSize,
				z: topZ(deps.annotations.current()) + 1,
				updatedAt: now(),
			};
			const card: ButlerCard = {
				id,
				kind: "butler-card",
				x: base.x,
				y: base.y,
				w: base.w,
				h: base.h,
				z: base.z,
				updatedAt: base.updatedAt,
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
				...(parent ? { parent } : {}),
				...(entry.desk ? { desk: entry.desk.id } : {}),
				...(entry.boardThread ? { boardThread: entry.boardThread } : {}),
				...(entry.mission ? { mission: entry.mission } : {}),
				...(entry.machines ? { machines: entry.machines } : {}),
				...kept(before),
				startedAt: entry.createdAt,
				...threadFinish(entry),
			};
			threadLogs.sync(id, entry.events, entry.approvals);
			if (before && sameCard(before, card)) continue;
			const fresh = before === undefined;
			const placed = fresh ? clearOf(card, taken()) : card;
			const failed = put({ ...placed, updatedAt: now() });
			if (failed && !failed.ok) return refused(`${entry.id}: ${failed.error}`);
			changedCards += 1;
		}
		const gone = Object.values(deps.annotations.current()).filter(
			(a): a is ButlerCard =>
				a.kind === "butler-card" && a.thread !== undefined && !seen.has(a.id),
		);
		for (const card of gone) {
			archiveCard(card, "auto");
			removeCard(card);
		}
		if (changedCards > 0 || gone.length > 0) tidySoon();
		// Forget a closed card once the daemon has not listed its thread for two days,
		// so one sync that lists nothing never brings every closed card back.
		const keptDismissed = Object.fromEntries(
			Object.entries(dismissedThreads).filter(
				([id, at]) => listedThreads.has(id) || now() - at < dismissedKeptMs,
			),
		);
		if (
			Object.keys(keptDismissed).length !== Object.keys(dismissedThreads).length
		) {
			dismissedThreads = keptDismissed;
			persist();
		}
		return done(
			`${entries.length} thread card${entries.length === 1 ? "" : "s"}: ${changedCards} updated, ${gone.length} removed\n${orphanReport(deps.cloud?.())}`,
		);
	};

	/** The project an archived card belonged to: the Tidy region its topic names. */
	const projectOfCard = (card: ButlerCard) =>
		tidyTopics.find((t) => t.id === topicOf({ ...card, state: "done" }))
			?.name ?? "Butler";

	const contextOf = (card: ButlerCard): CardContext => {
		const parent = card.parent ? annotation(card.parent) : undefined;
		const log = card.thread ? threadLogs.shown(card.id).events : [];
		return {
			project: projectOfCard(card),
			...(card.parent && isDm(card.parent)
				? { parent: { id: card.parent, title: "DM" } }
				: parent?.kind === "butler-card"
					? { parent: { id: parent.id, title: parent.title } }
					: card.parent
						? { parent: { id: card.parent, title: "Butler thread" } }
						: {}),
			...(log.length ? { log } : {}),
		};
	};

	/** Keeps a card in the archive, unless it is already there. */
	const archiveCard = (
		card: ButlerCard,
		reason: ArchiveEntry["reason"],
		at = now(),
	) => {
		if (!deps.archive || deps.archive.get(card.id)) return;
		deps.archive.add(entryOfCard(card, contextOf(card), reason, at));
	};

	/** A thread card Aaron closed before the board kept an archive, rebuilt from the daemon's entry. */
	const backfillThread = (entry: ThreadEntry, closedAt: number) => {
		const id = threadCardId(entry.id);
		if (!deps.archive || deps.archive.get(id)) return;
		const card: ButlerCard = {
			id,
			kind: "butler-card",
			x: 0,
			y: 0,
			...cardSize,
			z: 0,
			updatedAt: entry.lastActiveAt,
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
			...(entry.mission ? { mission: entry.mission } : {}),
			...(entry.machines ? { machines: entry.machines } : {}),
			startedAt: entry.createdAt,
			...threadFinish(entry),
		};
		const context = contextOf(card);
		deps.archive.add(
			entryOfCard(
				card,
				entry.events.length ? { ...context, log: entry.events } : context,
				"closed",
				closedAt,
			),
		);
	};

	/** A change whose card Aaron closed, from spike's record of it, when the archive does not have it yet. */
	const backfillChange = (
		fixId: string,
		fix: Fields,
		times: Pick<ButlerCard, "startedAt" | "finishedAt" | "outcome">,
		parent: string | undefined,
	) => {
		const id = selfFixCardId(fixId);
		if (!deps.archive || deps.archive.get(id)) return;
		const status = typeof fix.state === "string" ? fix.state : "";
		const title = typeof fix.title === "string" ? fix.title.trim() : "";
		const at = times.finishedAt ?? now();
		const card: ButlerCard = {
			id,
			kind: "butler-card",
			x: 0,
			y: 0,
			...cardSize,
			z: 0,
			updatedAt: at,
			title: (title || `Change ${fixId}`).slice(0, maxButlerTitle),
			state: "done",
			...(status ? { status: status.slice(0, maxButlerTitle) } : {}),
			selfFix: fixId,
			...(typeof fix.summary === "string" && fix.summary
				? { summary: fix.summary.slice(0, maxButlerSummary) }
				: {}),
			...(typeof fix.link === "string" && fix.link.startsWith("https://")
				? { link: fix.link.slice(0, 500) }
				: {}),
			...(parent ? { parent } : {}),
			...times,
		};
		deps.archive.add(entryOfCard(card, contextOf(card), "closed", at));
	};

	let tidyPending = false;
	const tidySoon = () => {
		if (!deps.schedule || tidyPending) return;
		tidyPending = true;
		deps.schedule(() => {
			tidyPending = false;
			tidy({});
		}, tidyDebounceMs);
	};

	/**
	 * The board's tidy pass: finished cards go to the archive, then every
	 * other card of Butler's is laid out in its topic's region, and with
	 * `sessions` the sessions Aaron has not pinned are laid out afresh.
	 * Non-destructive: nothing is deleted that the archive does not keep.
	 */
	const tidy = (options: { sessions?: boolean }): ToolOutcome => {
		const at = now();
		const due = butlerCards().filter((card) => !keepsOnBoard(card, at));
		let archived = 0;
		if (deps.archive) {
			for (const card of due) {
				archiveCard(card, "auto", at);
				removeCard(card);
				if (card.thread) {
					dismissedThreads = { ...dismissedThreads, [card.thread.id]: at };
				}
				archived += 1;
			}
			if (archived) persist();
		}
		let relaid = 0;
		if (options.sessions) {
			const layout = deps.layout.current();
			for (const [key, placement] of Object.entries(layout)) {
				if (placement.pinned) continue;
				deps.layout.restore(key, null);
				relaid += 1;
			}
		}
		const cards = butlerCards();
		const cardIds = new Set(cards.map((c) => c.id));
		const all = Object.values(deps.annotations.current());
		const onCards = all.filter(
			(a): a is Note =>
				a.kind === "note" &&
				a.author === "butler" &&
				a.session !== undefined &&
				cardIds.has(a.session),
		);
		const onCardIds = new Set(onCards.map((n) => n.id));
		const tidyRegions = deps.regions.current().filter(isTidyRegion);
		// A note or sticker inside Tidy's own regions moves with them, so it never pushes them further left.
		const insideTidy = (r: Rect) => tidyRegions.some((t) => centreIn(r, t));
		const obstacles: Rect[] = [
			...arranged(board(), deps).nodes.values(),
			...deps.regions.current().filter((r) => !isTidyRegion(r)),
			...all.filter(
				(a) =>
					a.kind !== "butler-card" && !onCardIds.has(a.id) && !insideTidy(a),
			),
		];
		const plan = planTidy({
			cards,
			notes: onCards,
			obstacles,
			regions: deps.regions.current(),
			now: at,
		});
		const current = deps.annotations.current();
		for (const move of plan.moves) {
			const item = current[move.id];
			if (!item) continue;
			const stored = deps.annotations.put({ ...item, x: move.x, y: move.y });
			if ("error" in stored) {
				return refused(`Could not move ${move.id}: ${stored.error}`);
			}
		}
		let regionsChanged = 0;
		for (const region of plan.regions) {
			const bounds = { x: region.x, y: region.y, w: region.w, h: region.h };
			const existing = region.id
				? deps.regions.current().find((r) => r.id === region.id)
				: undefined;
			if (existing) {
				if (
					existing.x === bounds.x &&
					existing.y === bounds.y &&
					existing.w === bounds.w &&
					existing.h === bounds.h &&
					existing.name === region.name
				) {
					continue;
				}
				deps.regions.update(existing.id, { ...bounds, name: region.name });
			} else {
				deps.regions.create({ cwd: region.cwd, name: region.name, ...bounds });
			}
			regionsChanged += 1;
		}
		const summary = `Tidied the board: ${archived} card${archived === 1 ? "" : "s"} archived, ${plan.moves.length} moved, ${regionsChanged} region${regionsChanged === 1 ? "" : "s"} resized${options.sessions ? `, ${relaid} session spot${relaid === 1 ? "" : "s"} laid out afresh` : ""}`;
		if (archived || plan.moves.length || regionsChanged || relaid) {
			deps.audit({ action: "butler", tool: "tidy", result: summary });
		}
		return done(summary);
	};

	const restore = (id: string): ToolOutcome => {
		const entry = deps.archive?.get(id);
		if (!entry) return refused(`Nothing archived as ${id}`);
		if (!entry.card) {
			return refused(
				entry.kind === "session"
					? "A session that left the board cannot come back to it"
					: "This entry was compacted and keeps no card to restore",
			);
		}
		const card: ButlerCard = {
			...entry.card,
			...freshSpot(),
			pinned: true,
			z: topZ(deps.annotations.current()) + 1,
			updatedAt: now(),
		};
		const placed = clearOf(card, taken());
		const failed = put(placed);
		if (failed) return failed;
		deps.archive?.remove(id);
		if (card.thread && dismissedThreads[card.thread.id] !== undefined) {
			const { [card.thread.id]: _back, ...rest } = dismissedThreads;
			dismissedThreads = rest;
			persist();
		}
		if (card.selfFix && actions[card.selfFix] === "archive") {
			const { [card.selfFix]: _back, ...rest } = actions;
			actions = rest;
			persist();
		}
		return done(`Restored '${card.title}' to the board, pinned`);
	};

	const sessionCard = (session: Board["sessions"][number]) => ({
		id: session.id,
		kind: "session" as const,
		name: session.name,
		short: session.id.slice(0, 8),
		state: session.activity,
		cwd: session.cwd,
	});

	const butlerCards = () =>
		Object.values(deps.annotations.current())
			.filter((a): a is ButlerCard => a.kind === "butler-card")
			.sort((a, b) => b.z - a.z);

	const ownCard = (card: ButlerCard) => ({
		id: card.selfFix ?? card.id,
		kind: "butler-card" as const,
		name: card.title,
		state: card.state,
	});

	const contains = (r: Rect, point: Point) =>
		point.x >= r.x &&
		point.x <= r.x + r.w &&
		point.y >= r.y &&
		point.y <= r.y + r.h;

	/** The session or card of Butler's under a point, with the id his face and cursor go by. */
	const cardAt = (
		point: Point,
	): { target: string; card: NonNullable<BoardContext["card"]> } | null => {
		const shown = board();
		const nodes = arranged(shown, deps).nodes;
		const session = shown.sessions.find((s) => {
			const node = nodes.get(nodeKey({ kind: "session", id: s.id }));
			return node ? contains(node, point) : false;
		});
		if (session) return { target: session.id, card: sessionCard(session) };
		const card = butlerCards().find((c) => contains(c, point));
		return card ? { target: card.id, card: ownCard(card) } : null;
	};

	const regionFor = (
		point: Point | null,
		cwd: string | undefined,
	): BoardContext["region"] | undefined => {
		const region = deps.regions
			.current()
			.find(
				(r) => (point !== null && contains(r, point)) || (cwd && cwd === r.cwd),
			);
		return region
			? {
					id: region.id,
					name: region.name ?? region.cwd.split("/").pop() ?? region.cwd,
					cwd: region.cwd,
				}
			: undefined;
	};

	/** What sits under a point on the board, for a message sent from there. */
	const contextAt = (point: Point, viewport?: BoardRect): BoardContext => {
		const context: BoardContext = viewport ? { viewport } : {};
		const at = cardAt(point);
		if (at) context.card = at.card;
		const region = regionFor(point, at?.card.cwd);
		if (region) context.region = region;
		return context;
	};

	const centreOf = (r: BoardRect): Point => ({
		x: r.x + r.w / 2,
		y: r.y + r.h / 2,
	});

	/** What Aaron is on: the session he has open, or the card in the middle of his screen. */
	const focusTarget = (report: FocusReport): string | null => {
		if (report.session) {
			const session = findSession(board(), report.session);
			if (session) return session.id;
		}
		return report.viewport
			? (cardAt(centreOf(report.viewport))?.target ?? null)
			: null;
	};

	const focus = (report: FocusReport) => {
		const at = now();
		if (report.away) {
			if (aaron?.client === report.client) aaron = null;
			return;
		}
		const target = focusTarget(report);
		const moved = aaron?.target !== target;
		aaron = {
			client: report.client,
			...(report.session ? { session: report.session } : {}),
			...(report.viewport ? { viewport: report.viewport } : {}),
			target,
			at,
			since: moved || !aaron ? at : aaron.since,
		};
	};

	const check = () => {
		if (aaron && now() - aaron.at > aaronFocusStaleMs) aaron = null;
	};

	const overlaps = (a: Rect, b: BoardRect) =>
		a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

	const describeAaron = (): AaronFocus | null => {
		check();
		if (!aaron) return null;
		const shown = board();
		const nodes = arranged(shown, deps).nodes;
		const view = aaron.viewport;
		const target = aaron.target;
		const session = target
			? shown.sessions.find((s) => s.id === target)
			: undefined;
		const own = target ? annotation(target) : undefined;
		const card: BoardContext["card"] = session
			? sessionCard(session)
			: own?.kind === "butler-card"
				? ownCard(own)
				: undefined;
		const region = regionFor(view ? centreOf(view) : null, card?.cwd);
		const onScreen = view
			? [
					...shown.sessions
						.filter((s) => {
							const node = nodes.get(nodeKey({ kind: "session", id: s.id }));
							return node ? overlaps(node, view) : false;
						})
						.map((s) => ({ id: s.id, name: s.name, state: s.activity })),
					...butlerCards()
						.filter((c) => overlaps(c, view))
						.map((c) => ({
							id: c.selfFix ?? c.id,
							name: c.title,
							state: c.state,
						})),
				].slice(0, maxOnScreen)
			: [];
		return {
			...(card ? { card } : {}),
			...(region ? { region } : {}),
			...(view ? { viewport: view } : {}),
			open: session !== undefined && aaron.session === session.id,
			onScreen,
			at: aaron.at,
			since: aaron.since,
		};
	};

	/** One line on what Aaron is working on, for board_snapshot. */
	const aaronLine = (): string => {
		const focus = describeAaron();
		if (!focus) return "Aaron is not at the board";
		const on = focus.card
			? `${focus.open ? "has open" : "is looking at"} ${focus.card.kind === "session" ? "session" : "card"} ${focus.card.name} (${focus.card.id}${focus.card.state ? `, ${focus.card.state}` : ""})`
			: "is looking at an empty part of the board";
		return `Aaron ${on}${focus.region ? ` in ${focus.region.name}` : ""}; ${focus.onScreen.length} card${focus.onScreen.length === 1 ? "" : "s"} on his screen`;
	};

	if (deps.comments) {
		inbox = createButlerInbox({
			store: deps.comments,
			contextAt,
			onRelay: changed,
			alsoQueued: () => threadLogs.queued().length,
			newId: deps.newId,
			now,
		});
	}

	const boardInbox = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, []);
		if (unknown) return unknown;
		if (!inbox) return refused("This board keeps no messages");
		const replies: InboxMessage[] = threadLogs
			.queued()
			.map(({ card, message }) => {
				const thread = card.slice(threadCardPrefix.length);
				return {
					id: message.id,
					thread: cardReplyThread(thread),
					at: message.at,
					text: message.text,
					context: {},
					target: thread,
				};
			});
		const messages = [...inbox.take(), ...replies, ...pressQueue].sort(
			(a, b) => a.at - b.at,
		);
		return done(JSON.stringify({ messages, aaron: describeAaron() }));
	};

	const boardFocus = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, []);
		if (unknown) return unknown;
		return done(JSON.stringify({ aaron: describeAaron() }));
	};

	/** Where a thread Butler is answering sits: the card it is about, or its pin. */
	const threadSpot = (threadId: string): string | null => {
		const thread = deps.comments?.get(threadId);
		if (!thread) return null;
		const card = thread.context?.card;
		const at = card ? resolve(card.id) : null;
		return at?.id ?? thread.id;
	};

	const boardAck = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["ids"]);
		if (unknown) return unknown;
		if (!inbox) return refused("This board keeps no messages");
		const ids = fields.ids;
		if (
			!Array.isArray(ids) ||
			ids.length > maxButlerQueue ||
			!ids.every((id) => typeof id === "string" && id.length <= 64)
		) {
			return refused(`ids must be a list of at most ${maxButlerQueue} ids`);
		}
		const last = ids.at(-1);
		const thread = deps.comments
			?.current()
			.find((t) => t.queued?.some((m) => m.id === last))?.id;
		const cardReply = threadLogs
			.queued()
			.find(({ message }) => message.id === last)?.card;
		const acked = new Set(ids as string[]);
		const before = pressQueue.length;
		pressQueue = pressQueue.filter((m) => !acked.has(m.id));
		const took =
			inbox.ack(ids as string[]) +
			threadLogs.ack(acked) +
			(before - pressQueue.length);
		const spot = thread ? threadSpot(thread) : (cardReply ?? null);
		if (took > 0 && spot) workOn(spot);
		return done(`Took ${took}`);
	};

	const boardReply = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["thread", "message", "text", "ok"]);
		if (unknown) return unknown;
		if (!inbox || !deps.comments) {
			return refused("This board keeps no messages");
		}
		const threadId = text(fields, "thread", 64, true);
		const messageId = text(fields, "message", 64, true);
		const body = text(fields, "text", maxNoteText, true);
		for (const value of [threadId, messageId, body]) {
			if (isOutcome(value)) return value;
		}
		const ok = fields.ok !== false;
		// An answer to a reply from a thread card goes into that card's log, never a comment thread.
		const cardReply = (threadId as string).match(/^card-([0-9]{5,25})$/);
		if (cardReply?.[1]) {
			const card = threadCardId(cardReply[1]);
			if (isDm(card)) {
				threadLogs.append(card, {
					at: now(),
					kind: ok ? "reply" : "error",
					text: (body as string).slice(0, maxThreadEventText),
				});
				return done("Shown on the DM's log");
			}
			if (annotation(card)?.kind === "butler-card") {
				threadLogs.append(card, {
					at: now(),
					kind: ok ? "reply" : "error",
					text: (body as string).slice(0, maxThreadEventText),
				});
				workOn(card);
				return done("Shown on the thread's card");
			}
			return done("No such thread card on the board any more");
		}
		const thread = inbox.reply(
			threadId as string,
			messageId as string,
			body as string,
			ok,
		);
		// A thread Aaron deleted on the board has nothing to answer; that's fine.
		if (!thread) return done("No such thread on the board any more");
		const spot = threadSpot(thread.id);
		if (spot) workOn(spot);
		const card = thread.context?.card;
		if (!ok || !card) return done("Shown on the board");
		const kept = thread.replyNote
			? deps.annotations.current()[thread.replyNote]
			: undefined;
		const pinned = note({
			...(kept?.kind === "note" ? { id: kept.id } : {}),
			target: card.id,
			text: body as string,
		});
		const id = pinned.ok ? pinned.text.match(/\(id ([^)]+)\)/)?.[1] : null;
		if (id && id !== thread.replyNote) {
			deps.comments.update(thread.id, (t) => ({ ...t, replyNote: id }));
		}
		return done(
			pinned.ok
				? `Shown on the board and noted on ${card.name}`
				: `Shown on the board; could not note it on the card: ${pinned.error}`,
		);
	};

	const own: Record<string, (fields: Fields) => ToolOutcome> = {
		board_inbox: boardInbox,
		board_ack: boardAck,
		board_focus: boardFocus,
		board_reply: boardReply,
		put_card: putCard,
		close_card: closeCard,
		note,
		watch,
		look,
		work,
		// The changes' sync, by its new name and its old one, which spike still sends.
		changes: selfFixes,
		self_fixes: selfFixes,
		butler_threads: butlerThreads,
		tidy: (fields) =>
			only(fields, ["sessions"]) ??
			tidy({ sessions: fields.sessions === true }),
	};

	const tool = async (name: string, body: unknown): Promise<ToolOutcome> => {
		const fields = body ?? {};
		if (typeof fields !== "object" || Array.isArray(fields)) {
			return refused("Arguments must be an object");
		}
		const handler = own[name];
		if (handler) {
			const outcome = handler(fields as Fields);
			// A thread sync runs every few seconds while Butler works, so only one that changed a card is audited.
			const quietSync =
				name === "butler_threads" &&
				outcome.ok &&
				/ 0 updated, 0 removed$/.test(outcome.text.split("\n")[0] ?? "");
			if (
				!quietSync &&
				!["look", "work", "board_inbox", "board_focus"].includes(name)
			) {
				deps.audit({
					action: "butler",
					tool: name,
					result: outcome.ok
						? (outcome.text.split("\n")[0] ?? "")
						: `error: ${outcome.error}`,
				});
			}
			return outcome;
		}
		if (name === "put_note") {
			return refused("Butler's notes go through note, which signs them");
		}
		const call = parseToolCall(name, fields);
		if ("error" in call) return refused(call.error);
		if ("session" in call) {
			const session = findSession(board(), call.session);
			if (session && readingTools.has(call.tool)) lookAt(session.id);
			else if (session) workOn(session.id);
		}
		const outcome = await deps.tools(butlerIdentity, call);
		if (call.tool !== "board_snapshot") return outcome;
		if (!outcome.ok) return outcome;
		return done(
			`${outcome.text}\nButler watches: ${JSON.stringify(watching)}\n${aaronLine()}`,
		);
	};

	const threadView = (thread: string): ButlerThreadView | null => {
		if (!discordIdPattern.test(thread)) return null;
		const id = threadCardId(thread);
		const found = annotation(id);
		const card: ButlerThreadView["card"] | null =
			dm?.id === thread
				? {
						id,
						title: dm.title,
						state: dm.state,
						...(dm.status ? { status: dm.status } : {}),
						link: dm.link,
						thread: {
							id: dm.id,
							kind: dm.kind,
							link: dm.link,
							private: dm.private,
						},
						updatedAt: dm.lastActiveAt,
					}
				: found?.kind === "butler-card" && found.thread
					? {
							id: found.id,
							title: found.title,
							state: found.state,
							...(found.status ? { status: found.status } : {}),
							...(found.link ? { link: found.link } : {}),
							thread: found.thread,
							...(found.parent ? { parent: found.parent } : {}),
							...(found.desk ? { desk: found.desk } : {}),
							updatedAt: found.updatedAt,
						}
					: null;
		if (!card) return null;
		const shown = threadLogs.shown(id);
		const children: ButlerThreadView["children"] = [
			...butlerCards()
				.filter((c) => c.parent === id)
				.sort((a, b) => a.updatedAt - b.updatedAt)
				.map((c) => ({
					kind: c.thread ? ("thread" as const) : ("change" as const),
					id: c.thread ? c.thread.id : (c.selfFix ?? c.id),
					title: c.title,
					state: c.state,
					...(c.link ? { link: c.link } : {}),
				})),
			...board()
				.sessions.filter((s) => s.parent?.thread === thread)
				.map((s) => ({
					kind: "session" as const,
					id: s.id,
					title: s.name,
					state: s.activity,
					...(s.cloud ? { link: s.cloud.url } : {}),
				})),
		];
		return {
			card,
			events: shown.events,
			approvals: shown.approvals.map(pageCopy),
			children,
		};
	};

	const sendToThread = (
		thread: string,
		body: string,
	): { ok: true } | Refused => {
		const id = threadCardId(thread);
		const card = discordIdPattern.test(thread) ? annotation(id) : undefined;
		// The DM's replies queue like a card's; the daemon posts them into the Discord DM.
		if (dm?.id !== thread && (card?.kind !== "butler-card" || !card.thread)) {
			return { error: "No such thread card", status: 404 };
		}
		if (!inbox) {
			return { error: "Butler is not set up on this board", status: 409 };
		}
		const limit = inbox.admit();
		if (limit) return limit;
		const at = now();
		threadLogs.queue(id, { id: newId(), at, text: body });
		threadLogs.append(id, {
			at,
			kind: "user",
			text: body.slice(0, maxThreadEventText),
		});
		return { ok: true };
	};

	/** Presses of Approve and Decline the board took, by request code, so a second one says so. */
	const pressed = new Map<string, ButlerApprovalPress>();
	/** Presses waiting for spike, carried by board_inbox like Aaron's messages. */
	let pressQueue: ApprovalPressMessage[] = [];
	const presses: number[] = [];

	/** A request as the page sees it: never its nonce. */
	const pageCopy = (a: ButlerThreadApproval): ButlerThreadApproval => {
		const { nonce, ...rest } = a;
		const press = a.code ? pressed.get(a.code) : undefined;
		return {
			...rest,
			...(nonce ? { answerable: true } : {}),
			...(press ? { pressed: press } : {}),
		};
	};

	const threadCards = () =>
		Object.values(deps.annotations.current()).filter(
			(a): a is ButlerCard =>
				a.kind === "butler-card" && a.thread !== undefined,
		);

	const approvalsWaiting = (): ButlerWaitingApproval[] =>
		threadCards()
			.flatMap((card) =>
				threadLogs
					.shown(card.id)
					.approvals.filter((a) => a.code)
					.map((a) => ({
						thread: card.thread?.id ?? "",
						title: card.title,
						approval: pageCopy(a),
					})),
			)
			.sort((a, b) => a.approval.at - b.approval.at);

	const answerApproval: Butler["answerApproval"] = (
		thread,
		code,
		decision,
		options,
	) => {
		const id = threadCardId(thread);
		const card = discordIdPattern.test(thread) ? annotation(id) : undefined;
		if (card?.kind !== "butler-card" || !card.thread) {
			return { error: "No such thread card", status: 404 };
		}
		const approval = threadLogs
			.shown(id)
			.approvals.find((a) => a.code === code);
		const done = pressed.get(code);
		if (done) {
			const time = new Date(done.at).toLocaleTimeString("en-GB", {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
			return {
				error: `Already ${done.decision === "approve" ? "approved" : "declined"} from the board${done.device ? ` on ${done.device}` : ""} at ${time}`,
				status: 409,
			};
		}
		if (!approval) {
			return {
				error: "That request is no longer waiting on you",
				status: 404,
			};
		}
		if (!approval.nonce) {
			return {
				error:
					"Butler has not issued a board button for this request; answer it in Discord",
				status: 409,
			};
		}
		if (decision === "approve" && approval.critical && !options.held) {
			return {
				error:
					"This request has critical items: press and hold Approve until the ring fills",
				status: 400,
			};
		}
		const at = now();
		while (presses.length > 0 && (presses[0] ?? 0) <= at - pressWindowMs) {
			presses.shift();
		}
		if (presses.length >= maxPresses) {
			return {
				error: `At most ${maxPresses} approvals in ${pressWindowMs / 60_000} minutes; try again shortly`,
				status: 429,
			};
		}
		presses.push(at);
		const press: ButlerApprovalPress = {
			decision,
			at,
			...(options.device ? { device: options.device } : {}),
		};
		pressed.set(code, press);
		if (pressed.size > 500) pressed.delete(pressed.keys().next().value ?? "");
		pressQueue = [
			...pressQueue,
			{
				id: newId(),
				thread: cardReplyThread(thread),
				at,
				text: `${decision} ${code}`,
				context: {},
				target: thread,
				approval: {
					code,
					nonce: approval.nonce,
					decision,
					...(options.held ? { held: true as const } : {}),
					...(options.device ? { device: options.device } : {}),
					...(options.bulk ? { bulk: true as const } : {}),
				},
			},
		].slice(-maxButlerQueue);
		threadLogs.append(id, {
			at,
			kind: "approval",
			text: `${decision === "approve" ? "Approved" : "Declined"} from the board: ${approval.headline}; sent to Butler`,
		});
		deps.audit({
			action: "butler",
			tool: `approval-${decision}`,
			result: `${code} on ${thread}${options.device ? ` from ${options.device}` : ""}${options.bulk ? " (Approve all safe)" : ""}`,
		});
		return {
			ok: true,
			text: `${decision === "approve" ? "Approved" : "Declined"}; Butler carries on as soon as spike takes it`,
		};
	};

	const approveAllSafe: Butler["approveAllSafe"] = (device) => {
		const approved: ButlerWaitingApproval[] = [];
		const left: (ButlerWaitingApproval & { why: string })[] = [];
		for (const item of approvalsWaiting()) {
			const a = item.approval;
			if (a.pressed) continue;
			if (!a.answerable) {
				left.push({ ...item, why: "answer it in Discord" });
				continue;
			}
			if (a.critical || !a.safe) {
				left.push({
					...item,
					why: a.critical
						? "it has critical items, so it needs its own press"
						: "its card does not say it has no critical items",
				});
				continue;
			}
			const done = answerApproval(item.thread, a.code ?? "", "approve", {
				bulk: true,
				...(device ? { device } : {}),
			});
			if ("error" in done) left.push({ ...item, why: done.error });
			else approved.push(item);
		}
		return { approved, left };
	};

	const startJob = (draft: {
		x: number;
		y: number;
		text: string;
		viewport?: BoardRect;
	}): CommentThread | Refused =>
		inbox
			? inbox.start({ ...draft, job: true })
			: { error: "Butler is not set up on this board", status: 409 };

	const closeThreadCard = (cardId: string): ToolOutcome => {
		const card = annotation(cardId);
		if (card?.kind !== "butler-card" || !card.thread) {
			return refused(`No thread card ${cardId}`);
		}
		return closeCard({ id: card.id });
	};

	return {
		current,
		tool,
		selfFixAction,
		inbox,
		focus,
		aaron: describeAaron,
		threadView,
		sendToThread,
		approvalsWaiting,
		answerApproval,
		approveAllSafe,
		startJob,
		closeThreadCard,
		tidy: (options = {}) => tidy(options),
		restore,
		check,
		saved: async () => {
			await file.saved();
			await threadLogs.saved();
		},
	};
};
