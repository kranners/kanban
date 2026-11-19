import { TriangleAlert } from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import type { Activity } from "../shared/types.ts";
import type { CardView } from "./cardFace.ts";
import { relativeTime } from "./time.ts";

// The parts every card on the board is drawn from, a session of Aaron's or
// one of Butler's cards alike, each fed by the same CardView. Nothing here
// reads the board's state, so a card can be drawn from its view alone.

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

/** What a card is waiting on Aaron for, else what it is doing. */
export function NeedsOrDoing(props: {
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
	/** Where it came from, drawn under its goal. */
	parent?: ComponentChildren;
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
			{props.parent}
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
