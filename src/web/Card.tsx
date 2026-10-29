import {
	AppWindow,
	Bot,
	Circle,
	CircleCheck,
	CircleDot,
	Server,
	SquareTerminal,
	Terminal,
} from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import type { RegionColour } from "../shared/colours.ts";
import type {
	Artifact,
	Session,
	Step,
	Subagent,
	Task,
	TaskStatus,
	Workflow,
} from "../shared/types.ts";
import "./attention.css";
import "./detail.css";
import { subagentState } from "../shared/subagents.ts";
import { ActivityBadge, ActivityIcon, activityLabel } from "./activity.tsx";
import type { PlacedNode } from "./layout.ts";
import { plainText } from "./markdown.ts";
import { ago, relativeTime } from "./time.ts";
import { accountChip, accountOf, usage } from "./usage.ts";
import type { Detail } from "./viewport.ts";

type Emphasis = {
	dimmed: boolean;
	lit: boolean;
	region?: RegionColour;
	arrived?: boolean;
	beckoned?: boolean;
};

function nodeClass(base: string, emphasis: Emphasis): string {
	return [
		base,
		emphasis.dimmed && "dimmed",
		emphasis.lit && "lit",
		emphasis.arrived && "arrived",
		emphasis.beckoned && "beckoned",
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

function GoalBody(props: { goal: string | null }) {
	if (props.goal) return <p class="goal">{props.goal}</p>;
	return <p class="goal goal-empty">No goal yet</p>;
}

function BusyEdge() {
	return <span class="busy-edge" aria-hidden="true" />;
}

function Ribbon(props: { session: Session; now: number }) {
	const { activity } = props.session;
	if (
		activity === "working" ||
		activity === "watching" ||
		activity === "stopped"
	)
		return null;
	return (
		<span class={`ribbon act-${activity}`} aria-hidden="true">
			<ActivityIcon activity={activity} size={13} />
			<span class="ribbon-text">
				{activity === "done"
					? `Finished · ${ago(props.session.updatedAt, props.now)}`
					: activity === "idle"
						? `Idle · ${ago(props.session.updatedAt, props.now)}`
						: activityLabel[activity]}
			</span>
		</span>
	);
}

function workflowProgress(workflow: Workflow): string {
	return `${workflow.done}/${workflow.total} agents`;
}

function WorkflowBars(props: { workflows: readonly Workflow[] }) {
	if (props.workflows.length === 0) return null;
	return (
		<div class="workflows" aria-hidden="true">
			{props.workflows.map((workflow) => (
				<div key={workflow.runId} class="workflow" title={workflow.name}>
					<span class="workflow-name">{workflow.name}</span>
					<span class="workflow-track">
						<span
							class="workflow-fill"
							style={{
								width: `${(100 * workflow.done) / Math.max(workflow.total, 1)}%`,
							}}
						/>
					</span>
					<span class="workflow-count num">{workflowProgress(workflow)}</span>
				</div>
			))}
		</div>
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
	const open = tasks.findIndex((task) => task.status !== "completed");
	const from = open === -1 ? tasks.length - 1 : Math.max(0, open - 1);
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
				{from > 0 && <li class="detail-earlier">{from} done earlier</li>}
				{tasks.slice(from).map((task) => {
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

function RecentSteps(props: { steps: readonly Step[]; now: number }) {
	if (props.steps.length === 0) return null;
	return (
		<section class="detail-section" aria-label="Recent steps">
			<div class="detail-head">
				<span>Recent</span>
			</div>
			<ol class="detail-list">
				{[...props.steps].reverse().map((step, index) => (
					<li key={`${step.at}-${index}`} class="step">
						<span class="detail-text">{plainText(step.text)}</span>
						<time class="num">{relativeTime(step.at, props.now)}</time>
					</li>
				))}
			</ol>
		</section>
	);
}

function NearDetail(props: { session: Session; now: number }) {
	const { session } = props;
	if (session.tasks.length === 0 && session.steps.length === 0) return null;
	return (
		<div class="detail">
			<TaskList tasks={session.tasks} />
			<RecentSteps steps={session.steps} now={props.now} />
		</div>
	);
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
	const waiting =
		workflows.length > 0
			? `; ${workflows.map((w) => `${w.name} ${workflowProgress(w)}`).join(", ")}`
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
	const KindIcon = session.kind === "interactive" ? Terminal : Server;
	const open = (event: MouseEvent) => {
		const control = event.currentTarget as HTMLElement;
		const frame =
			control.closest("[data-node]")?.querySelector(".frame") ?? control;
		props.onOpen(session.id, frame.getBoundingClientRect());
	};
	return (
		<div
			class={nodeClass(
				[
					"node session",
					`act-${session.activity}`,
					session.artifacts.length > 0 && "has-artifacts",
					props.state,
				]
					.filter(Boolean)
					.join(" "),
				props.emphasis,
			)}
			style={position(props.node)}
			data-node={props.node.key}
		>
			<div class="label">
				{!repeatsGoal(session) && <div class="label-name">{session.name}</div>}
				<div class="label-doing">
					{session.doing ? plainText(session.doing) : activityHint(session)}
				</div>
			</div>
			<button
				type="button"
				class="frame"
				aria-label={cardLabel(session, props.workflows)}
				onClick={open}
			>
				<div class="body">
					<WorkflowBars workflows={props.workflows} />
					<GoalBody goal={session.goal} />
					{session.activity === "needs-you" && session.needs && (
						<div class="needs" title={session.needs}>
							{session.needs}
						</div>
					)}
					{props.detail === "near" && (
						<NearDetail session={session} now={props.now} />
					)}
				</div>
				<div class="foot">
					<ActivityBadge activity={session.activity} />
					<span class="foot-project" title={session.cwd}>
						{session.project}
					</span>
					<span class="foot-end">
						{session.configDir && <AccountChip configDir={session.configDir} />}
						<span
							class="foot-kind"
							title={
								session.kind === "background"
									? "Background"
									: session.cmux
										? "Interactive · in cmux"
										: "Interactive"
							}
						>
							<KindIcon size={13} aria-hidden="true" />
						</span>
						<time class="num">
							{relativeTime(session.updatedAt, props.now)}
						</time>
					</span>
				</div>
			</button>
			<CardArtifacts artifacts={session.artifacts} onMore={open} />
			{session.activity === "working" && <BusyEdge />}
			<Ribbon session={session} now={props.now} />
			{props.notice}
			<span class="resize-handle" data-resize aria-hidden="true" />
			{props.corner && <div class="node-corner">{props.corner}</div>}
		</div>
	);
}

function activityHint(session: Session): string {
	switch (session.activity) {
		case "watching":
			return "Watching background work";
		case "idle":
			return "Waiting for a prompt";
		case "done":
			return "Finished";
		case "failed":
			return "Failed";
		case "stopped":
			return "Stopped";
		case "needs-you":
			return "Needs you";
		case "working":
			return "Working";
	}
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
			<span class="sub-icon">
				{subagent.kind === "shell" ? (
					<SquareTerminal size={14} aria-hidden="true" />
				) : (
					<Bot size={14} aria-hidden="true" />
				)}
			</span>
			<div class="sub-text">
				<div class="sub-title">
					<span class="sub-name">{subagent.description || subagent.type}</span>
					{subagent.live && (
						<span class="pulse sub-pulse" role="img" aria-label="running" />
					)}
				</div>
				<div class="sub-kind">{subagent.type}</div>
			</div>
			<time class="sub-time num">
				{relativeTime(subagent.updatedAt, props.now)}
			</time>
			{subagent.live && <BusyEdge />}
			{subagent.kind === "agent" && (
				<button
					type="button"
					class="sub-open"
					aria-label={`Open ${subagent.description || subagent.type}`}
					onClick={(event) =>
						props.onOpen(
							subagent.id,
							(
								event.currentTarget.parentElement ?? event.currentTarget
							).getBoundingClientRect(),
						)
					}
				/>
			)}
		</div>
	);
}

function AccountChip(props: { configDir: string }): JSX.Element {
	const accounts = usage.value?.accounts ?? [];
	const account = accountOf(props.configDir, accounts);
	return (
		<span
			class="foot-account"
			title={account ? `Runs on ${account.email}` : props.configDir}
		>
			{accountChip(props.configDir, accounts)}
		</span>
	);
}
