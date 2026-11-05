import { computed, effect, signal } from "@preact/signals";
import {
	applyNotificationUpdate,
	type BoardNotification,
	type NotificationAction,
	unreadCount,
	unreadFor,
} from "../shared/notifications.ts";
import { focusedSessionId, openSession } from "./state.ts";

export const notifications = signal<BoardNotification[]>([]);
export const notificationsOpen = signal(false);

export const unreadNotifications = computed(() =>
	unreadCount(notifications.value),
);

export function receiveNotifications(next: BoardNotification[]): void {
	notifications.value = next;
}

/** Applies a change here at once, then tells the board; its next frame settles it. */
export async function updateNotifications(
	action: NotificationAction,
	ids: string[],
): Promise<void> {
	if (ids.length === 0) return;
	notifications.value = applyNotificationUpdate(notifications.peek(), {
		action,
		ids,
	});
	try {
		await fetch("/api/notifications", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, ids }),
		});
	} catch {}
}

export function openNotification(notification: BoardNotification): void {
	notificationsOpen.value = false;
	void updateNotifications("read", [notification.id]);
	openSession(notification.sessionId);
}

function lookingAtBoard(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

/** Reads a session's notifications once it is open in front of you. */
function readWhatYouSee(): void {
	const viewing = focusedSessionId.peek();
	if (!viewing || !lookingAtBoard()) return;
	void updateNotifications("read", unreadFor(notifications.peek(), viewing));
}

effect(() => {
	focusedSessionId.value;
	notifications.value;
	readWhatYouSee();
});

addEventListener("focus", readWhatYouSee);
document.addEventListener("visibilitychange", readWhatYouSee);
