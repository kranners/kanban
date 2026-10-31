import { randomUUID } from "node:crypto";
import {
	type AgentButton,
	agentButtons,
	type CommentDraft,
	type CommentEvent,
	type CommentPatch,
	type CommentThread,
} from "../shared/types.ts";
import { isCoordinate } from "./layout.ts";
import { createStateFile, readState } from "./stateFile.ts";

export type CommentStore = {
	current(): CommentThread[];
	get(id: string): CommentThread | null;
	create(draft: CommentDraft): CommentThread | null;
	update(
		id: string,
		change: (thread: CommentThread) => CommentThread,
	): CommentThread | null;
	remove(id: string): boolean;
	owns(sessionId: string): boolean;
	saved(): Promise<void>;
};

export type CommentStoreOptions = {
	file: string;
	initial: CommentThread[];
	onChange: (thread: CommentThread) => void;
	onRemove: (threads: CommentThread[]) => void;
	newId?: () => string;
	now?: () => number;
};

export const maxThreads = 200;
export const maxEvents = 200;
export const maxMessage = 4000;
export const maxEventText = 8000;
const threadIdPattern = /^[A-Za-z0-9-]{1,64}$/;
const sessionIdPattern = /^[0-9a-f-]{36}$/;
const eventKinds = new Set(["user", "action", "reply", "error"]);
const actionStates = new Set(["running", "done", "failed"]);

export const isThreadId = (value: string): boolean =>
	threadIdPattern.test(value);

const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

export const parseMessage = (body: unknown): string | { error: string } => {
	const text = (body as Record<string, unknown> | null)?.text;
	if (typeof text !== "string" || text.trim() === "") {
		return { error: "text is required" };
	}
	if (text.length > maxMessage) {
		return { error: `text must be at most ${maxMessage} characters` };
	}
	return text;
};

const isAgentButton = (value: unknown): value is AgentButton =>
	agentButtons.includes(value as AgentButton);

export const parseCommentDraft = (
	body: unknown,
): CommentDraft | { error: string } => {
	if (typeof body !== "object" || body === null) {
		return { error: "Expected a JSON object with x, y and text" };
	}
	const { x, y, button } = body as Record<string, unknown>;
	if (!isCoordinate(x) || !isCoordinate(y)) {
		return { error: "x and y must be finite board coordinates" };
	}
	if (button !== undefined && !isAgentButton(button)) {
		return { error: "button must be tidy or snooze" };
	}
	const text = parseMessage(body);
	return typeof text === "string"
		? { x, y, text, ...(button === undefined ? {} : { button }) }
		: text;
};

export const parseCommentPatch = (
	body: unknown,
): CommentPatch | { error: string } => {
	if (typeof body !== "object" || body === null) {
		return { error: "Expected a JSON object with x and y, or resolved" };
	}
	const { x, y, resolved } = body as Record<string, unknown>;
	const patch: CommentPatch = {};
	if (x !== undefined || y !== undefined) {
		if (!isCoordinate(x) || !isCoordinate(y)) {
			return { error: "x and y must be finite board coordinates together" };
		}
		Object.assign(patch, { x, y });
	}
	if (resolved !== undefined) {
		if (typeof resolved !== "boolean") {
			return { error: "resolved must be a boolean" };
		}
		patch.resolved = resolved;
	}
	return Object.keys(patch).length > 0 ? patch : { error: "Nothing to change" };
};

const parseEvent = (value: unknown): CommentEvent | null => {
	if (typeof value !== "object" || value === null) return null;
	const event = value as Record<string, unknown>;
	const { kind, at, text } = event;
	if (typeof kind !== "string" || !eventKinds.has(kind)) return null;
	if (!isTime(at) || typeof text !== "string") return null;
	const shown = text.slice(0, maxEventText);
	if (kind !== "action") {
		return { kind, at, text: shown } as CommentEvent;
	}
	const { id, state } = event;
	if (typeof id !== "string" || typeof state !== "string") return null;
	if (!actionStates.has(state)) return null;
	return {
		kind,
		at,
		id: id.slice(0, 128),
		text: shown,
		state: state === "running" ? "failed" : (state as "done" | "failed"),
	};
};

const parseThread = (value: unknown): CommentThread | null => {
	if (typeof value !== "object" || value === null) return null;
	const fields = value as Record<string, unknown>;
	const { id, x, y, createdAt, updatedAt, resolved, sessionId, resumable } =
		fields;
	if (typeof id !== "string" || !threadIdPattern.test(id)) return null;
	if (!isCoordinate(x) || !isCoordinate(y)) return null;
	if (!isTime(createdAt) || !isTime(updatedAt)) return null;
	if (typeof sessionId !== "string" || !sessionIdPattern.test(sessionId)) {
		return null;
	}
	const events = Array.isArray(fields.events)
		? fields.events.flatMap((raw) => parseEvent(raw) ?? []).slice(-maxEvents)
		: [];
	return {
		id,
		x,
		y,
		...(isAgentButton(fields.button) ? { button: fields.button } : {}),
		createdAt,
		updatedAt,
		resolved: resolved === true,
		running: false,
		sessionId,
		resumable: resumable === true,
		events,
	};
};

export const parseComments = (value: unknown): CommentThread[] => {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value
		.flatMap((raw) => {
			const thread = parseThread(raw);
			if (!thread || seen.has(thread.id)) return [];
			seen.add(thread.id);
			return [thread];
		})
		.slice(-maxThreads);
};

export const loadComments = (file: string): Promise<CommentThread[]> =>
	readState(file, parseComments);

const bounded = (thread: CommentThread): CommentThread =>
	thread.events.length <= maxEvents
		? thread
		: { ...thread, events: thread.events.slice(-maxEvents) };

export const createCommentStore = ({
	file,
	initial,
	onChange,
	onRemove,
	newId = randomUUID,
	now = Date.now,
}: CommentStoreOptions): CommentStore => {
	let threads = [...initial];
	const stored = createStateFile<CommentThread[]>(file);

	const save = (next: CommentThread[]) => {
		threads = next;
		stored.write(threads);
	};

	return {
		current: () => threads,
		get: (id) => threads.find((thread) => thread.id === id) ?? null,
		create(draft) {
			if (threads.length >= maxThreads) return null;
			const at = now();
			const thread: CommentThread = {
				id: newId(),
				x: draft.x,
				y: draft.y,
				...(draft.button ? { button: draft.button } : {}),
				createdAt: at,
				updatedAt: at,
				resolved: false,
				running: false,
				sessionId: randomUUID(),
				resumable: false,
				events: [],
			};
			save([...threads, thread]);
			onChange(thread);
			return thread;
		},
		update(id, change) {
			const existing = threads.find((thread) => thread.id === id);
			if (!existing) return null;
			const updated = bounded({ ...change(existing), id, updatedAt: now() });
			save(threads.map((thread) => (thread.id === id ? updated : thread)));
			onChange(updated);
			return updated;
		},
		remove(id) {
			if (!threads.some((thread) => thread.id === id)) return false;
			save(threads.filter((thread) => thread.id !== id));
			onRemove(threads);
			return true;
		},
		owns: (sessionId) =>
			threads.some((thread) => thread.sessionId === sessionId),
		saved: stored.saved,
	};
};
