import "./projects.css";
import { FolderKanban, OctagonPause, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { neighboursIn } from "../shared/projectDashboard.ts";
import {
	columnOf,
	columnProjects,
	daysSince,
	isSideStage,
	lifecycleStrip,
	type Project,
	type ProjectMainStage,
	projectStages,
	projectsOfSession,
	stageNames,
} from "../shared/projects.ts";
import type { Session } from "../shared/types.ts";
import { ProjectDashboard } from "./ProjectDashboard.tsx";
import {
	openProject,
	openProjectId,
	pollProjects,
	projectsById,
	projectsListing,
	projectsOpen,
	projectsShown,
} from "./projects.ts";
import { now } from "./state.ts";
import { ago } from "./time.ts";

// The Projects view: Butler's projects as columns by lifecycle stage, each
// card with its lifecycle strip, and session cards carrying a chip for each
// project they belong to.

type Column = ProjectMainStage | "aside";
const columns: Column[] = [...projectStages, "aside"];
const columnName = (column: Column) =>
	column === "aside" ? "Paused or dropped" : stageNames[column];

const typingIn = (target: EventTarget | null): boolean =>
	target instanceof HTMLElement &&
	(target.isContentEditable ||
		/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

const dateOf = (at: number) =>
	new Date(at).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
	});

export function LifecycleStrip(props: { project: Project }): JSX.Element {
	const side = isSideStage(props.project.stage);
	return (
		<ol
			class={`lifecycle${side ? ` lifecycle-${props.project.stage}` : ""}`}
			aria-label={`Lifecycle: ${stageNames[props.project.stage]}`}
		>
			{lifecycleStrip(props.project).map((segment) => (
				<li
					key={segment.stage}
					class={`lifecycle-step step-${segment.state}`}
					title={`${stageNames[segment.stage]}${
						segment.since !== null ? `, from ${dateOf(segment.since)}` : ""
					}${segment.state === "current" ? " (now)" : ""}`}
				/>
			))}
		</ol>
	);
}

function Badges(props: { project: Project; t: number }) {
	const { project } = props;
	const days = daysSince(project.touchedAt, props.t);
	return (
		<span class="project-badges">
			{project.blockedOn && (
				<span
					class="project-badge blocked"
					title={`Blocked on ${project.blockedOn}`}
				>
					<OctagonPause size={11} aria-hidden="true" />
					Blocked
				</span>
			)}
			{project.stale && <span class="project-badge stale">Stale</span>}
			{days !== null && (
				<span
					class="project-badge touched num"
					title={`Last touched ${dateOf(project.touchedAt as number)}`}
				>
					{days === 0 ? "today" : `${days} d`}
				</span>
			)}
		</span>
	);
}

function ProjectCard(props: {
	project: Project;
	depth: number;
	selected: boolean;
	t: number;
}) {
	const { project } = props;
	const parent = project.parent
		? projectsById.value.get(project.parent)
		: undefined;
	const children = projectsListing.value.projects.filter(
		(p) => p.parent === project.id,
	).length;
	return (
		<button
			type="button"
			class={`project-card depth-${props.depth}${props.selected ? " selected" : ""}${
				project.stale ? " is-stale" : ""
			}`}
			aria-pressed={props.selected}
			onClick={() => {
				openProjectId.value = props.selected ? null : project.id;
			}}
		>
			{parent && props.depth === 0 && (
				<span class="project-parent">in {parent.title}</span>
			)}
			<span class="project-title-row">
				<span class="project-title">{project.title}</span>
				<Badges project={project} t={props.t} />
			</span>
			{isSideStage(project.stage) && (
				<span class={`project-side ${project.stage}`}>
					{stageNames[project.stage]}
				</span>
			)}
			{project.state && <span class="project-state">{project.state}</span>}
			{project.next && (
				<span class="project-next">
					<span class="project-label">Next</span> {project.next}
				</span>
			)}
			<LifecycleStrip project={project} />
			{project.progress !== null && (
				<span
					class="project-progress"
					role="progressbar"
					aria-valuenow={Math.round(project.progress * 100)}
					aria-valuemin={0}
					aria-valuemax={100}
				>
					<span style={{ width: `${Math.round(project.progress * 100)}%` }} />
				</span>
			)}
			{(children > 0 || project.live.length > 0) && (
				<span class="project-foot">
					{children > 0 && (
						<span>
							{children} sub-project{children === 1 ? "" : "s"}
						</span>
					)}
					{project.live.length > 0 && (
						<span class="project-live">{project.live.length} live</span>
					)}
				</span>
			)}
		</button>
	);
}

function EmptyState() {
	const listing = projectsListing.value;
	if (listing.status === "unconfigured") {
		return (
			<p class="projects-empty">
				Projects are not connected to this board. Set KANBAN_PROJECTS_URL (or
				KANBAN_PROJECTS_FIXTURE=1 for sample projects) where the board runs.
			</p>
		);
	}
	if (listing.status === "unavailable") {
		return (
			<p class="projects-empty">
				Projects are unavailable right now
				{listing.error ? `: ${listing.error}` : ""}. The board tries again
				shortly.
			</p>
		);
	}
	return <p class="projects-empty">No projects yet.</p>;
}

