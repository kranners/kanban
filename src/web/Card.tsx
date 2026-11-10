import {
	AppWindow,
	Bot,
	Circle,
	CircleCheck,
	CircleDot,
	Cloud,
	Monitor,
	Server,
	SquareTerminal,
	Terminal,
	TriangleAlert,
	Unlink,
} from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import type { RegionColour } from "../shared/colours.ts";
import { linkRefusal } from "../shared/reach.ts";
import type {
	Artifact,
	Session,
	SessionDigest,
	Subagent,
	Task,
	TaskStatus,
	Workflow,
} from "../shared/types.ts";
import "./attention.css";
import "./detail.css";
import { subagentState } from "../shared/subagents.ts";
import { activityLabel } from "./activity.tsx";
import { current } from "./annotations.ts";
import { unreachable } from "./arrangement.ts";
import { cardOf } from "./butlerSubagents.ts";
import { openButlerCard } from "./butlerThreads.ts";
import { BusyEdge, CardFace } from "./CardFace.tsx";
import { CardBody, CardFoot, NearPanel } from "./CardParts.tsx";
import {
	authorFilter,
	type CardView,
	dimmedByAuthor,
	sessionView,
	stalledText,
} from "./cardFace.ts";
import { digests, stuckOf } from "./digests.ts";
import type { PlacedNode } from "./layout.ts";
import { plainText } from "./markdown.ts";
import { SessionProjectChips } from "./Projects.tsx";
import { RelationHandles } from "./RelationHandles.tsx";
import { unreachableText } from "./reach.ts";
import { board, openSession, openSubagent } from "./state.ts";
import {
	chipName,
	orderWorkflows,
	subagentChips,
	workflowDetail,
} from "./subagentChips.ts";
import { relativeTime } from "./time.ts";
import { averageTaskMs, type Lane, sessionLane } from "./timeline.ts";
import { accountChip, accountOf, usage } from "./usage.ts";
import type { Detail } from "./viewport.ts";

type Emphasis = {
	dimmed: boolean;
	lit: boolean;
	region?: RegionColour;
	arrived?: boolean;
	beckoned?: boolean;
	ignored?: boolean;
};

function nodeClass(base: string, emphasis: Emphasis): string {
	return [
		base,
		emphasis.dimmed && "dimmed",
		emphasis.lit && "lit",
		emphasis.arrived && "arrived",
		emphasis.beckoned && "beckoned",
		emphasis.ignored && "ignored",
		emphasis.region && `grouped region region-${emphasis.region}`,
	]
		.filter(Boolean)
		.join(" ");
}

function position(node: PlacedNode) {
	return {
		transform: `translate(${node.x}px, ${node.y}px)`,
		width: `${node.w}px`,
		height: `${node.h}px`,
	};
}

function SessionBody(props: {
	session: Session;
	workflows: readonly Workflow[];
	now: number;
}) {
	const { session } = props;
	return (
		<CardBody
			view={viewOf(session, props.now)}
			before={<WorkflowBars workflows={props.workflows} />}
			after={<SessionProjectChips session={session} />}
			subagents={<SessionSubagentChips session={session} now={props.now} />}
		/>
	);
}

function viewOf(session: Session, now: number): CardView {
	return sessionView(
		session,
		board.value?.subagents ?? [],
		now,
		session.doing ? plainText(session.doing) : null,
	);
}

function workflowProgress(workflow: Workflow): string {
	return workflowDetail(workflow, board.value?.workflowRuns ?? {});
}

function workflowFill(workflow: Workflow): number {
	if (workflow.endedAt !== undefined) return 100;
	return (100 * workflow.done) / Math.max(workflow.total, 1);
}

function WorkflowBars(props: { workflows: readonly Workflow[] }) {
	if (props.workflows.length === 0) return null;
	return (
		<div class="workflows" aria-hidden="true">
			{orderWorkflows(props.workflows).map((workflow) => (
				<div
					key={workflow.runId}
					class={`workflow${workflow.endedAt === undefined ? "" : " is-done"}`}
					title={`Workflow ${workflow.name}`}
				>
					<span class="workflow-name">{workflow.name}</span>
					<span class="workflow-track">
						<span
							class="workflow-fill"
							style={{ width: `${workflowFill(workflow)}%` }}
						/>
					</span>
					<span class="workflow-count num">{workflowProgress(workflow)}</span>
				</div>
			))}
		</div>
	);
}

