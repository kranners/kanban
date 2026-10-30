import "./actions.css";
import { X } from "lucide-preact";
import type { JSX } from "preact";
import type { Session } from "../shared/types.ts";
import { exitTitle } from "./ExitControls.tsx";
import { departing } from "./exitState.ts";
import { askToExitProject, exitSessions, held } from "./exits.ts";
import type { Group } from "./groups.ts";
import { IgnoreButton } from "./IgnoreControls.tsx";
import { nodeKey } from "./layout.ts";
import { AskButton, ReportFailure } from "./ReportControls.tsx";
import { createRegion, deleteRegion } from "./regionState.ts";
import { storableRegion } from "./regions.ts";
import {
	dismissReport,
	failReport,
	projectReportKey,
	reports,
	requestRegionReport,
} from "./reports.ts";
import { board } from "./state.ts";

export function sessionsIn(group: Group): Session[] {
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
			title={exitTitle(force, skipAsking, "every session in this project")}
			data-no-pan
			onClick={exit}
		>
			<X size={13} strokeWidth={2.5} aria-hidden="true" />
		</button>
	);
}

function CloseProjectButton(props: {
	project: string;
	regionId: string;
}): JSX.Element {
	return (
		<button
			type="button"
			class="close-bubble"
			aria-label={`Close ${props.project}`}
			title="Close this project"
			data-no-pan
			onClick={() => void deleteRegion(props.regionId)}
		>
			<X size={13} strokeWidth={2.5} aria-hidden="true" />
		</button>
	);
}

async function askProject(group: Group): Promise<void> {
	if (group.region) return requestRegionReport(group.region.id);
	const pinned = await createRegion({
		cwd: group.cwd,
		...storableRegion(group.frame),
	});
	if (pinned.ok) return requestRegionReport(pinned.value.id);
	failReport(
		group.key,
		`Couldn't save this project as a region: ${pinned.error}`,
	);
}

export function RegionControls(props: { group: Group }): JSX.Element {
	const { group } = props;
	const sessions = sessionsIn(group);
	const empty = sessions.length === 0;
	return (
		<div class="region-corner">
			<IgnoreButton group={group} />
			<AskButton
				subject={`every session in ${group.project}`}
				title={
					empty
						? "No sessions in this project to ask"
						: "Ask every session in this project for a status report"
				}
				asking={reports.value.get(projectReportKey(group))?.phase === "asking"}
				disabled={empty}
				onAsk={() => void askProject(group)}
			/>
			{!empty ? (
				<ExitProjectButton project={group.project} sessions={sessions} />
			) : (
				group.region && (
					<CloseProjectButton
						project={group.project}
						regionId={group.region.id}
					/>
				)
			)}
		</div>
	);
}

export function RegionNotices(props: {
	groups: readonly Group[];
}): JSX.Element {
	return (
		<>
			{props.groups.map((group) => {
				const { frame } = group;
				const key = projectReportKey(group);
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
