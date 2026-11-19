import "./projectDashboard.css";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { dashboardOf } from "../shared/projectDashboard.ts";
import { type Project, stageNames } from "../shared/projects.ts";
import type { ButlerCard } from "../shared/types.ts";
import { waitingApprovals } from "./Approvals.tsx";
import { claudeSessions } from "./butlerSessions.ts";
import { openThreadCard } from "./butlerThreads.ts";
import {
	DashboardBody,
	dateOf,
	LifecycleStrip,
} from "./projectDashboardView.tsx";
import { cardOwners } from "./projectRegions.ts";
import {
	ancestors,
	loadProjects,
	openProjectId,
	projectsListing,
	projectsOpen,
} from "./projects.ts";
import { annotations, board, connection, now, openSession } from "./state.ts";

export { StateChip } from "./projectDashboardView.tsx";

// A project's live dashboard, taking the whole Projects dialog: where it
// stands, whether it moves, what waits on Aaron, its timeline, its work map
// and its live work, all worked out from the projects list and the board.

const projectsStaleMs = 5 * 60_000;

/** Leaves the Projects view for the card or session, which opens over the board. */
function openTarget(target: string | null) {
	if (!target) return;
	const card = annotations.value[target];
	const thread =
		card?.kind === "butler-card" ? (card as ButlerCard).thread?.id : undefined;
	const session = board.value?.sessions.some((s) => s.id === target);
	if (!thread && !session) return;
	projectsOpen.value = false;
	if (thread) openThreadCard.value = thread;
	else openSession(target);
}

const sessionsOf = () => claudeSessions(board.value?.sessions ?? []);
const butlerCards = (): ButlerCard[] =>
	Object.values(annotations.value).filter(
		(a): a is ButlerCard => a.kind === "butler-card",
	);

export const dashboardPollMs = 15_000;

export function ProjectDashboard(props: {
	project: Project;
	position: {
		index: number;
		count: number;
		previous: string | null;
		next: string | null;
	};
	columnName: string;
	onClose: () => void;
}): JSX.Element {
	const article = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!article.current?.contains(document.activeElement)) {
			article.current?.focus({ preventScroll: true });
		}
	}, [props.project.id]);
	useEffect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void loadProjects();
		}, dashboardPollMs);
		return () => clearInterval(timer);
	}, []);
	const t = now.value;
	const listing = projectsListing.value;
	const dash = dashboardOf({
		project: props.project,
		projects: listing.projects,
		owners: cardOwners.value,
		cards: butlerCards(),
		sessions: sessionsOf(),
		approvals: waitingApprovals.value,
		now: t,
	});
	const projectsAsOf = {
		at: listing.fetchedAt,
		stale:
			Boolean(listing.error) ||
			(listing.fetchedAt !== null && t - listing.fetchedAt > projectsStaleMs),
	};
	const boardAsOf = { at: t, stale: connection.value !== "open" };
	const { project, position } = props;
	const chain = ancestors(
		project,
		new Map(listing.projects.map((p) => [p.id, p])),
	).reverse();
	const go = (id: string | null) => {
		if (id) openProjectId.value = id;
	};
	return (
		<article
			ref={article}
			tabIndex={-1}
			class="dash"
			aria-label={`${project.title} dashboard`}
		>
			<header class="dash-head">
				<button
					type="button"
					class="dash-back"
					title="Back to all projects (Esc)"
					onClick={props.onClose}
				>
					<ArrowLeft size={14} aria-hidden="true" />
					All projects
				</button>
				<button
					type="button"
					class="icon-button"
					aria-label="Previous project in this column"
					title="Previous (←)"
					disabled={!position.previous}
					onClick={() => go(position.previous)}
				>
					<ChevronLeft size={16} />
				</button>
				<span class="dash-position num">
					{position.index + 1} of {position.count} · {props.columnName}
				</span>
				<button
					type="button"
					class="icon-button"
					aria-label="Next project in this column"
					title="Next (→)"
					disabled={!position.next}
					onClick={() => go(position.next)}
				>
					<ChevronRight size={16} />
				</button>
				<div class="dash-title-block">
					{chain.length > 0 && (
						<p class="dash-crumbs">
							{chain.map((p) => (
								<button
									key={p.id}
									type="button"
									class="project-link"
									onClick={() => {
										openProjectId.value = p.id;
									}}
								>
									{p.title}
								</button>
							))}
						</p>
					)}
					<h3 class="dash-title">{project.title}</h3>
					<p class="dash-meta">
						{stageNames[project.stage]}
						{project.area && ` · ${project.area}`}
						{project.stageSince !== null &&
							` · since ${dateOf(project.stageSince)}`}
						{project.stale && " · stale"}
					</p>
				</div>
				<LifecycleStrip project={project} />
			</header>
			<DashboardBody
				dash={dash}
				project={project}
				t={t}
				projectsAsOf={projectsAsOf}
				boardAsOf={boardAsOf}
				open={{
					target: openTarget,
					project: (id) => {
						openProjectId.value = id;
					},
				}}
			/>
		</article>
	);
}