/** The newest subagents of a session or Butler card as chips that open each one. */
export function SubagentChips(props: {
	owner: string;
	now: number;
	onOpen: (subagent: Subagent, origin: DOMRect) => void;
}) {
	const current = board.value;
	if (!current) return null;
	const { shown, more } = subagentChips(
		current.subagents,
		props.owner,
		current.subagentCounts[props.owner],
	);
	if (shown.length === 0) return null;
	return (
		<div class="sub-chips">
			{shown.map((subagent) => {
				const state = subagentState(subagent);
				const name = chipName(subagent);
				return (
					<button
						key={subagent.id}
						type="button"
						class={`sub-chip act-${state}`}
						data-no-pan
						title={`${subagent.description || subagent.type} · ${subagent.type}`}
						aria-label={`Open subagent ${name}, ${state}`}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={(event) => {
							event.stopPropagation();
							props.onOpen(
								subagent,
								event.currentTarget.getBoundingClientRect(),
							);
						}}
					>
						<span class="sub-chip-dot" aria-hidden="true" />
						<span class="sub-chip-name">{name}</span>
						<time class="sub-chip-time num">
							{relativeTime(subagent.updatedAt, props.now)}
						</time>
					</button>
				);
			})}
			{more > 0 && (
				<span
					class="sub-chip-more num"
					title={`${more} more ${more === 1 ? "subagent" : "subagents"}`}
				>
					+{more}
				</span>
			)}
		</div>
	);
}

function SessionSubagentChips(props: { session: Session; now: number }) {
	const { session } = props;
	return (
		<SubagentChips
			owner={session.id}
			now={props.now}
			onOpen={(subagent, origin) =>
				session.cloud
					? openSession(session.id, origin)
					: openSubagent(subagent.id, origin)
			}
		/>
	);
}

const taskIcons: Record<TaskStatus, typeof Circle> = {
	pending: Circle,
	in_progress: CircleDot,
	completed: CircleCheck,
};

function taskText(task: Task): string {
	return task.status === "in_progress" && task.activeForm
		? task.activeForm
		: task.subject;
}

function TaskList(props: { tasks: readonly Task[] }) {
	const { tasks } = props;
	if (tasks.length === 0) return null;
	const done = tasks.filter((task) => task.status === "completed").length;
	return (
		<section class="detail-section" aria-label="Tasks">
			<div class="detail-head">
				<span>Tasks</span>
				<span class="detail-track" aria-hidden="true">
					<span
						class="detail-fill"
						style={{ width: `${(100 * done) / tasks.length}%` }}
					/>
				</span>
				<span class="num">
					{done}/{tasks.length}
				</span>
			</div>
			<ol class="detail-list">
				{tasks.map((task) => {
					const Icon = taskIcons[task.status];
					return (
						<li key={task.id} class={`task task-${task.status}`}>
							<Icon size={12} aria-hidden="true" />
							<span class="detail-text">{taskText(task)}</span>
						</li>
					);
				})}
			</ol>
		</section>
	);
}

function ProgressNote(props: {
	digest: SessionDigest;
	stuck: string | null;
	now: number;
}) {
	const { digest, stuck } = props;
	return (
		<section
			class={`detail-section progress${stuck ? " is-stuck" : ""}`}
			aria-label="Progress"
		>
			<div class="detail-head">
				<span>{stuck ? "Stuck" : "Progress"}</span>
				<time class="num">{relativeTime(digest.at, props.now)}</time>
			</div>
			{stuck && (
				<p class="progress-stuck">
					<TriangleAlert size={12} aria-hidden="true" />
					<span>{stuck}</span>
				</p>
			)}
			{digest.now && <p class="progress-now">{digest.now}</p>}
			{digest.progress && <p class="progress-far">{digest.progress}</p>}
		</section>
	);
}

function nearLanes(session: Session, now: number): Lane[] {
	const typical = averageTaskMs(board.value?.sessions ?? []);
	const steps = {
		key: "steps",
		label: "Steps",
		spans: [],
		finish: null,
		events: session.steps,
	};
	const tasks = sessionLane(session, "Tasks", now, typical);
	return [
		...(session.tasks.length > 0 ? [tasks] : []),
		...(session.steps.length > 0 ? [steps] : []),
	];
}

