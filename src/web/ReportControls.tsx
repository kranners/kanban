import "./actions.css";
import { CircleAlert, LoaderCircle, X } from "lucide-preact";
import type { JSX } from "preact";
import type { Session } from "../shared/types.ts";
import { dismissReport, type ReportState, requestReport } from "./reports.ts";

export function ReportButton(props: {
	session: Session;
	state: ReportState | undefined;
}): JSX.Element {
	const asking = props.state?.phase === "asking";
	return (
		<button
			type="button"
			class={`close-bubble report-bubble${asking ? " asking" : ""}`}
			aria-label={
				asking
					? `Asking ${props.session.name} for a status report`
					: `Ask ${props.session.name} for a status report`
			}
			title="Ask for a status report"
			disabled={asking}
			data-no-pan
			onClick={() => void requestReport(props.session.id)}
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

export function ReportNotice(props: {
	session: Session;
	state: ReportState | undefined;
}): JSX.Element | null {
	const { state } = props;
	if (state?.phase !== "failed") return null;
	return (
		<div class="exit-notice refused" role="alert" data-no-pan>
			<CircleAlert size={14} class="exit-notice-alert" aria-hidden="true" />
			<div class="exit-notice-text">
				<strong>Couldn't get a status report</strong>
				<p>{state.error}</p>
			</div>
			<button
				type="button"
				class="exit-notice-dismiss"
				onClick={() => dismissReport(props.session.id)}
				aria-label="Dismiss"
			>
				<X size={13} aria-hidden="true" />
			</button>
		</div>
	);
}
