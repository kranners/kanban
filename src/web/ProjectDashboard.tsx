import "./projectDashboard.css";
import {
	ArrowLeft,
	ChevronLeft,
	ChevronRight,
	CircleCheck,
	CircleDashed,
	CircleDot,
	CircleHelp,
	CirclePause,
	Hand,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import {
	type Band,
	type Dashboard,
	type DashboardGraph,
	dashboardOf,
	type GraphNode,
	type Movement,
	type NeedItem,
	type TimelineEvent,
	type WorkItem,
	type WorkState,
} from "../shared/projectDashboard.ts";
import { type Project, stageNames } from "../shared/projects.ts";
import type { ButlerCard } from "../shared/types.ts";
import { waitingApprovals } from "./Approvals.tsx";
import { openThreadCard } from "./butlerThreads.ts";
import { LifecycleStrip } from "./Projects.tsx";
import { cardOwners } from "./projectRegions.ts";
import {
	ancestors,
	loadProjects,
	openProjectId,
	projectsListing,
	projectsOpen,
} from "./projects.ts";
import { annotations, board, connection, now, openSession } from "./state.ts";
import { ago } from "./time.ts";

// A project's live dashboard, taking the whole Projects dialog: where it
// stands, whether it moves, what waits on Aaron, its timeline, its work map
// and its live work, all worked out from the projects list and the board.

const stateLabel: Record<WorkState, string> = {
	done: "Done",
	progress: "In progress",
	aaron: "Needs you",
	other: "Waiting on others",
	idle: "Not started",
	unknown: "Unknown",
};

const StateIcon = (props: { state: WorkState; size?: number }) => {
	const size = props.size ?? 13;
	switch (props.state) {
		case "done":
			return <CircleCheck size={size} aria-hidden="true" />;
		case "progress":
			return <CircleDot size={size} aria-hidden="true" />;
		case "aaron":
			return <Hand size={size} aria-hidden="true" />;
		case "other":
			return <CirclePause size={size} aria-hidden="true" />;
		case "unknown":
			return <CircleHelp size={size} aria-hidden="true" />;
		default:
			return <CircleDashed size={size} aria-hidden="true" />;
	}
};

export const StateChip = (props: { state: WorkState; label?: string }) => (
	<span class={`dash-chip state-${props.state}`}>
		<StateIcon state={props.state} size={12} />
		{props.label ?? stateLabel[props.state]}
	</span>
);

const dayMs = 86_400_000;
const projectsStaleMs = 5 * 60_000;

/** A section's as-of line, marked stale when its source is old or away. */
function AsOf(props: { at: number | null; stale: boolean; t: number }) {
	if (props.at === null) return null;
	return (
		<span
			class={`dash-asof${props.stale ? " is-stale" : ""}`}
			title={
				props.stale ? "Not current: its source has not answered lately" : ""
			}
		>
			{props.stale ? "Stale · " : ""}
			{props.t - props.at < 60_000 ? "live" : ago(props.at, props.t)}
		</span>
	);
}

function Section(props: {
	title: string;
	class?: string;
	asOf?: { at: number | null; stale: boolean };
	t: number;
	children: JSX.Element | JSX.Element[] | null | false;
	aside?: JSX.Element | null;
}) {
	return (
		<section class={`dash-tile ${props.class ?? ""}`} aria-label={props.title}>
			<header class="dash-tile-head">
				<h4>{props.title}</h4>
				{props.aside}
				{props.asOf && (
					<AsOf at={props.asOf.at} stale={props.asOf.stale} t={props.t} />
				)}
			</header>
			{props.children}
		</section>
	);
}

const movementText: Record<Movement["state"], string> = {
	moving: "Moving",
	idling: "Idling",
	blocked: "Blocked",
};

function MovementBadge(props: { movement: Movement }) {
	const { movement } = props;
	const state: WorkState =
		movement.state === "moving"
			? "progress"
			: movement.state === "blocked"
				? movement.on === "you"
					? "aaron"
					: "other"
				: "idle";
	return (
		<span class={`dash-movement state-${state}`}>
			<StateIcon state={state} size={14} />
			{movementText[movement.state]}
			{movement.on && ` on ${movement.on}`}
		</span>
	);
}

const hourLabel = (at: number) =>
	new Date(at).toLocaleTimeString(undefined, { hour: "numeric" });

function BandTrack(props: {
	bands: readonly Band[];
	label: string;
	t: number;
}) {
	const { bands, t } = props;
	return (
		<div
			class="dash-bands"
			role="img"
			aria-label={`${props.label}, the last 24 hours: ${
				bands
					.filter((b) => b.state !== "idle")
					.map((b) => stateLabel[b.state].toLowerCase())
					.join(", ") || "nothing ran"
			}`}
		>
			{bands.map((band) => (
				<span
					key={band.from}
					class={`dash-band state-${band.state}`}
					style={{
						left: `${band.from * 100}%`,
						width: `${(band.to - band.from) * 100}%`,
					}}
					title={`${stateLabel[band.state]}, ${hourLabel(t - (1 - band.from) * dayMs)} to ${hourLabel(t - (1 - band.to) * dayMs)}`}
				/>
			))}
		</div>
	);
}

function Bands(props: { movement: Movement; t: number }) {
	const { movement, t } = props;
	if (movement.rows.length === 0) {
		return <p class="dash-quiet">Nothing ran for it in the last 24 hours.</p>;
	}
	return (
		<div class="dash-bands-wrap">
			<div class="dash-band-row is-total">
				<span class="dash-band-name">All work</span>
				<BandTrack bands={movement.bands} label="All work" t={t} />
			</div>
			{movement.rows.length > 1 &&
				movement.rows.map((row) => (
					<div key={row.id} class="dash-band-row">
						<span class="dash-band-name" title={row.title}>
							<StateIcon state={row.state} size={11} />
							<span class="dash-clip">{row.title}</span>
						</span>
						<BandTrack bands={row.bands} label={row.title} t={t} />
					</div>
				))}
			<div class="dash-band-row">
				<span class="dash-band-name" />
				<div class="dash-bands-axis">
					<span>24 h ago</span>
					<span>12 h</span>
					<span>now</span>
				</div>
			</div>
		</div>
	);
}

function Overview(props: { dash: Dashboard; t: number }) {
	const { dash, t } = props;
	const { project, movement } = dash;
	return (
		<div class="dash-overview">
			<div class="dash-status">
				<MovementBadge movement={movement} />
				<span class="dash-status-facts">
					<span class="num">{movement.working}</span> working ·{" "}
					<span class="num">{movement.activity}</span> event
					{movement.activity === 1 ? "" : "s"} in 24 h
					{dash.needs.length === 0 && " · nothing waits on you"}
				</span>
			</div>
			{project.state && <p class="dash-state">{project.state}</p>}
			{project.next && (
				<p class="dash-next">
					<span class="dash-label">Next</span> {project.next}
				</p>
			)}
			<Bands movement={movement} t={t} />
		</div>
	);
}

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

function Needs(props: { needs: readonly NeedItem[]; t: number }) {
	if (props.needs.length === 0) {
		return <p class="dash-quiet">Nothing waits on you.</p>;
	}
	return (
		<ul class="dash-needs">
			{props.needs.map((need) => (
				<li key={need.key} class={`dash-need kind-${need.kind}`}>
					<StateIcon
						state={
							need.kind === "blocked" && !/^(aaron|approval)/i.test(need.title)
								? "other"
								: "aaron"
						}
					/>
					<span class="dash-need-text">
						<b>{need.title}</b>
						<span class="dash-muted">
							{need.detail}
							{need.since !== null && ` · ${ago(need.since, props.t)}`}
						</span>
					</span>
					{need.target && (
						<button
							type="button"
							class="dash-open"
							onClick={() => openTarget(need.target)}
						>
							Open
						</button>
					)}
				</li>
			))}
		</ul>
	);
}

const dateOf = (at: number) =>
	new Date(at).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
	});