function SessionNearPanel(props: {
	session: Session;
	workflows: readonly Workflow[];
	now: number;
}) {
	const { session } = props;
	const digest = digests.value.sessions[session.id];
	const KindIcon = kindIcon(session);
	return (
		<NearPanel
			view={viewOf(session, props.now)}
			now={props.now}
			name={
				<>
					{!repeatsGoal(session) && (
						<span class="near-name">{session.name}</span>
					)}
					<span class="near-project" title={session.cwd}>
						{session.project}
					</span>
				</>
			}
			marks={
				<>
					<UnreachableChip sessionId={session.id} />
					{session.configDir && <AccountChip configDir={session.configDir} />}
					<KindIcon size={13} aria-hidden="true" />
				</>
			}
			notes={<UnreachableNote sessionId={session.id} />}
			extras={
				<>
					<WorkflowBars workflows={props.workflows} />
					<SessionSubagentChips session={session} now={props.now} />
				</>
			}
			side={
				<>
					{digest && (
						<ProgressNote
							digest={digest}
							stuck={stuckOf(session, digest)}
							now={props.now}
						/>
					)}
					<TaskList tasks={session.tasks} />
				</>
			}
			lanes={nearLanes(session, props.now)}
			timeline="Session timeline"
		/>
	);
}

function kindIcon(session: Session) {
	return session.cloud
		? Cloud
		: session.runner
			? Monitor
			: session.kind === "interactive"
				? Terminal
				: Server;
}

const shownArtifacts = 2;

export function ArtifactLink(props: { artifact: Artifact }) {
	const { artifact } = props;
	return (
		<a
			class="artifact-link"
			href={artifact.url}
			target="_blank"
			rel="noopener noreferrer"
			draggable={false}
			title={`Open ${artifact.title}`}
		>
			<AppWindow size={12} aria-hidden="true" />
			<span class="artifact-title">{artifact.title}</span>
		</a>
	);
}

function CardArtifacts(props: {
	artifacts: Artifact[];
	onMore: (event: MouseEvent) => void;
}) {
	const { artifacts } = props;
	if (artifacts.length === 0) return null;
	const hidden = artifacts.length - shownArtifacts;
	return (
		<div class="card-artifacts">
			{artifacts.slice(0, shownArtifacts).map((artifact) => (
				<ArtifactLink key={artifact.url} artifact={artifact} />
			))}
			{hidden > 0 && (
				<button
					type="button"
					class="artifact-more num"
					aria-label={`${hidden} more ${hidden === 1 ? "artifact" : "artifacts"}`}
					onClick={props.onMore}
				>
					+{hidden}
				</button>
			)}
		</div>
	);
}

function cardStatus(session: Session, workflows: readonly Workflow[]): string {
	const detail =
		session.activity === "needs-you" ? session.needs : session.doing;
	const label = activityLabel[session.activity];
	const status = detail ? `${label}: ${detail}` : label;
	const running = workflows.filter((w) => w.endedAt === undefined);
	const waiting =
		running.length > 0
			? `; ${running.map((w) => `${w.name} ${workflowProgress(w)}`).join(", ")}`
			: "";
	return `${status}${waiting}`;
}

function repeatsGoal(session: Session): boolean {
	return session.name.toLowerCase() === session.goal?.toLowerCase();
}

function cardLabel(session: Session, workflows: readonly Workflow[]): string {
	const goal = session.goal ? `, goal: ${session.goal}` : "";
	return `Open ${session.name}${goal}, ${cardStatus(session, workflows)}`;
}

