import { computed, signal } from "@preact/signals";
import type {
	AgentButton,
	CommentEvent,
	CommentThread,
	Point,
} from "../shared/types.ts";
import type { KeyPress } from "./actions.ts";

export type Composer = { board: Point; client: Point };
export type ThreadMenu = { id: string; client: Point };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const echoMs = 3000;

export const threads = signal<ReadonlyMap<string, CommentThread>>(new Map());
export const openThreadId = signal<string | null>(null);
export const composer = signal<Composer | null>(null);
export const threadMenu = signal<ThreadMenu | null>(null);
export const pinDrafts = signal<ReadonlyMap<string, Point>>(new Map());

export const openButton = signal<AgentButton | null>(null);

export const pinned = computed(() =>
	[...threads.value.values()]
		.filter((thread) => !thread.button)
		.map((thread) => {
			const draft = pinDrafts.value.get(thread.id);
			return draft ? { ...thread, ...draft } : thread;
		}),
);

export const buttonThreads = computed(
	() =>
		new Map(
			[...threads.value.values()].flatMap((thread) =>
				thread.button ? [[thread.button, thread] as const] : [],
			),
		),
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

export type PinState = "running" | "failed" | "resolved" | "answered";

export function pinState(thread: CommentThread): PinState {
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
	const button = openButton.peek();
	if (button && !buttonThreads.peek().has(button)) openButton.value = null;
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

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<Outcome<T>> {
	try {
		const response = await fetch(path, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
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

export async function startThread(
	at: Point,
	text: string,
	button?: AgentButton,
): Promise<Outcome<CommentThread>> {
	const created = await request<CommentThread>("POST", "/api/comments", {
		x: Math.round(at.x),
		y: Math.round(at.y),
		text,
		...(button ? { button } : {}),
	});
	if (created.ok) {
		receiveComment(created.value);
		if (button) openButton.value = button;
		else openThreadId.value = created.value.id;
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
