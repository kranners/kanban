import { randomUUID } from "node:crypto";
import {
	type BoardContext,
	type BoardRect,
	type CommentThread,
	maxButlerQueue,
	type Point,
} from "../shared/types.ts";
import { type CommentStore, maxEventText, maxMessage } from "./comments.ts";

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

export type Refused = { error: string; status: 404 | 409 | 429 };

export type ButlerInbox = {
	start(draft: {
		x: number;
		y: number;
		text: string;
		viewport?: BoardRect;
		job?: boolean;
	}): CommentThread | Refused;
	/** Counts one more message to Butler against the limits, or says why not now. */
	admit(): Refused | null;
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
	/** Absent until spike first polls or the boot's grace runs out. */
	relay(): "up" | "down" | undefined;
	/** Marks spike unreachable once it has not polled for a while. */
	check(): void;
};

export type ButlerInboxDeps = {
	store: CommentStore;
	contextAt: (point: Point, viewport?: BoardRect) => BoardContext;
	onRelay: () => void;
	/** Messages waiting elsewhere, such as replies from thread cards, counted against the queue's limit. */
	alsoQueued?: () => number;
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
			(deps.alsoQueued?.() ?? 0);
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
		admit() {
			const refused = limited();
			if (refused) return refused;
			sends.push(now());
			return null;
		},
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
			return deps.store
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
				)
				.sort((a, b) => a.at - b.at);
		},
		ack(ids) {
			const wanted = new Set(ids);
			let acked = 0;
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
		relay: () => relay,
		check() {
			if (now() - (seenAt ?? bootAt) > relayStaleMs) setRelay("down");
		},
	};
};
