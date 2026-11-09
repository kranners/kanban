import { BriefcaseBusiness, ClockAlert, LayoutGrid } from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import { ActivityIcon } from "./activity.tsx";
import { ButlerMark, SelfFixIcon } from "./Butler.tsx";
import {
	type CardAuthor,
	type CardStatus,
	stalledText,
	statusLabels,
} from "./cardFace.ts";
import { ago } from "./time.ts";

export function StatusIcon(props: { status: CardStatus; size?: number }) {
	if (props.status === "stalled") {
		return (
			<ClockAlert size={props.size ?? 12} strokeWidth={2.25} aria-hidden />
		);
	}
	return <ActivityIcon activity={props.status} size={props.size} />;
}

function AuthorIcon(props: { author: CardAuthor }) {
	switch (props.author.kind) {
		case "kanban":
			return <LayoutGrid size={12} aria-hidden="true" />;
		case "butler":
			return <ButlerMark size={12} />;
		case "desk":
			return <BriefcaseBusiness size={12} aria-hidden="true" />;
		case "change":
			return <SelfFixIcon size={12} />;
	}
}

export function AuthorChip(props: { author: CardAuthor }): JSX.Element {
	const { author } = props;
	const title = author.from
		? `Started by ${author.label}, from ${author.from}`
		: `Started by ${author.label}`;
	return (
		<span class={`author-chip author-${author.kind}`} title={title}>
			<AuthorIcon author={author} />
			<span class="author-chip-label">{author.label}</span>
		</span>
	);
}

/** The status pill on a card's bar; working shows as the busy edge instead. */
export function StatusRibbon(props: {
	status: CardStatus;
	lastActivity: number;
	now: number;
}): JSX.Element | null {
	const { status } = props;
	if (status === "working" || status === "watching" || status === "stopped") {
		return null;
	}
	const text =
		status === "stalled"
			? stalledText(props.lastActivity, props.now)
			: status === "done" || status === "idle"
				? `${statusLabels[status]} · ${ago(props.lastActivity, props.now)}`
				: statusLabels[status];
	return (
		<span class={`ribbon act-${status}`} aria-hidden="true">
			<StatusIcon status={status} size={13} />
			<span class="ribbon-text">{text}</span>
		</span>
	);
}

export function BusyEdge() {
	return <span class="busy-edge" aria-hidden="true" />;
}

/**
 * The one card face of the board, for Aaron's sessions and Butler's cards
 * alike: the status colours its edge and ribbon, the bar names it and who
 * started it, and the frame holds what each kind of card has to say.
 */
export function CardFace(props: {
	status: CardStatus;
	lastActivity: number;
	author: CardAuthor;
	name: string;
	now: number;
	frame: ComponentChildren;
	class?: string;
	style?: Record<string, string>;
	dataNode?: string;
	frameLabel?: string;
	onOpen?: (event: MouseEvent) => void;
	corner?: ComponentChildren;
	children?: ComponentChildren;
}): JSX.Element {
	const { status, author } = props;
	return (
		<div
			class={[
				"node session card-face",
				`act-${status}`,
				`author-${author.kind}`,
				props.class,
			]
				.filter(Boolean)
				.join(" ")}
			style={props.style}
			data-node={props.dataNode}
			data-author={author.kind}
		>
			{props.onOpen ? (
				<button
					type="button"
					class="frame"
					aria-label={props.frameLabel}
					onClick={props.onOpen}
				>
					{props.frame}
				</button>
			) : (
				<div class="frame">{props.frame}</div>
			)}
			<div class="card-bar">
				<span class="card-bar-label" title={props.name}>
					<StatusIcon status={status} size={13} />
					<span class="card-bar-name">{props.name}</span>
				</span>
				<AuthorChip author={author} />
				<StatusRibbon
					status={status}
					lastActivity={props.lastActivity}
					now={props.now}
				/>
				{props.corner && <div class="card-corner">{props.corner}</div>}
			</div>
			{status === "working" && <BusyEdge />}
			{props.children}
		</div>
	);
}

export function StatusBadge(props: {
	status: CardStatus;
	lastActivity: number;
	now: number;
}): JSX.Element {
	const { status } = props;
	return (
		<span class={`badge act-${status}`}>
			<StatusIcon status={status} />
			{status === "stalled"
				? stalledText(props.lastActivity, props.now)
				: statusLabels[status]}
		</span>
	);
}
