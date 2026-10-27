import "./actions.css";
import { X } from "lucide-preact";
import type { JSX } from "preact";
import type { Session } from "../shared/types.ts";
import { exitTitle } from "./ExitControls.tsx";
import { departing } from "./exitState.ts";
import { askToExitProject, exitSessions, held } from "./exits.ts";
import type { Group } from "./groups.ts";
import { nodeKey } from "./layout.ts";
import { AskButton, ReportFailure } from "./ReportControls.tsx";
import {
	dismissReport,
	regionReportKey,
	reports,
	requestRegionReport,
} from "./reports.ts";
import { board } from "./state.ts";

function sessionsIn(group: Group): Session[] {
	const members = new Set(group.members);
	const gone = departing.value;
	return (board.value?.sessions ?? []).filter(
		(session) =>
			members.has(nodeKey({ kind: "session", id: session.id })) &&
			!gone.has(session.id),
	);
}

function ExitProjectButton(props: {
	project: string;
	sessions: Session[];
}): JSX.Element {
	const { project, sessions } = props;
	const { shift: force, option: skipAsking } = held.value;
	const exit = (event: MouseEvent) => {
		const now = held.peek();
		const forced = event.shiftKey || now.shift;
		if (event.altKey || now.option) void exitSessions(sessions, forced);
		else askToExitProject(project, sessions, forced);
	};
	return (
		<button
			type="button"
			class={`close-bubble${force ? " force" : ""}`}
			aria-label={`${force ? "Force exit" : "Exit"} every session in ${project}`}
			title={
				sessions.length === 0
					? "No sessions in this project to exit"
					: exitTitle(force, skipAsking, "every session in this project")
			}
			disabled={sessions.length === 0}
			data-no-pan
			onClick={exit}
		>
			<X size={13} strokeWidth={2.5} aria-hidden="true" />
		</button>
	);
}

export function RegionControls(props: { group: Group }): JSX.Element | null {
	const { group } = props;
	const { region } = group;
	if (!region) return null;
	const sessions = sessionsIn(group);
	const empty = sessions.length === 0;
	return (
		<div class="region-corner">
			<AskButton
				subject={`every session in ${group.project}`}
				title={
					empty
						? "No sessions in this project to ask"
						: "Ask every session in this project for a status report"
				}
				asking={
					reports.value.get(regionReportKey(region.id))?.phase === "asking"
				}
				disabled={empty}
				onAsk={() => void requestRegionReport(region.id)}
			/>
			<ExitProjectButton project={group.project} sessions={sessions} />
		</div>
	);
}

export function RegionNotices(props: {
	groups: readonly Group[];
}): JSX.Element {
	return (
		<>
			{props.groups.map(({ region, frame }) => {
				if (!region) return null;
				const key = regionReportKey(region.id);
				const state = reports.value.get(key);
				if (state?.phase !== "failed") return null;
				return (
					<div
						key={key}
						class="region-notice-anchor"
						style={{
							transform: `translate(${frame.x}px, ${frame.y}px)`,
							width: `${frame.w}px`,
						}}
					>
						<ReportFailure
							title="Couldn't get a project status report"
							error={state.error}
							class="region-notice"
							onDismiss={() => dismissReport(key)}
						/>
					</div>
				);
			})}
		</>
	);
}
