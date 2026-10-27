import "./actions.css";
import { CircleAlert, LoaderCircle, X } from "lucide-preact";
import type { JSX } from "preact";
import type { Session } from "../shared/types.ts";
import { dismissReport, type ReportState, requestReport } from "./reports.ts";

export function AskButton(props: {
	subject: string;
	title: string;
	asking: boolean;
	disabled?: boolean;
	onAsk: () => void;
}): JSX.Element {
	const { asking } = props;
	return (
		<button
			type="button"
			class={`close-bubble report-bubble${asking ? " asking" : ""}`}
			aria-label={`${asking ? "Asking" : "Ask"} ${props.subject} for a status report`}
			title={props.title}
			disabled={asking || props.disabled}
			data-no-pan
			onClick={props.onAsk}
		>
			{asking ? (
				<LoaderCircle size={13} class="focus-spin" aria-hidden="true" />
			) : (
				<span class="report-mark" aria-hidden="true">
					?
				</span>
			)}
		</button>
	);
}

export function ReportFailure(props: {
	title: string;
	error: string;
	class?: string;
	onDismiss: () => void;
}): JSX.Element {
	return (
		<div
			class={`exit-notice refused ${props.class ?? ""}`}
			role="alert"
			data-no-pan
		>
			<CircleAlert size={14} class="exit-notice-alert" aria-hidden="true" />
			<div class="exit-notice-text">
				<strong>{props.title}</strong>
				<p>{props.error}</p>
			</div>
			<button
				type="button"
				class="exit-notice-dismiss"
				onClick={props.onDismiss}
				aria-label="Dismiss"
			>
				<X size={13} aria-hidden="true" />
			</button>
		</div>
	);
}

export function ReportButton(props: {
	session: Session;
	state: ReportState | undefined;
}): JSX.Element {
	return (
		<AskButton
			subject={props.session.name}
			title="Ask for a status report"
			asking={props.state?.phase === "asking"}
			onAsk={() => void requestReport(props.session.id)}
		/>
	);
}

export function ReportNotice(props: {
	session: Session;
	state: ReportState | undefined;
}): JSX.Element | null {
	const { state } = props;
	if (state?.phase !== "failed") return null;
	return (
		<ReportFailure
			title="Couldn't get a status report"
			error={state.error}
			onDismiss={() => dismissReport(props.session.id)}
		/>
	);
}
