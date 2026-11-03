import { computed, signal } from "@preact/signals";
import type {
	BoardRect,
	ButlerPresence,
	CommentEvent,
	CommentThread,
	Point,
} from "../shared/types.ts";
import type { KeyPress } from "./actions.ts";

/** Where the `/` popup opens, and any request a top bar button filled in for Aaron to edit. */
export type Composer = { board: Point; client: Point; text?: string };
export type ThreadMenu = { id: string; client: Point };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const echoMs = 3000;

export const threads = signal<ReadonlyMap<string, CommentThread>>(new Map());
export const openThreadId = signal<string | null>(null);
export const composer = signal<Composer | null>(null);
export const threadMenu = signal<ThreadMenu | null>(null);
export const pinDrafts = signal<ReadonlyMap<string, Point>>(new Map());

export const pinned = computed(() =>
	[...threads.value.values()].map((thread) => {
		const draft = pinDrafts.value.get(thread.id);
		return draft ? { ...thread, ...draft } : thread;
	}),
);

export const openThread = computed(() =>
	openThreadId.value
		? (pinned.value.find((t) => t.id === openThreadId.value) ?? null)
		: null,
);

export function isCommentKey(press: KeyPress, typing: boolean): boolean {
	return (
		press.key === "/" &&
		!press.repeat &&
		!press.altKey &&
		!press.ctrlKey &&
		!press.metaKey &&
		!typing
	);
}

export type PinState =
	| "queued"
	| "running"
	| "failed"
	| "resolved"
	| "answered";

export function pinState(thread: CommentThread): PinState {
	if ((thread.queued?.length ?? 0) > 0) return "queued";
	if (thread.running) return "running";
	if (thread.resolved) return "resolved";
	return thread.events.at(-1)?.kind === "error" ? "failed" : "answered";
}

export function threadTitle(thread: CommentThread): string {
	const first = thread.events.find(
		(event): event is Extract<CommentEvent, { kind: "user" }> =>
			event.kind === "user",
	);
	return first?.text.split("\n")[0]?.trim() || "Comment";
}

export function receiveComments(list: readonly CommentThread[]): void {
	threads.value = new Map(list.map((thread) => [thread.id, thread]));
	const open = openThreadId.peek();
	if (open && !threads.value.has(open)) openThreadId.value = null;
}

export function receiveComment(thread: CommentThread): void {
	threads.value = new Map(threads.peek()).set(thread.id, thread);
	const draft = pinDrafts.peek().get(thread.id);
	if (draft && draft.x === thread.x && draft.y === thread.y) {
		forgetDraft(thread.id, draft);
	}
}

function forgetDraft(id: string, draft: Point): void {
	if (pinDrafts.peek().get(id) !== draft) return;
	const next = new Map(pinDrafts.peek());
	next.delete(id);
	pinDrafts.value = next;
}

/** The retired board agent's threads stay on the board to read, but take no replies. */
export const isRetired = (thread: CommentThread): boolean =>
	thread.to !== "butler";

export const isButlerThread = (thread: CommentThread): boolean =>
	thread.to === "butler";

/** What to say about a thread with Butler while it waits, or null once answered. */
export function butlerStatus(
	thread: CommentThread,
	relay: ButlerPresence["relay"],
): string | null {
	if ((thread.queued?.length ?? 0) > 0) {
		return relay === "down"
			? "Spike is unreachable. Queued here; it sends once spike is back."
			: "Waiting for spike to collect it…";
	}
	if (thread.running) return "Butler is working on it…";
	return null;
}

let csrfToken: Promise<string | null> | null = null;

/** The token that proves a message to Butler came from this page. */
function csrf(): Promise<string | null> {
	csrfToken ??= fetch("/api/csrf")
		.then((r) => (r.ok ? r.json() : null))
		.then((body: { token?: unknown } | null) =>
			typeof body?.token === "string" ? body.token : null,
		)
		.catch(() => null)
		.then((token) => {
			if (token === null) csrfToken = null;
			return token;
		});
	return csrfToken;
}

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<Outcome<T>> {
	try {
		const token = method === "GET" ? null : await csrf();
		const response = await fetch(path, {
			method,
			...(body === undefined
				? token
					? { headers: { "x-kanban-csrf": token } }
					: {}
				: {
						headers: {
							"content-type": "application/json",
							...(token ? { "x-kanban-csrf": token } : {}),
						},
						body: JSON.stringify(body),
					}),
		});
		if (response.status === 204) return { ok: true, value: undefined as T };
		const parsed = (await response.json().catch(() => null)) as
			| (T & { error?: string })
			| null;
		if (response.ok && parsed) return { ok: true, value: parsed };
		return {
			ok: false,
			error:
				parsed?.error ?? `The board server answered HTTP ${response.status}`,
		};
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

const threadPath = (id: string) => `/api/comments/${encodeURIComponent(id)}`;

/** Sends Aaron's message to Butler from a point on the board and opens its thread. */
export async function startThread(
	at: Point,
	text: string,
	viewport?: BoardRect,
): Promise<Outcome<CommentThread>> {
	const created = await request<CommentThread>("POST", "/api/comments", {
		x: Math.round(at.x),
		y: Math.round(at.y),
		text,
		to: "butler",
		...(viewport ? { viewport } : {}),
	});
	if (created.ok) {
		receiveComment(created.value);
		openThreadId.value = created.value.id;
	}
	return created;
}

export function reply(id: string, text: string): Promise<Outcome<void>> {
	return request<void>("POST", `${threadPath(id)}/messages`, { text });
}

export function stop(id: string): Promise<Outcome<void>> {
	return request<void>("POST", `${threadPath(id)}/cancel`);
}

export function resolve(id: string, resolved: boolean): Promise<Outcome<void>> {
	return request<void>("PATCH", threadPath(id), { resolved });
}

export async function remove(id: string): Promise<Outcome<void>> {
	if (openThreadId.peek() === id) openThreadId.value = null;
	return request<void>("DELETE", threadPath(id));
}

export function previewPin(id: string, at: Point): void {
	pinDrafts.value = new Map(pinDrafts.peek()).set(id, at);
}

export async function movePin(id: string, at: Point): Promise<void> {
	const draft = { x: Math.round(at.x), y: Math.round(at.y) };
	previewPin(id, draft);
	const moved = await request<CommentThread>("PATCH", threadPath(id), draft);
	if (!moved.ok) forgetDraft(id, draft);
	else setTimeout(() => forgetDraft(id, draft), echoMs);
}
