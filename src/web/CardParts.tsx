import type { ComponentChildren, JSX } from "preact";
import { current } from "./annotations.ts";
import { FromDmChip } from "./ButlerDm.tsx";
import { butlerPresence } from "./butler.ts";
import { isFromDm, openParent, parentTitle } from "./butlerThreads.ts";
import { AuthorChip, StatusBadge } from "./CardFace.tsx";
import { NeedsOrDoing } from "./cardBody.tsx";
import type { CardView } from "./cardFace.ts";
import { Timeline } from "./Timeline.tsx";
import { relativeTime } from "./time.ts";
import type { Lane } from "./timeline.ts";

export { activityHint, CardBody, CardFoot } from "./cardBody.tsx";

// The card parts that read the board: where a card came from, and a card zoomed in.

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
