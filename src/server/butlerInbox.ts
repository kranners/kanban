import { randomUUID } from "node:crypto";
import {
	type BoardContext,
	type BoardRect,
	type CommentThread,
	type Landing,
	maxButlerQueue,
	type Point,
} from "../shared/types.ts";
import { type CommentStore, maxEventText, maxMessage } from "./comments.ts";
import { createStateFile, readState } from "./stateFile.ts";

// Aaron's messages to Butler wait here, in their comment threads, until
// spike collects them. Spike polls over ssh every few seconds through
// Butler's loopback endpoint: board_inbox lists what is queued, board_ack
// confirms spike has it, and board_reply brings Butler's answer back.
// Nothing here reaches spike by itself, so the board never needs to know
// where spike is, and a page can only add to the queue, never read it.

/** Spike polls every few seconds; this long without a poll means it is unreachable. */
export const relayStaleMs = 20_000;
/** At most this many messages to Butler in any window, so a stuck key or a loop cannot flood him. */
export const maxSends = 20;
export const sendWindowMs = 10 * 60_000;

export type InboxMessage = {
	id: string;
	thread: string;
	at: number;
	text: string;
	context: BoardContext;
	/** The Discord thread a reply from a thread card goes into. */
	target?: string;
	/** The first message of a Butler job from the top bar. */
	job?: true;
};

/** Aaron's reply from a thread card or the DM, waiting for spike like a message of a board thread. */
export type CardReply = {
	id: string;
	/** The board thread spike answers it in, `card-<Discord id>`. */
	thread: string;
	/** The Discord thread it goes into. */
	target: string;
	at: number;
	text: string;
};

const cardReplyThreadPattern = /^card-[0-9]{5,25}$/;
const discordThreadPattern = /^[0-9]{5,25}$/;
const queuedIdPattern = /^[A-Za-z0-9-]{1,64}$/;

/** Card replies as saved, clipped, or none when the file is not a list of them. */
export const parseCardReplies = (value: unknown): CardReply[] =>
	Array.isArray(value)
		? value
				.flatMap((raw): CardReply[] => {
					const { id, thread, target, at, text } = (raw ?? {}) as Record<
						string,
						unknown
					>;
					return typeof id === "string" &&
						queuedIdPattern.test(id) &&
						typeof thread === "string" &&
						cardReplyThreadPattern.test(thread) &&
						typeof target === "string" &&
						discordThreadPattern.test(target) &&
						typeof at === "number" &&
						Number.isFinite(at) &&
						at >= 0 &&
						typeof text === "string"
						? [{ id, thread, target, at, text: text.slice(0, maxMessage) }]
						: [];
				})
				.slice(-maxButlerQueue)
		: [];

export const loadCardReplies = (file: string): Promise<CardReply[]> =>
	readState(file, parseCardReplies);

export type Refused = { error: string; status: 404 | 409 | 429 };

export type ButlerInbox = {
	start(draft: {
		x: number;
		y: number;
		text: string;
		viewport?: BoardRect;
		job?: boolean;
	}): CommentThread | Refused;
	/** Queues Aaron's reply from a thread card or the DM for spike, against the same limits as any message. */
	queueReply(reply: Omit<CardReply, "id" | "at">): CardReply | Refused;
	/** The Discord thread a queued card reply goes to, by its id. */
	replyTarget(id: string): string | undefined;
	send(threadId: string, text: string): { ok: true } | Refused;
	cancel(threadId: string): boolean;
	take(): InboxMessage[];
	ack(ids: string[]): number;
	reply(
		threadId: string,
		messageId: string,
		text: string,
		ok: boolean,
	): CommentThread | null;
	/** Shows a session Butler started in the thread he is answering, if any. */
	showSession(landing: Landing, text: string): void;
	/** Absent until spike first polls or the boot's grace runs out. */
	relay(): "up" | "down" | undefined;
	/** Marks spike unreachable once it has not polled for a while. */
	check(): void;
	saved(): Promise<void>;
};

export type ButlerInboxDeps = {
	store: CommentStore;
	contextAt: (point: Point, viewport?: BoardRect) => BoardContext;
	onRelay: () => void;
	/** Where card replies are kept until spike takes them; absent keeps them in memory only. */
	repliesFile?: string;
	initialReplies?: CardReply[];
	newId?: () => string;
	now?: () => number;
};

const isButler = (thread: CommentThread | null): thread is CommentThread =>
	thread?.to === "butler";