/** Stage moves, starts and finishes on a line from the first to now and a little past, with the next step ahead of the now line. */
function Timeline(props: {
	events: readonly TimelineEvent[];
	next: string;
	t: number;
}) {
	const { events, t } = props;
	if (events.length === 0) {
		return (
			<p class="dash-quiet">
				No history yet: it starts with the next stage move or the first piece of
				work.
			</p>
		);
	}
	const first = Math.min(events[0]?.at ?? t, t - dayMs);
	const span = Math.max(t - first, dayMs);
	const end = t + span * 0.22;
	const x = (at: number) => ((at - first) / (end - first)) * 100;
	const shown = events.slice(-14);
	return (
		<div class="dash-timeline">
			<div class="dash-timeline-line">
				<span class="dash-timeline-future" style={{ left: `${x(t)}%` }} />
				{shown.map((event, i) => (
					<span
						key={`${event.at}-${i}`}
						class={`dash-tick state-${event.state} kind-${event.kind}`}
						style={{ left: `${x(event.at)}%` }}
						title={`${dateOf(event.at)}: ${event.label}`}
					/>
				))}
				<span class="dash-now" style={{ left: `${x(t)}%` }}>
					<span>now</span>
				</span>
			</div>
			<div class="dash-timeline-axis">
				<span>{dateOf(first)}</span>
				<span>{dateOf(t)}</span>
			</div>
			<ol class="dash-events">
				{[...shown]
					.reverse()
					.slice(0, 6)
					.map((event, i) => (
						<li key={`${event.at}-${i}`}>
							<time class="num">{dateOf(event.at)}</time>
							<StateIcon state={event.state} size={12} />
							<span>
								{event.kind === "finish"
									? "Finished: "
									: event.kind === "start"
										? "Started: "
										: ""}
								{event.label}
							</span>
						</li>
					))}
			</ol>
			{props.next && (
				<p class="dash-ahead">
					<span class="dash-label">Ahead</span> {props.next}
				</p>
			)}
		</div>
	);
}

