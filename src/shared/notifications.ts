import type { Activity, Session } from "./types.ts";

export type AlertKind = "needs" | "finished" | "failed";

/** What a session's current activity would alert as, if it alerts at all. */
export function alertKind(session: Session): AlertKind | null {
	switch (session.activity) {
		case "needs-you":
			return "needs";
		case "idle":
		case "done":
			return "finished";
		case "failed":
			return "failed";
		default:
			return null;
	}
}

export function alertTitle(session: Session): string {
	const kind = alertKind(session);
	if (kind === "finished") return `${session.name} finished`;
	if (kind === "failed") return `${session.name} failed`;
	return `${session.name} needs you`;
}

export function alertBody(session: Session): string {
	return session.needs ?? session.doing ?? session.project;
}

export type SeenActivities = ReadonlyMap<string, Activity>;

export function seenActivities(sessions: readonly Session[]): SeenActivities {
	return new Map(sessions.map((s) => [s.id, s.activity]));
}

/** Sessions that just started needing you. */
export function summoned(
	previous: SeenActivities | null,
	sessions: readonly Session[],
): Session[] {
	if (!previous) return [];
	return sessions.filter(
		(s) => s.activity === "needs-you" && previous.get(s.id) !== "needs-you",
	);
}

const busy = new Set<Activity>(["working", "watching"]);

/** Sessions that just stopped working, so they have a response to read. */
export function finished(
	previous: SeenActivities | null,
	sessions: readonly Session[],
): Session[] {
	if (!previous) return [];
	return sessions.filter((s) => {
		const kind = alertKind(s);
		const before = previous.get(s.id);
		return (
			(kind === "finished" || kind === "failed") &&
			before !== undefined &&
			busy.has(before)
		);
	});
}

/** Sessions that just raised an alert: they need you, finished or failed. */
export function alerting(
	previous: SeenActivities | null,
	sessions: readonly Session[],
): Session[] {
	return [...summoned(previous, sessions), ...finished(previous, sessions)];
}

/** An alert kept in the notifications menu until it is dismissed. */
export type BoardNotification = {
	id: string;
	sessionId: string;
	kind: AlertKind;
	title: string;
	body: string;
	at: number;
	read: boolean;
};

export type NotificationAction = "read" | "unread" | "dismiss";

export type NotificationUpdate = {
	action: NotificationAction;
	ids: string[];
};

export const notificationActions: readonly NotificationAction[] = [
	"read",
	"unread",
	"dismiss",
];

/** The notifications after an update; the same list when nothing changed. */
export function applyNotificationUpdate(
	notifications: BoardNotification[],
	{ action, ids }: NotificationUpdate,
): BoardNotification[] {
	const chosen = new Set(ids);
	if (action === "dismiss") {
		const kept = notifications.filter((n) => !chosen.has(n.id));
		return kept.length === notifications.length ? notifications : kept;
	}
	const read = action === "read";
	let changed = false;
	const next = notifications.map((n) => {
		if (!chosen.has(n.id) || n.read === read) return n;
		changed = true;
		return { ...n, read };
	});
	return changed ? next : notifications;
}

/** Unread notifications for a session, which looking at it reads. */
export const unreadFor = (
	notifications: readonly BoardNotification[],
	sessionId: string,
): string[] =>
	notifications.flatMap((n) =>
		n.sessionId === sessionId && !n.read ? [n.id] : [],
	);

export const unreadCount = (notifications: readonly BoardNotification[]) =>
	notifications.reduce((count, n) => count + (n.read ? 0 : 1), 0);