export function SessionCard(props: {
	node: PlacedNode;
	session: Session;
	workflows: readonly Workflow[];
	now: number;
	detail: Detail;
	emphasis: Emphasis;
	onOpen: (id: string, origin: DOMRect) => void;
	corner?: ComponentChildren;
	notice?: ComponentChildren;
	state?: string;
}) {
	const { session } = props;
	const KindIcon = kindIcon(session);
	const open = (event: MouseEvent) => {
		const control = event.currentTarget as HTMLElement;
		const frame =
			control.closest("[data-node]")?.querySelector(".frame") ?? control;
		props.onOpen(session.id, frame.getBoundingClientRect());
	};
	const view = viewOf(session, props.now);
	const { author, status, lastActivity } = view;
	return (
		<CardFace
			status={status}
			lastActivity={lastActivity}
			author={author}
			name={session.name}
			now={props.now}
			class={nodeClass(
				[session.artifacts.length > 0 && "has-artifacts", props.state]
					.filter(Boolean)
					.join(" "),
				{
					...props.emphasis,
					dimmed:
						props.emphasis.dimmed || dimmedByAuthor(author, authorFilter.value),
				},
			)}
			style={position(props.node)}
			dataNode={props.node.key}
			frameLabel={
				status === "stalled"
					? `${stalledText(lastActivity, props.now)}. ${cardLabel(session, props.workflows)}`
					: cardLabel(session, props.workflows)
			}
			onOpen={open}
			corner={props.corner}
			frame={
				props.detail === "near" ? (
					<SessionNearPanel
						session={session}
						workflows={props.workflows}
						now={props.now}
					/>
				) : (
					<>
						<SessionBody
							session={session}
							workflows={props.workflows}
							now={props.now}
						/>
						<CardFoot
							label={session.project}
							title={session.cwd}
							marks={
								<>
									<UnreachableChip sessionId={session.id} />
									{session.configDir && (
										<AccountChip configDir={session.configDir} />
									)}
									<span
										class="foot-kind"
										title={
											session.cloud
												? "Cloud"
												: session.runner
													? `On ${session.runner.name}`
													: session.kind === "background"
														? "Background"
														: session.cmux
															? "Interactive · in cmux"
															: "Interactive"
										}
									>
										<KindIcon size={13} aria-hidden="true" />
									</span>
								</>
							}
							updatedAt={session.updatedAt}
							now={props.now}
						/>
					</>
				)
			}
		>
			<CardArtifacts artifacts={session.artifacts} onMore={open} />
			{props.notice}
			<span class="resize-handle" data-resize aria-hidden="true" />
			{linkRefusal(session) === null && (
				<RelationHandles end={{ kind: "session", id: session.id }} />
			)}
		</CardFace>
	);
}

export function SubagentCard(props: {
	node: PlacedNode;
	subagent: Subagent;
	now: number;
	emphasis: Emphasis;
	onOpen: (id: string, origin: DOMRect) => void;
}) {
	const { subagent } = props;
	return (
		<div
			class={nodeClass(
				`node subagent act-${subagentState(subagent)}${subagent.live ? " live" : ""}`,
				props.emphasis,
			)}
			style={position(props.node)}
			data-node={props.node.key}
			title={subagent.description}
		>
			<div class="sub-inner">
				<span class="sub-icon">
					{subagent.kind === "shell" ? (
						<SquareTerminal size={14} aria-hidden="true" />
					) : (
						<Bot size={14} aria-hidden="true" />
					)}
				</span>
				<div class="sub-text">
					<div class="sub-title">
						<span class="sub-name">
							{subagent.description || subagent.type}
						</span>
						{subagent.live && (
							<span class="pulse sub-pulse" role="img" aria-label="running" />
						)}
					</div>
					<div class="sub-kind">{subagent.type}</div>
				</div>
				<time class="sub-time num">
					{relativeTime(subagent.updatedAt, props.now)}
				</time>
			</div>
			{subagent.live && <BusyEdge />}
			{subagent.kind === "agent" && (
				<button
					type="button"
					class="sub-open"
					aria-label={`Open ${subagent.description || subagent.type}`}
					onClick={(event) => {
						const card = cardOf(subagent, current.value);
						if (card) {
							openButlerCard(card);
							return;
						}
						props.onOpen(
							subagent.id,
							(
								event.currentTarget.parentElement ?? event.currentTarget
							).getBoundingClientRect(),
						);
					}}
				/>
			)}
		</div>
	);
}

function UnreachableChip(props: { sessionId: string }): JSX.Element | null {
	const others = unreachable.value.get(props.sessionId);
	if (!others) return null;
	return (
		<span
			class="foot-unreachable"
			role="img"
			title={unreachableText(others)}
			aria-label={unreachableText(others)}
		>
			<Unlink size={12} aria-hidden="true" />
			<span class="num">{others.length}</span>
		</span>
	);
}

function UnreachableNote(props: { sessionId: string }): JSX.Element | null {
	const others = unreachable.value.get(props.sessionId);
	if (!others) return null;
	return (
		<p class="near-unreachable">
			<Unlink size={14} aria-hidden="true" />
			<span>{unreachableText(others)}</span>
		</p>
	);
}

function AccountChip(props: { configDir: string }): JSX.Element {
	const accounts = usage.value?.accounts ?? [];
	const account = accountOf(props.configDir, accounts);
	return (
		<span
			class="foot-account"
			title={account ? `Account ${account.email}` : props.configDir}
		>
			{accountChip(props.configDir, accounts)}
		</span>
	);
}
