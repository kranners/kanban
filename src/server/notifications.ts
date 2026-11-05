import { randomUUID } from "node:crypto";
import {
	type AlertKind,
	alertBody,
	alerting,
	alertKind,
	alertTitle,
	applyNotificationUpdate,
	type BoardNotification,
	type NotificationUpdate,
	notificationActions,
	type SeenActivities,
	seenActivities,
} from "../shared/notifications.ts";
import type { Board, Session } from "../shared/types.ts";
import { createStateFile, readState } from "./stateFile.ts";

export type NotificationStore = {
	current(): BoardNotification[];
	/** Raises a notification for each session that just needs you, finished or failed. */
	observe(board: Board): void;
	update(update: NotificationUpdate): void;
	/** Raises a notification of the board's own, such as an account failover. */
	raise(sessionId: string, title: string, body: string): void;
	saved(): Promise<void>;
};

export type NotificationStoreOptions = {
	file: string;
	initial: BoardNotification[];
	now: () => number;
	/** Whether a session's project is ignored, so it raises nothing. */
	ignored?: (session: Session) => boolean;
	onChange: (notifications: BoardNotification[]) => void;
};

export const maxNotifications = 100;
/** Read notifications older than this are let go; unread ones stay until dismissed. */
export const keepReadMs = 7 * 24 * 60 * 60 * 1000;
const maxIds = 200;
const maxText = 2000;

const kinds = new Set<AlertKind>(["needs", "finished", "failed"]);

const isId = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 200;

const text = (value: unknown): string | null =>
	typeof value === "string" ? value.slice(0, maxText) : null;

const parseNotification = (value: unknown): BoardNotification | null => {
	if (typeof value !== "object" || value === null) return null;
	const { id, sessionId, kind, title, body, at, read } = value as Record<
		string,
		unknown
	>;
	const shownTitle = text(title);
	const shownBody = text(body);
	if (
		!isId(id) ||
		!isId(sessionId) ||
		!kinds.has(kind as AlertKind) ||
		shownTitle === null ||
		shownBody === null ||
		typeof at !== "number" ||
		!Number.isSafeInteger(at) ||
		typeof read !== "boolean"
	)
		return null;
	return {
		id,
		sessionId,
		kind: kind as AlertKind,
		title: shownTitle,
		body: shownBody,
		at,
		read,
	};
};

export const parseNotifications = (value: unknown): BoardNotification[] =>
	Array.isArray(value)
		? value
				.flatMap((entry) => {
					const parsed = parseNotification(entry);
					return parsed ? [parsed] : [];
				})
				.slice(0, maxNotifications)
		: [];

export const loadNotifications = (file: string): Promise<BoardNotification[]> =>
	readState(file, parseNotifications);

export const parseNotificationUpdate = (
	body: unknown,
): NotificationUpdate | { error: string } => {
	if (typeof body !== "object" || body === null)
		return { error: "Expected a JSON object with action and ids" };
	const { action, ids } = body as Record<string, unknown>;
	if (!notificationActions.includes(action as NotificationUpdate["action"]))
		return { error: "action must be read, unread or dismiss" };
	if (!Array.isArray(ids) || ids.length > maxIds || !ids.every(isId))
		return { error: `ids must be a list of at most ${maxIds} ids` };
	return { action: action as NotificationUpdate["action"], ids };
};

const fresh = (
	notifications: BoardNotification[],
	at: number,
): BoardNotification[] =>
	notifications.filter((n) => !n.read || at - n.at < keepReadMs);

export const createNotificationStore = ({
	file,
	initial,
	now,
	ignored = () => false,
	onChange,
}: NotificationStoreOptions): NotificationStore => {
	let notifications = fresh(initial, now());
	let seen: SeenActivities | null = null;
	const stored = createStateFile<BoardNotification[]>(file);

	const set = (next: BoardNotification[]) => {
		notifications = next;
		stored.write(notifications);
		onChange(notifications);
	};

	return {
		current: () => notifications,
		observe(board) {
			const raised = alerting(seen, board.sessions).filter((s) => !ignored(s));
			seen = seenActivities(board.sessions);
			if (raised.length === 0) return;
			const at = now();
			const added = raised.flatMap((session): BoardNotification[] => {
				const kind = alertKind(session);
				if (!kind) return [];
				return [
					{
						id: randomUUID(),
						sessionId: session.id,
						kind,
						title: alertTitle(session).slice(0, maxText),
						body: alertBody(session).slice(0, maxText),
						at,
						read: false,
					},
				];
			});
			// A session keeps only its latest notification, so the menu lists
			// each session once with what it last did.
			const replaced = new Set(added.map((n) => n.sessionId));
			set(
				[
					...added,
					...fresh(notifications, at).filter((n) => !replaced.has(n.sessionId)),
				].slice(0, maxNotifications),
			);
		},
		raise(sessionId, title, body) {
			const at = now();
			set(
				[
					{
						id: randomUUID(),
						sessionId,
						kind: "failed" as const,
						title: title.slice(0, maxText),
						body: body.slice(0, maxText),
						at,
						read: false,
					},
					...fresh(notifications, at),
				].slice(0, maxNotifications),
			);
		},
		update(update) {
			const next = applyNotificationUpdate(notifications, update);
			if (next !== notifications) set(next);
		},
		saved: stored.saved,
	};
};
