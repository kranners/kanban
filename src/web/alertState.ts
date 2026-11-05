import { computed, effect, signal } from "@preact/signals";
import type { Session } from "../shared/types.ts";
import type { AlertKind, SeenActivities } from "./alerts.ts";
import {
	alertBody,
	alertKind,
	alertTitle,
	favicon,
	finished,
	seenActivities,
	summoned,
	titleFor,
} from "./alerts.ts";
import { ignoredSessions } from "./ignoreState.ts";
import { board, focusedSessionId, openSession } from "./state.ts";

const preferenceKey = "kanban.notifications";
const shownToasts = 3;

export type NotifyPermission = NotificationPermission | "unsupported";

const supported = typeof Notification !== "undefined";

export const permission = signal<NotifyPermission>(
	supported ? Notification.permission : "unsupported",
);

function readPreference(): boolean {
	try {
		return localStorage.getItem(preferenceKey) !== "off";
	} catch {
		return true;
	}
}

const preferred = signal(readPreference());

export const notifying = computed(
	() => permission.value === "granted" && preferred.value,
);

export async function toggleNotifications(): Promise<void> {
	if (permission.value === "default") {
		permission.value = await Notification.requestPermission();
		preferred.value = true;
	} else if (permission.value === "granted") {
		preferred.value = !preferred.value;
	}
	try {
		localStorage.setItem(preferenceKey, preferred.value ? "on" : "off");
	} catch {}
}

export const needingSessions = computed(() => {
	const ignored = ignoredSessions.value;
	return (board.value?.sessions ?? []).filter(
		(s) => s.activity === "needs-you" && !ignored.has(s.id),
	);
});

type Raised = { id: string; kind: AlertKind };

const raised = signal<readonly Raised[]>([]);

/** The board's sessions by id, leaving out ignored ones. */
const standing = computed(() => {
	const ignored = ignoredSessions.value;
	const byId = new Map<string, Session>();
	for (const s of board.value?.sessions ?? [])
		if (!ignored.has(s.id)) byId.set(s.id, s);
	return byId;
});

function stillStanding(entry: Raised, byId: Map<string, Session>): boolean {
	const session = byId.get(entry.id);
	return session !== undefined && alertKind(session) === entry.kind;
}

export const toasts = computed(() => {
	const byId = standing.value;
	return raised.value.flatMap((entry) => {
		const session = byId.get(entry.id);
		return session && stillStanding(entry, byId) ? [session] : [];
	});
});

export const shown = computed(() => toasts.value.slice(0, shownToasts));

export function dismissToast(id: string): void {
	raised.value = raised.value.filter((entry) => entry.id !== id);
}

export function answerToast(id: string): void {
	dismissToast(id);
	openSession(id);
}

const open = new Map<string, { kind: AlertKind; notification: Notification }>();

function lookingAtBoard(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

function notify(session: Session, kind: AlertKind): void {
	let notification: Notification;
	try {
		notification = new Notification(alertTitle(session), {
			body: alertBody(session),
			tag: session.id,
		});
	} catch {
		permission.value = "unsupported";
		return;
	}
	notification.onclick = () => {
		focus();
		answerToast(session.id);
		notification.close();
	};
	notification.onclose = () => {
		if (open.get(session.id)?.notification === notification)
			open.delete(session.id);
	};
	open.set(session.id, { kind, notification });
}

let seen: SeenActivities | null = null;

effect(() => {
	const current = board.value;
	if (!current) return;
	const ignored = ignoredSessions.peek();
	const fresh = [
		...summoned(seen, current.sessions),
		...finished(seen, current.sessions),
	].filter((s) => !ignored.has(s.id));
	seen = seenActivities(current.sessions);
	const viewing = focusedSessionId.peek();
	const watched = lookingAtBoard();
	const called = fresh.filter((s) => !(watched && s.id === viewing));
	if (called.length > 0) {
		const ids = new Set(called.map((s) => s.id));
		raised.value = [
			...called.flatMap((s) => {
				const kind = alertKind(s);
				return kind ? [{ id: s.id, kind }] : [];
			}),
			...raised.peek().filter((entry) => !ids.has(entry.id)),
		];
	}
	if (notifying.peek() && !watched)
		for (const s of called) {
			const kind = alertKind(s);
			if (kind) notify(s, kind);
		}
});

effect(() => {
	const byId = standing.value;
	for (const [id, { kind, notification }] of open)
		if (!stillStanding({ id, kind }, byId)) notification.close();
	raised.value = raised.peek().filter((entry) => stillStanding(entry, byId));
});

effect(() => {
	const viewing = focusedSessionId.value;
	if (viewing && raised.peek().some((entry) => entry.id === viewing))
		dismissToast(viewing);
});

const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
const showFavicon =
	icon &&
	favicon(icon, (src) => {
		const image = new Image();
		image.src = src;
		return image.decode();
	});

effect(() => {
	const count = needingSessions.value.length;
	document.title = titleFor(count);
	void showFavicon?.(count);
});

addEventListener("focus", () => {
	for (const { notification } of open.values()) notification.close();
	if (permission.peek() !== "unsupported")
		permission.value = Notification.permission;
	const viewing = focusedSessionId.peek();
	if (viewing) dismissToast(viewing);
});