const nodeW = 176;
const nodeH = 54;
const colGap = 56;
const rowGap = 14;

/** The work map: the authored graph by layers with its critical path, or a plain grid of sub-projects and work. */
function Graph(props: { graph: DashboardGraph }) {
	const { graph } = props;
	if (!graph.authored) {
		return (
			<ul class="dash-map">
				{graph.nodes.map((node) => (
					<GraphCard key={node.id} node={node} best={false} />
				))}
			</ul>
		);
	}
	const width = graph.layers * nodeW + (graph.layers - 1) * colGap;
	const height = graph.rows * nodeH + (graph.rows - 1) * rowGap;
	const pos = new Map(
		graph.nodes.map((n) => [
			n.id,
			{ x: n.layer * (nodeW + colGap), y: n.row * (nodeH + rowGap) },
		]),
	);
	return (
		<div class="dash-graph" data-scrollable>
			<div class="dash-graph-canvas" style={{ width, height }}>
				<svg width={width} height={height} aria-hidden="true">
					<defs>
						<marker
							id="dash-arrow"
							viewBox="0 0 8 8"
							refX="7"
							refY="4"
							markerWidth="7"
							markerHeight="7"
							orient="auto"
						>
							<path d="M0,0 L8,4 L0,8 z" class="dash-arrowhead" />
						</marker>
					</defs>
					{graph.edges.map((edge) => {
						const a = pos.get(edge.from);
						const b = pos.get(edge.to);
						if (!a || !b) return null;
						const x1 = a.x + nodeW;
						const y1 = a.y + nodeH / 2;
						const x2 = b.x - 2;
						const y2 = b.y + nodeH / 2;
						const mid = x2 - colGap / 2;
						return (
							<path
								key={`${edge.from}>${edge.to}`}
								class={`dash-edge${edge.critical ? " is-critical" : ""}`}
								d={`M${x1},${y1} H${mid - 8} C${mid},${y1} ${mid},${y2} ${mid + 8},${y2} H${x2}`}
								marker-end="url(#dash-arrow)"
							/>
						);
					})}
				</svg>
				{graph.nodes.map((node) => {
					const at = pos.get(node.id);
					return (
						<div
							key={node.id}
							class="dash-node-at"
							style={{ left: at?.x, top: at?.y, width: nodeW, height: nodeH }}
						>
							<GraphCard node={node} best={graph.best === node.id} />
						</div>
					);
				})}
			</div>
		</div>
	);
}

