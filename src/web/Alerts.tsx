import {
	Bell,
	BellOff,
	BellRing,
	CircleCheck,
	CircleX,
	TriangleAlert,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import "./alerts.css";
import {
	answerToast,
	dismissToast,
	notifying,
	permission,
	shown,
	toasts,
	toggleNotifications,
} from "./alertState.ts";
import { alertBody, alertKind, alertTitle } from "./alerts.ts";

const toastIcon = {
	needs: TriangleAlert,
	finished: CircleCheck,
	failed: CircleX,
};

const bellLabel = {
	default: "Turn on notifications when a session needs you or finishes",
	granted: "Notifications are on; turn them off",
	off: "Notifications are off; turn them on",
	denied: "Notifications are blocked in this browser's site settings",
};

export function NotifyToggle(): JSX.Element | null {
	const state = permission.value;
	if (state === "unsupported") return null;
	const on = notifying.value;
	const label =
		state === "granted" ? bellLabel[on ? "granted" : "off"] : bellLabel[state];
	const Icon = state === "default" ? BellRing : on ? Bell : BellOff;
	return (
		<button
			type="button"
			class={`icon-button notify-toggle${state === "default" ? " asking" : ""}`}
			disabled={state === "denied"}
			aria-pressed={state === "granted" ? on : undefined}
			onClick={toggleNotifications}
			aria-label={label}
			title={label}
		>
			<Icon size={16} />
		</button>
	);
}

export function AlertToasts(): JSX.Element {
	const all = toasts.value;
	const visible = shown.value;
	const hidden = all.length - visible.length;
	return (
		<section class="alert-toasts" aria-live="polite" aria-label="Alerts">
			{visible.map((session) => {
				const kind = alertKind(session) ?? "needs";
				const Icon = toastIcon[kind];
				return (
					<div key={session.id} class={`alert-toast ${kind}`} data-no-pan>
						<Icon
							class="alert-toast-icon"
							size={16}
							strokeWidth={2.25}
							aria-hidden="true"
						/>
						<button
							type="button"
							class="alert-toast-open"
							onClick={() => answerToast(session.id)}
							title="Open this session"
						>
							<span class="alert-toast-title">{alertTitle(session)}</span>
							<span class="alert-toast-body">{alertBody(session)}</span>
						</button>
						<button
							type="button"
							class="icon-button alert-toast-close"
							onClick={() => dismissToast(session.id)}
							aria-label={`Dismiss ${session.name}`}
							title="Dismiss"
						>
							<X size={14} />
						</button>
					</div>
				);
			})}
			{hidden > 0 && <p class="alert-toast-more">{hidden} more</p>}
		</section>
	);
}
