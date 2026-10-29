import "./summaries.css";
import { outstandingSubagents } from "../shared/subagents.ts";
import type { Board, Session } from "../shared/types.ts";
import { ActivityIcon, activityLabel } from "./activity.tsx";
import { centreOn } from "./Canvas.tsx";
import { colourOf } from "./colours.ts";
import { digests, stuckOf } from "./digests.ts";
import { exits } from "./exitState.ts";
import type { NodeKey } from "./layout.ts";
import { nodeKey } from "./layout.ts";
import { plainText, renderMarkdown } from "./markdown.ts";
import { groupLabelSpace } from "./placement.ts";
import { frontGroup } from "./regionState.ts";
import { reports } from "./reports.ts";
import { openSession } from "./state.ts";
import type { Summary } from "./summaries.ts";
import { activityCounts } from "./summaries.ts";

const frameEdge = 2;

function taskProgress(session: Session): string | null {
	if (session.tasks.length === 0) return null;
	const done = session.tasks.filter((t) => t.status === "completed").length;
	return `${done}/${session.tasks.length}`;
}

function noticeOf(session: Session): string | null {
	const exit = exits.value.get(session.id);
	if (exit?.phase === "checking")
		return exit.force ? "Exiting…" : "Asking whether it's safe to exit…";
	if (exit?.phase === "refused") return `${exit.title}: ${exit.message}`;
	const report = reports.value.get(session.id);
	if (report?.phase === "failed")
		return `Couldn't get a status report: ${report.error}`;
	if (session.activity === "needs-you") return session.needs;
	return stuckOf(session, digests.value.sessions[session.id]);
}

function SummaryRow(props: { session: Session; dimmed: boolean }) {
	const { session } = props;
	const progress = taskProgress(session);
	const notice = noticeOf(session);
	return (
		<li>
			<button
				type="button"
				class={`summary-row act-${session.activity}${props.dimmed ? " dimmed" : ""}`}
				aria-label={`Open ${session.name}, ${activityLabel[session.activity]}`}
				onClick={(event) =>
					openSession(session.id, event.currentTarget.getBoundingClientRect())
				}
			>
				<ActivityIcon activity={session.activity} size={14} />
				<span class="summary-text">
					<span class="summary-goal">
						{session.goal ? plainText(session.goal) : session.name}
					</span>
					{notice && <span class="summary-notice">{notice}</span>}
				</span>
				{progress && <span class="summary-progress num">{progress}</span>}
			</button>
		</li>
	);
}

function outstandingAgents(board: Board, sessions: readonly Session[]): number {
	return sessions.reduce((total, session) => {
		const counts = board.subagentCounts[session.id];
		return total + (counts ? outstandingSubagents(counts) : 0);
	}, 0);
}

function ProjectSummary(props: {
	summary: Summary;
	board: Board;
	visible: (key: NodeKey) => boolean;
}) {
	const { summary } = props;
	const edge = summary.framed ? frameEdge : 0;
	const top = summary.framed ? groupLabelSpace : 0;
	const agents = outstandingAgents(props.board, summary.sessions);
	const narrative = digests.value.projects[summary.key]?.narrative;
	return (
		<div
			class={`summary region region-${colourOf(summary.cwd)}${summary.framed ? "" : " alone"}`}
			data-summary={summary.key}
			style={{
				transform: `translate(${summary.frame.x + edge}px, ${summary.frame.y + top}px)`,
				width: `${summary.frame.w - 2 * edge}px`,
				height: `${summary.frame.h - top - edge}px`,
			}}
		>
			<div class="summary-inner">
				<button
					type="button"
					class="summary-head"
					title={`Zoom in on ${summary.project}`}
					onClick={() => centreOn(summary.frame)}
				>
					<span class="summary-project">{summary.project}</span>
					<span class="summary-counts">
						{activityCounts(summary.sessions).map(([activity, count]) => (
							<span
								key={activity}
								class={`summary-count act-${activity}`}
								title={activityLabel[activity]}
							>
								<ActivityIcon activity={activity} size={12} />
								<span class="num">{count}</span>
							</span>
						))}
						{agents > 0 && (
							<span class="summary-count summary-agents">
								<span class="num">{agents}</span>
								{agents === 1 ? " agent" : " agents"}
							</span>
						)}
					</span>
				</button>
				{narrative && (
					<div class="summary-narrative markdown">
						{renderMarkdown(narrative)}
					</div>
				)}
				<ul class="summary-sessions">
					{summary.sessions.map((session) => (
						<SummaryRow
							key={session.id}
							session={session}
							dimmed={
								!props.visible(nodeKey({ kind: "session", id: session.id }))
							}
						/>
					))}
				</ul>
			</div>
		</div>
	);
}

function frontLast(
	summaries: readonly Summary[],
	front: string | null,
): Summary[] {
	return [
		...summaries.filter((summary) => summary.key !== front),
		...summaries.filter((summary) => summary.key === front),
	];
}

export function Summaries(props: {
	summaries: readonly Summary[];
	board: Board;
	visible: (key: NodeKey) => boolean;
}) {
	return (
		<>
			{frontLast(props.summaries, frontGroup.value).map((summary) => (
				<ProjectSummary
					key={summary.key}
					summary={summary}
					board={props.board}
					visible={props.visible}
				/>
			))}
		</>
	);
}
