import { TriangleAlert } from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import type { Activity } from "../shared/types.ts";
import { current } from "./annotations.ts";
import { FromDmChip } from "./ButlerDm.tsx";
import { butlerPresence } from "./butler.ts";
import { isFromDm, openParent, parentTitle } from "./butlerThreads.ts";
import { AuthorChip, StatusBadge } from "./CardFace.tsx";
import type { CardView } from "./cardFace.ts";
import { Timeline } from "./Timeline.tsx";
import { relativeTime } from "./time.ts";
import type { Lane } from "./timeline.ts";

// The parts every card on the board is drawn from, a session of Aaron's or
// one of Butler's cards alike, each fed by the same CardView.

export function activityHint(activity: Activity): string {
	switch (activity) {
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

/** "from <title>" on a card one of Butler's threads started, or the DM chip. */
export function ParentLine(props: { view: CardView }): JSX.Element | null {
	const { parent } = props.view;
	if (!parent) return null;
	if (isFromDm(parent, butlerPresence.value.dm?.thread, current.value)) {
		return <FromDmChip parent={parent.card} />;
	}
	const title = parentTitle(parent.card, current.value, parent.title);
	if (!title) return null;
	return (
		<button
			type="button"
			class="butler-card-from"
			data-no-pan
			title={`Open ${title}`}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				openParent(parent.card);
			}}
		>
			from {title}
		</button>
	);
}

/** What a card is waiting on Aaron for, else what it is doing. */
function NeedsOrDoing(props: {
	view: CardView;
	near?: boolean;
	notes?: ComponentChildren;
}) {
	const { view } = props;
	const needs = view.activity === "needs-you" ? view.needs : null;
	const doing = view.doing ?? activityHint(view.activity);
	if (props.near) {
		return (
			<>
				{needs && (
					<p class="near-needs">
						<TriangleAlert size={14} aria-hidden="true" />
						<span>{needs}</span>
					</p>
				)}
				{props.notes}
				{(!needs || view.doing) && <p class="near-doing">{doing}</p>}
			</>
		);
	}
	return needs ? (
		<div class="needs" title={needs}>
			{needs}
		</div>
	) : (
		<div class="card-doing" title={doing}>
			{doing}
		</div>
	);
}

/** A card's body away from near zoom: its goal, where it came from, what it needs or does, then its own extras and subagents. */
export function CardBody(props: {
	view: CardView;
	before?: ComponentChildren;
	after?: ComponentChildren;
	subagents: ComponentChildren;
}): JSX.Element {
	const { view } = props;
	return (
		<div class="body">
			{props.before}
			<p class={`goal${view.goal ? "" : " goal-empty"}`}>
				{view.goal ?? "No goal yet"}
			</p>
			<ParentLine view={view} />
			{props.after}
			<NeedsOrDoing view={view} />
			{props.subagents}
		</div>
	);
}

/** A card's foot: what it belongs to, then its marks and how long ago it moved. */
export function CardFoot(props: {
	label: string;
	title?: string;
	beside?: ComponentChildren;
	marks?: ComponentChildren;
	updatedAt: number;
	now: number;
}): JSX.Element {
	return (
		<div class="foot">
			<span class="foot-project" title={props.title}>
				{props.label}
			</span>
			{props.beside}
			<span class="foot-end">
				{props.marks}
				<time class="num">{relativeTime(props.updatedAt, props.now)}</time>
			</span>
		</div>
	);
}

/** A card zoomed in: its status and marks, goal, what it needs or does, its extras, then a side column and its timeline. */
export function NearPanel(props: {
	view: CardView;
	now: number;
	name?: ComponentChildren;
	marks?: ComponentChildren;
	notes?: ComponentChildren;
	extras?: ComponentChildren;
	side?: ComponentChildren;
	lanes: Lane[];
	timeline: string;
	class?: string;
}): JSX.Element {
	const { view } = props;
	return (
		<div
			class={`near-panel${props.class ? ` ${props.class}` : ""}`}
			data-scrollable
		>
			<header class="near-head">
				<div class="near-meta">
					<StatusBadge
						status={view.status}
						lastActivity={view.lastActivity}
						now={props.now}
					/>
					<AuthorChip author={view.author} />
					{props.name}
					<span class="foot-end">
						{props.marks}
						<time class="num">{relativeTime(view.updatedAt, props.now)}</time>
					</span>
				</div>
				<p class={`near-goal${view.goal ? "" : " goal-empty"}`}>
					{view.goal ?? "No goal yet"}
				</p>
				<NeedsOrDoing view={view} near notes={props.notes} />
				<ParentLine view={view} />
				{props.extras}
			</header>
			<div class="near-content">
				<div class="near-side">{props.side}</div>
				<div class="near-main">
					<Timeline
						lanes={props.lanes}
						now={props.now}
						label={props.timeline}
						minuteEm={0.8}
						labelled
					/>
				</div>
			</div>
		</div>
	);
}
