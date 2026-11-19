import { signal } from "@preact/signals";
import { X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { StatusReport } from "../shared/types.ts";
import { ReportDashboard } from "./reportDashboard.tsx";
import { useRestoreFocus } from "./restoreFocus.ts";
import { relativeTime } from "./time.ts";

export {
	compact,
	durationText,
	ReportDashboard,
	ReportHeader,
	ReportTimeline,
	totalsOf,
} from "./reportDashboard.tsx";

export const openReport = signal<string | null>(null);

export function ReportModal(props: {
	report: StatusReport | null;
	onClose: () => void;
}): JSX.Element | null {
	const dialog = useRef<HTMLDialogElement>(null);
	const open = props.report !== null;
	useRestoreFocus(open);
	useEffect(() => {
		if (open) dialog.current?.showModal();
	}, [open]);
	if (!props.report) return null;
	const age = relativeTime(props.report.at, Date.now());
	return (
		<dialog
			class="report-modal"
			ref={dialog}
			onClose={props.onClose}
			onKeyDown={(event) => {
				if (event.key === "Escape") event.stopPropagation();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) props.onClose();
			}}
			aria-label={`Status report for ${props.report.title}`}
		>
			<div class="report-modal-body">
				<button
					type="button"
					class="report-close"
					aria-label="Close the status report"
					onClick={props.onClose}
				>
					<X size={16} aria-hidden="true" />
				</button>
				<ReportDashboard report={props.report} />
				<p class="report-age">
					Reported {age === "now" ? "just now" : `${age} ago`}
				</p>
			</div>
		</dialog>
	);
}
