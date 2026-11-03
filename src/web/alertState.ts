import { computed, effect, signal } from "@preact/signals";
import type { Session } from "../shared/types.ts";
import type { SeenActivities } from "./alerts.ts";
import {
	alertBody,
	faviconFor,
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

const raised = signal<readonly string[]>([]);

export const toasts = computed(() => {
	const waiting = new Map(needingSessions.value.map((s) => [s.id, s]));
	return raised.value.flatMap((id) => {
		const session = waiting.get(id);
		return session ? [session] : [];
	});
});

export const shown = computed(() => toasts.value.slice(0, shownToasts));

export function dismissToast(id: string): void {
	raised.value = raised.value.filter((raisedId) => raisedId !== id);
}

export function answerToast(id: string): void {
	dismissToast(id);
	openSession(id);
}

const open = new Map<string, Notification>();

function lookingAtBoard(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

function notify(session: Session): void {
	let notification: Notification;
	try {
		notification = new Notification(`${session.name} needs you`, {
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
		if (open.get(session.id) === notification) open.delete(session.id);
	};
	open.set(session.id, notification);
}

let seen: SeenActivities | null = null;

effect(() => {
	const current = board.value;
	if (!current) return;
	const ignored = ignoredSessions.peek();
	const fresh = summoned(seen, current.sessions).filter(
		(s) => !ignored.has(s.id),
	);
	seen = seenActivities(current.sessions);
	const viewing = focusedSessionId.peek();
	const watched = lookingAtBoard();
	const called = fresh.filter((s) => !(watched && s.id === viewing));
	if (called.length > 0) {
		const ids = new Set(called.map((s) => s.id));
		raised.value = [
			...called.map((s) => s.id),
			...raised.peek().filter((id) => !ids.has(id)),
		];
	}
	if (notifying.peek() && !watched) for (const s of called) notify(s);
});

effect(() => {
	const waiting = new Set(needingSessions.value.map((s) => s.id));
	for (const [id, notification] of open)
		if (!waiting.has(id)) notification.close();
	raised.value = raised.peek().filter((id) => waiting.has(id));
});

effect(() => {
	const viewing = focusedSessionId.value;
	if (viewing && raised.peek().includes(viewing)) dismissToast(viewing);
});

const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');

effect(() => {
	const count = needingSessions.value.length;
	document.title = titleFor(count);
	icon?.setAttribute("href", faviconFor(count));
});

addEventListener("focus", () => {
	for (const notification of open.values()) notification.close();
	if (permission.peek() !== "unsupported")
		permission.value = Notification.permission;
	const viewing = focusedSessionId.peek();
	if (viewing) dismissToast(viewing);
});