export const createButlerInbox = (deps: ButlerInboxDeps): ButlerInbox => {
	const now = deps.now ?? Date.now;
	const newId = deps.newId ?? randomUUID;
	const sends: number[] = [];
	const bootAt = now();
	let seenAt: number | null = null;
	let relay: "up" | "down" | undefined;
	let replies: CardReply[] = [...(deps.initialReplies ?? [])].slice(
		-maxButlerQueue,
	);
	const repliesFile = deps.repliesFile
		? createStateFile<CardReply[]>(deps.repliesFile)
		: null;
	const saveReplies = () => repliesFile?.write(replies);
	if (replies.length > 0) saveReplies();

	const limited = (): Refused | null => {
		const at = now();
		while (sends.length > 0 && (sends[0] ?? 0) <= at - sendWindowMs) {
			sends.shift();
		}
		if (sends.length >= maxSends) {
			return {
				error: `At most ${maxSends} messages to Butler in ${sendWindowMs / 60_000} minutes; try again shortly`,
				status: 429,
			};
		}
		const queued =
			deps.store
				.current()
				.reduce((sum, thread) => sum + (thread.queued?.length ?? 0), 0) +
			replies.length;
		if (queued >= maxButlerQueue) {
			return {
				error: `${queued} messages are already waiting for spike`,
				status: 429,
			};
		}
		return null;
	};

	const enqueue = (
		thread: CommentThread,
		text: string,
		job = false,
	): CommentThread => {
		const at = now();
		sends.push(at);
		return {
			...thread,
			queued: [
				...(thread.queued ?? []),
				{ id: newId(), at, text, ...(job ? { job: true as const } : {}) },
			],
			events: [...thread.events, { kind: "user", at, text }],
		};
	};

	const setRelay = (next: "up" | "down") => {
		if (relay === next) return;
		relay = next;
		deps.onRelay();
	};

	return {
		start(draft) {
			if (draft.text.length > maxMessage) {
				return { error: "That message is too long", status: 409 };
			}
			const refused = limited();
			if (refused) return refused;
			const context = deps.contextAt(draft, draft.viewport);
			const created = deps.store.create({
				x: draft.x,
				y: draft.y,
				text: draft.text,
			});
			if (!created) {
				return { error: "The board holds too many comments", status: 409 };
			}
			return (
				deps.store.update(created.id, (thread) => ({
					...enqueue(thread, draft.text, draft.job === true),
					context,
					...(draft.job ? { job: true as const } : {}),
				})) ?? created
			);
		},
		queueReply(draft) {
			const refused = limited();
			if (refused) return refused;
			const at = now();
			sends.push(at);
			const reply: CardReply = {
				id: newId(),
				...draft,
				at,
				text: draft.text.slice(0, maxMessage),
			};
			replies = [...replies, reply];
			saveReplies();
			return reply;
		},
		replyTarget: (id) => replies.find((reply) => reply.id === id)?.target,
		send(threadId, text) {
			const thread = deps.store.get(threadId);
			if (!thread) return { error: "No such thread", status: 404 };
			if (!isButler(thread)) {
				return {
					error: "That thread is the retired board agent's",
					status: 409,
				};
			}
			const refused = limited();
			if (refused) return refused;
			deps.store.update(threadId, (current) => ({
				...enqueue(current, text),
				resolved: false,
			}));
			return { ok: true };
		},
		cancel(threadId) {
			const thread = deps.store.get(threadId);
			if (!isButler(thread)) return false;
			const unsent = thread.queued?.length ?? 0;
			const pending = thread.waiting?.length ?? 0;
			if (unsent + pending === 0) return true;
			deps.store.update(threadId, (current) => ({
				...current,
				queued: [],
				waiting: [],
				running: false,
				events: [
					...current.events,
					{
						kind: "error",
						at: now(),
						text:
							unsent > 0
								? "Stopped: the unsent message was never sent to Butler."
								: "Stopped waiting here. Butler may still answer in Discord.",
					},
				],
			}));
			return true;
		},
		take() {
			seenAt = now();
			setRelay("up");
			const fromThreads: InboxMessage[] = deps.store
				.current()
				.filter(isButler)
				.flatMap((thread) =>
					(thread.queued ?? []).map((message) => ({
						id: message.id,
						thread: thread.id,
						at: message.at,
						text: message.text,
						context: thread.context ?? {},
						...(message.job ? { job: true as const } : {}),
					})),
				);
			const fromCards: InboxMessage[] = replies.map((reply) => ({
				id: reply.id,
				thread: reply.thread,
				at: reply.at,
				text: reply.text,
				context: {},
				target: reply.target,
			}));
			return [...fromThreads, ...fromCards].sort((a, b) => a.at - b.at);
		},
		ack(ids) {
			const wanted = new Set(ids);
			const tookReplies = replies.filter((reply) => wanted.has(reply.id));
			let acked = tookReplies.length;
			if (tookReplies.length > 0) {
				replies = replies.filter((reply) => !wanted.has(reply.id));
				saveReplies();
			}
			for (const thread of deps.store.current().filter(isButler)) {
				const taken = (thread.queued ?? []).filter((m) => wanted.has(m.id));
				if (taken.length === 0) continue;
				acked += taken.length;
				deps.store.update(thread.id, (current) => {
					const waiting = [
						...(current.waiting ?? []),
						...taken.map((m) => m.id),
					].slice(-maxButlerQueue);
					return {
						...current,
						queued: (current.queued ?? []).filter((m) => !wanted.has(m.id)),
						waiting,
						running: true,
					};
				});
			}
			return acked;
		},
		reply(threadId, messageId, text, ok) {
			const thread = deps.store.get(threadId);
			if (!isButler(thread)) return null;
			return deps.store.update(threadId, (current) => {
				const waiting = (current.waiting ?? []).filter((m) => m !== messageId);
				return {
					...current,
					waiting,
					running: waiting.length > 0,
					events: [
						...current.events,
						{
							kind: ok ? "reply" : "error",
							at: now(),
							text: text.slice(0, maxEventText),
						},
					],
				};
			});
		},
		showSession(landing, text) {
			const answering = deps.store
				.current()
				.filter((thread) => isButler(thread) && thread.waiting?.length)
				.sort((a, b) => b.updatedAt - a.updatedAt)[0];
			if (!answering) return;
			deps.store.update(answering.id, (current) => ({
				...current,
				events: [
					...current.events,
					{
						kind: "session",
						at: now(),
						landing,
						text: text.slice(0, maxEventText),
					},
				],
			}));
		},
		relay: () => relay,
		saved: () => repliesFile?.saved() ?? Promise.resolve(),
		check() {
			if (now() - (seenAt ?? bootAt) > relayStaleMs) setRelay("down");
		},
	};
};