function GraphCard(props: { node: GraphNode; best: boolean }) {
	const { node } = props;
	const Tag = node.target ? "button" : "div";
	return (
		<Tag
			{...(node.target
				? { type: "button", onClick: () => openTarget(node.target) }
				: {})}
			class={`dash-node state-${node.state}${node.critical ? " is-critical" : ""}${node.ready ? " is-ready" : ""}${props.best ? " is-best" : ""}`}
			title={`${node.title}: ${stateLabel[node.state]}${node.live ? ", live from the board" : ""}${node.frees ? `; frees ${node.frees}` : ""}`}
		>
			<span class="dash-node-title">
				<StateIcon state={node.state} size={12} />
				<span class="dash-clip">{node.title}</span>
			</span>
			<span class="dash-node-sub">
				{props.best
					? `Best unblock · frees ${node.frees}`
					: node.ready
						? "Ready to start"
						: node.sub || stateLabel[node.state]}
			</span>
		</Tag>
	);
}

function Work(props: { work: readonly WorkItem[]; t: number }) {
	if (props.work.length === 0) {
		return (
			<p class="dash-quiet">
				No sessions, changes or threads on the board for it.
			</p>
		);
	}
	return (
		<ul class="dash-work">
			{props.work.slice(0, 12).map((item) => (
				<li key={item.id}>
					<button
						type="button"
						class="dash-work-item"
						onClick={() => openTarget(item.id)}
					>
						<StateChip state={item.state} />
						<span class="dash-work-title">{item.title}</span>
						<span class="dash-muted">
							{item.via && `${item.via} · `}
							{ago(item.updatedAt, props.t)}
						</span>
					</button>
				</li>
			))}
			{props.work.length > 12 && (
				<li class="dash-muted">and {props.work.length - 12} more</li>
			)}
		</ul>
	);
}

function Children(props: { children: readonly Project[] }) {
	return (
		<ul class="dash-children">
			{props.children.map((child) => (
				<li key={child.id}>
					<button
						type="button"
						class="dash-child"
						onClick={() => {
							openProjectId.value = child.id;
						}}
					>
						<span class="dash-child-title">{child.title}</span>
						<span class="dash-muted">{stageNames[child.stage]}</span>
						<LifecycleStrip project={child} />
					</button>
				</li>
			))}
		</ul>
	);
}

const sessionsOf = () => board.value?.sessions ?? [];
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
			<div class="dash-body" data-scrollable>
				<div class="dash-main">
					<Section
						title="Where it stands"
						class="dash-span-overview"
						asOf={projectsAsOf}
						t={t}
					>
						<Overview dash={dash} t={t} />
					</Section>
					{dash.needs.length > 0 && (
						<Section
							title="Needs you"
							class="dash-span-needs"
							asOf={boardAsOf}
							t={t}
							aside={
								dash.needs.length > 0 ? (
									<span class="dash-count num">{dash.needs.length}</span>
								) : null
							}
						>
							<Needs needs={dash.needs} t={t} />
						</Section>
					)}
					<Section
						title="Timeline"
						class="dash-span-timeline"
						asOf={projectsAsOf}
						t={t}
					>
						<Timeline events={dash.timeline} next={project.next} t={t} />
					</Section>
					{dash.graph.nodes.length > 0 && (
						<Section
							title={dash.graph.authored ? "Work map" : "Parts"}
							class="dash-span-graph"
							asOf={
								dash.graph.authored
									? {
											at: dash.graph.updatedAt,
											stale:
												dash.graph.updatedAt !== null &&
												project.touchedAt !== null &&
												project.touchedAt - dash.graph.updatedAt > 3 * dayMs,
										}
									: boardAsOf
							}
							t={t}
						>
							<Graph graph={dash.graph} />
						</Section>
					)}
				</div>
				<aside class="dash-rail">
					<Section
						title="Live work"
						class="dash-span-work"
						asOf={boardAsOf}
						t={t}
					>
						<Work work={dash.work} t={t} />
					</Section>
					{dash.children.length > 0 && (
						<Section title="Sub-projects" class="dash-span-children" t={t}>
							<Children children={dash.children} />
						</Section>
					)}
					{project.links.length > 0 && (
						<Section title="Links" class="dash-span-links" t={t}>
							<ul class="dash-links">
								{project.links.map((link) => (
									<li key={`${link.kind}:${link.ref}`}>
										<span class="dash-muted">{link.kind}</span>
										{link.url ? (
											<a
												href={link.url}
												target="_blank"
												rel="noreferrer noopener"
											>
												{link.ref}
											</a>
										) : (
											<span>{link.ref}</span>
										)}
									</li>
								))}
							</ul>
						</Section>
					)}
				</aside>
			</div>
		</article>
	);
}