function ProjectsDialog(props: { onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [hideDone, setHideDone] = useState(false);
	const [area, setArea] = useState("");
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const listing = projectsListing.value;
	const t = now.value;
	const areas = [
		...new Set(listing.projects.map((p) => p.area).filter(Boolean)),
	].sort();
	const shown = listing.projects.filter(
		(p) =>
			(!area || p.area === area) &&
			!(hideDone && (p.stage === "done" || p.stage === "dropped")),
	);
	const selected = openProjectId.value
		? projectsById.value.get(openProjectId.value)
		: undefined;
	const visibleColumns = columns.filter((c) => !hideDone || c !== "done");
	const selectedColumn = selected ? columnOf(selected.stage) : null;
	const position = selected
		? neighboursIn(
				columnProjects(
					shown.some((p) => p.id === selected.id) ? shown : listing.projects,
					selectedColumn as Column,
				),
				selected.id,
			)
		: { index: -1, count: 0, previous: null, next: null };
	return (
		<dialog
			class="focus-dialog projects-dialog"
			ref={dialog}
			onClose={props.onClose}
			onCancel={(event) => {
				if (!openProjectId.value) return;
				event.preventDefault();
				openProjectId.value = null;
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					if (selected) openProjectId.value = null;
					else props.onClose();
					return;
				}
				if (!selected || typingIn(event.target)) return;
				const to =
					event.key === "ArrowLeft"
						? position.previous
						: event.key === "ArrowRight"
							? position.next
							: undefined;
				if (to === undefined) return;
				event.preventDefault();
				if (to) openProjectId.value = to;
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) props.onClose();
			}}
			aria-label="Projects"
		>
			<header class="comment-thread-head projects-head">
				<FolderKanban size={16} aria-hidden="true" />
				<span class="comment-thread-title">Projects</span>
				{listing.status === "fixture" && (
					<span class="project-badge">Sample projects</span>
				)}
				{listing.fetchedAt !== null && (
					<span class="project-muted projects-read" title={listing.error ?? ""}>
						{listing.error ? "Last read " : "Read "}
						{ago(listing.fetchedAt, t)}
					</span>
				)}
				{areas.length > 1 && (
					<select
						class="projects-area"
						aria-label="Area"
						value={area}
						onChange={(event) => setArea(event.currentTarget.value)}
					>
						<option value="">Every area</option>
						{areas.map((a) => (
							<option key={a} value={a}>
								{a}
							</option>
						))}
					</select>
				)}
				<label class="projects-toggle">
					<input
						type="checkbox"
						checked={hideDone}
						onChange={(event) => setHideDone(event.currentTarget.checked)}
					/>
					Hide finished
				</label>
				<button
					type="button"
					class="icon-button"
					aria-label="Close"
					onClick={props.onClose}
				>
					<X size={14} />
				</button>
			</header>
			<div class="projects-body">
				{selected ? (
					<ProjectDashboard
						project={selected}
						position={position}
						columnName={columnName(selectedColumn as Column)}
						onClose={() => {
							openProjectId.value = null;
						}}
					/>
				) : listing.projects.length === 0 ? (
					<EmptyState />
				) : (
					<div class="projects-columns" data-scrollable>
						{visibleColumns.map((column) => {
							const items = columnProjects(shown, column);
							return (
								<section
									key={column}
									class={`projects-column column-${column}`}
									aria-label={columnName(column)}
								>
									<h3 class="projects-column-head">
										<span>{columnName(column)}</span>
										<span class="num project-muted">{items.length}</span>
									</h3>
									<div class="projects-column-cards">
										{items.map(({ project, depth }) => (
											<ProjectCard
												key={project.id}
												project={project}
												depth={depth}
												selected={false}
												t={t}
											/>
										))}
									</div>
								</section>
							);
						})}
					</div>
				)}
			</div>
		</dialog>
	);
}

export function ProjectsHost(): JSX.Element | null {
	useEffect(() => pollProjects(), []);
	if (!projectsOpen.value) return null;
	return (
		<ProjectsDialog
			onClose={() => {
				projectsOpen.value = false;
			}}
		/>
	);
}

export function ProjectsButton(): JSX.Element | null {
	if (!projectsShown.value) return null;
	const count = projectsListing.value.projects.filter(
		(p) => columnOf(p.stage) !== "done" && p.stage !== "dropped",
	).length;
	return (
		<button
			type="button"
			class="icon-button"
			aria-haspopup="dialog"
			aria-label="Projects"
			title={`Projects: Butler's projects by lifecycle stage${
				count ? `, ${count} open` : ""
			}`}
			onClick={() => openProject(null)}
		>
			<FolderKanban size={16} />
		</button>
	);
}

/** A chip on a session card for each project the session belongs to. */
export function SessionProjectChips(props: {
	session: Session;
}): JSX.Element | null {
	const linked = projectsOfSession(
		projectsListing.value.projects,
		props.session,
	);
	if (linked.length === 0) return null;
	return (
		<span class="session-projects">
			{linked.slice(0, 2).map((project) => (
				<button
					key={project.id}
					type="button"
					class={`project-chip stage-${project.stage}`}
					data-no-pan
					title={`Project: ${project.title}, ${stageNames[project.stage]}`}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						openProject(project.id);
					}}
				>
					<FolderKanban size={11} aria-hidden="true" />
					<span class="project-chip-name">{project.title}</span>
				</button>
			))}
			{linked.length > 2 && (
				<span class="project-chip-more num">+{linked.length - 2}</span>
			)}
		</span>
	);
}
