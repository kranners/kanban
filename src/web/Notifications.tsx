import {
	CheckCheck,
	CircleCheck,
	CircleX,
	Inbox,
	Mail,
	MailOpen,
	TriangleAlert,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import "./notifications.css";
import { moveMenuFocus } from "./menuFocus.ts";
import {
	notifications,
	notificationsOpen,
	openNotification,
	unreadNotifications,
	updateNotifications,
} from "./notificationState.ts";
import { now } from "./state.ts";
import { ago } from "./time.ts";

const kindIcon = {
	needs: TriangleAlert,
	finished: CircleCheck,
	failed: CircleX,
};

function NotificationList(props: { onClose: () => void }): JSX.Element {
	const all = notifications.value.toSorted((a, b) => b.at - a.at);
	const at = now.value;
	const unread = all.filter((n) => !n.read).map((n) => n.id);
	const read = all.filter((n) => n.read).map((n) => n.id);
	const list = useRef<HTMLDivElement>(null);

	useEffect(() => {
		list.current
			?.querySelector<HTMLElement>("[role=menuitem]")
			?.focus({ preventScroll: true });
	}, []);

	return (
		<div
			class="notifications-panel"
			role="dialog"
			aria-label="Notifications"
			data-no-pan
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					props.onClose();
				} else if (list.current) moveMenuFocus(list.current, event);
			}}
		>
			<header class="notifications-head">
				<span class="notifications-heading">Notifications</span>
				<button
					type="button"
					class="notifications-bulk"
					disabled={unread.length === 0}
					onClick={() => void updateNotifications("read", unread)}
					title="Mark every notification as read"
				>
					<CheckCheck size={13} aria-hidden="true" />
					Mark all read
				</button>
				<button
					type="button"
					class="notifications-bulk"
					disabled={read.length === 0}
					onClick={() => void updateNotifications("dismiss", read)}
					title="Dismiss every notification you have read"
				>
					Clear read
				</button>
			</header>
			{all.length === 0 ? (
				<p class="notifications-empty">
					Nothing new. Sessions that need you, finish or fail show up here until
					you look at them.
				</p>
			) : (
				<div class="notifications-list" ref={list}>
					{all.map((n) => {
						const Icon = kindIcon[n.kind];
						return (
							<div
								key={n.id}
								class={`notification notification-${n.kind}${n.read ? " read" : ""}`}
							>
								<button
									type="button"
									role="menuitem"
									class="notification-open"
									onClick={() => openNotification(n)}
									title="Open this session"
								>
									<Icon
										class="notification-icon"
										size={15}
										strokeWidth={2.25}
										aria-hidden="true"
									/>
									<span class="notification-text">
										<span class="notification-title">
											{!n.read && (
												<span class="notification-unread">
													<span class="visually-hidden">Unread: </span>
												</span>
											)}
											{n.title}
										</span>
										<span class="notification-body">{n.body}</span>
									</span>
									<time
										class="notification-at num"
										dateTime={new Date(n.at).toISOString()}
										title={new Date(n.at).toLocaleString()}
									>
										{ago(n.at, at)}
									</time>
								</button>
								<button
									type="button"
									class="icon-button notification-action"
									onClick={() =>
										void updateNotifications(n.read ? "unread" : "read", [n.id])
									}
									aria-label={n.read ? "Mark as unread" : "Mark as read"}
									title={n.read ? "Mark as unread" : "Mark as read"}
								>
									{n.read ? <Mail size={14} /> : <MailOpen size={14} />}
								</button>
								<button
									type="button"
									class="icon-button notification-action"
									onClick={() => void updateNotifications("dismiss", [n.id])}
									aria-label="Dismiss"
									title="Dismiss"
								>
									<X size={14} />
								</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

export function NotificationsMenu(): JSX.Element {
	const open = notificationsOpen.value;
	const count = unreadNotifications.value;
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		const closeOutside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node))
				notificationsOpen.value = false;
		};
		addEventListener("pointerdown", closeOutside, true);
		return () => removeEventListener("pointerdown", closeOutside, true);
	}, [open]);

	const label =
		count > 0 ? `Notifications, ${count} unread` : "Notifications, none unread";

	return (
		<div class="notifications-menu" ref={root}>
			<button
				type="button"
				ref={trigger}
				class={`icon-button notifications-trigger${count > 0 ? " unread" : ""}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={label}
				title={label}
				onClick={() => {
					notificationsOpen.value = !open;
				}}
			>
				<Inbox size={16} />
				{count > 0 && (
					<span class="notifications-count num" aria-hidden="true">
						{count > 9 ? "9+" : count}
					</span>
				)}
			</button>
			{open && (
				<NotificationList
					onClose={() => {
						notificationsOpen.value = false;
						trigger.current?.focus({ preventScroll: true });
					}}
				/>
			)}
		</div>
	);
}
