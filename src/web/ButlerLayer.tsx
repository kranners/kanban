import "./butler.css";
import { TriangleAlert } from "lucide-preact";
import type { JSX } from "preact";
import type { ButlerCard, Note } from "../shared/types.ts";
import { ActivityBadge } from "./activity.tsx";
import { current } from "./annotations.ts";
import { arrangement } from "./arrangement.ts";
import {
	ButlerAvatar,
	ButlerCursor,
	ButlerMark,
	ButlerNoteIcon,
	ButlerWatchingIcon,
	SelfFixIcon,
} from "./Butler.tsx";
import { butlerPresence, presenceOf } from "./butler.ts";
import { butlerLanes } from "./butlerCards.ts";
import {
	linkedCount,
	openParent,
	parentTitle,
	threadKindLabels,
} from "./butlerThreads.ts";
import { detail, view } from "./Canvas.tsx";
import { threads } from "./comments.ts";
import { nodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";
import { board, now } from "./state.ts";
import { Timeline } from "./Timeline.tsx";
import { ago, relativeTime } from "./time.ts";

/** What a Butler card is: a change, one of his Discord threads by its kind, or one he made. */
function kindOf(card: ButlerCard): string {
	if (card.selfFix) return "Change";
	if (card.thread) return threadKindLabels[card.thread.kind];
	return "Butler";
}

function linkLabel(card: ButlerCard): string {
	return card.thread ? "Open in Discord ↗" : "Open session ↗";
}

/** "from <title>" on a card that came from one of Butler's threads. */
function ParentLine(props: { card: ButlerCard }): JSX.Element | null {
	const title = parentTitle(props.card.parent, current.value);
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
				openParent(props.card.parent);
			}}
		>
			from {title}
		</button>
	);
}

/** A Butler card zoomed in, laid out as a session card's near view, with its timeline. */
function ButlerNearPanel(props: {
	card: ButlerCard;
	now: number;
}): JSX.Element {
	const { card } = props;
	const kind = kindOf(card);
	return (
		<div class={`near-panel butler-near butler-${card.state}`} data-scrollable>
			<header class="near-head">
				<div class="near-meta">
					<ActivityBadge activity={card.state} />
					<span class="near-name butler-near-kind">
						{card.selfFix ? (
							<SelfFixIcon size={14} />
						) : (
							<ButlerMark size={14} />
						)}
						{kind}
					</span>
					{card.watching && (
						<ButlerWatchingIcon
							size={16}
							class="butler-watching-icon"
							aria-label="Butler is watching"
						/>
					)}
					<span class="foot-end">
						<ButlerAvatar size={14} />
						<time class="num">{relativeTime(card.updatedAt, props.now)}</time>
					</span>
				</div>
				<p class="near-goal">{card.title}</p>
				{card.status &&
					(card.state === "needs-you" ? (
						<p class="near-needs">
							<TriangleAlert size={14} aria-hidden="true" />
							<span>{card.status}</span>
						</p>
					) : (
						<p class="near-doing">{card.status}</p>
					))}
				{card.link && (
					<a
						class="butler-card-link"
						href={card.link}
						target="_blank"
						rel="noopener noreferrer"
					>
						{linkLabel(card)}
					</a>
				)}
				<ParentLine card={card} />
			</header>
			<div class="near-content">
				<div class="near-side">
					{card.summary && (
						<section class="detail-section" aria-label="Summary">
							<div class="detail-head">
								<span>Summary</span>
							</div>
							<p class="butler-near-summary">{card.summary}</p>
						</section>
					)}
				</div>
				<div class="near-main">
					<Timeline
						lanes={butlerLanes(card, props.now)}
						now={props.now}
						label={`${kind} timeline`}
						minuteEm={0.8}
						labelled
					/>
				</div>
			</div>
		</div>
	);
}

/**
 * One of Butler's cards: a change he started, or one he made himself. Away
 * from near zoom it reads like a session card, with nothing that scrolls, so
 * the wheel always moves the board; the summary waits for the near view.
 */
export function ButlerCardBody(props: { card: ButlerCard }): JSX.Element {
	const { card } = props;
	const t = now.value;
	if (detail.value === "near") return <ButlerNearPanel card={card} now={t} />;
	const linked = card.thread
		? linkedCount(card, current.value, board.value?.sessions ?? [])
		: 0;
	return (
		<div class={`butler-card-body butler-${card.state}`}>
			<div class="butler-card-head">
				{card.selfFix ? (
					<SelfFixIcon size={16} class="butler-card-kind-icon" />
				) : (
					<ButlerMark size={16} />
				)}
				<span class="butler-card-kind">{kindOf(card)}</span>
				{card.watching && (
					<ButlerWatchingIcon
						size={16}
						class="butler-watching-icon"
						aria-label="Butler is watching"
					/>
				)}
				<span class="butler-card-badge">
					<ActivityBadge activity={card.state} />
				</span>
			</div>
			<p class="butler-card-title">{card.title}</p>
			<ParentLine card={card} />
			{card.status && (
				<div
					class={
						card.state === "needs-you"
							? "butler-card-status butler-card-needs"
							: "butler-card-status"
					}
					title={card.status}
				>
					{card.status}
				</div>
			)}
			<div class="butler-card-foot">
				<ButlerAvatar size={16} />
				<span>Butler · {ago(card.updatedAt, t)}</span>
				{linked > 0 && (
					<span
						class="butler-card-linked"
						title="Cards and sessions it started"
					>
						↳ {linked} linked
					</span>
				)}
				{card.link && (
					<a
						class="butler-card-link"
						href={card.link}
						target="_blank"
						rel="noopener noreferrer"
					>
						{linkLabel(card)}
					</a>
				)}
			</div>
		</div>
	);
}

/** The bow-tie byline on a note Butler wrote. */
export function ButlerByline(props: { note: Note }): JSX.Element | null {
	if (props.note.author !== "butler") return null;
	return (
		<div class="butler-byline">
			<ButlerNoteIcon size={14} />
			<span>Butler</span>
		</div>
	);
}

function rectOf(target: string): Rect | null {
	const node = arrangement.value?.nodes.get(
		nodeKey({ kind: "session", id: target }),
	);
	if (node) return node;
	const annotation = current.value[target];
	if (annotation) return annotation;
	// A message Butler is answering, pinned where Aaron left it.
	const thread = threads.value.get(target);
	return thread ? { x: thread.x, y: thread.y, w: 0, h: 0 } : null;
}

/** Keeps a chip legible when the board is zoomed out. */
function chipScale(): number {
	return Math.min(3, Math.max(1, 0.85 / view.value.k));
}

/**
 * Butler's presence on the board: his face on what he is looking at, his
 * cursor on what he is working on, and the monocle on every session he watches.
 */
export function ButlerLayer(): JSX.Element {
	const state = butlerPresence.value;
	const { face, cursor } = presenceOf(
		state,
		current.value,
		threads.value.values(),
		now.value,
	);
	const faceAt = face ? rectOf(face.target) : null;
	const cursorAt = cursor ? rectOf(cursor.target) : null;
	const scale = chipScale();
	return (
		<>
			{state.watching.flatMap((id) => {
				const watched = rectOf(id);
				if (!watched) return [];
				return [
					<div
						key={`watch-${id}`}
						class="butler-watching-chip"
						style={{
							transform: `translate(${watched.x + watched.w}px, ${watched.y}px) scale(${scale}) translate(-100%, -100%)`,
						}}
					>
						<ButlerWatchingIcon size={14} />
						Butler is watching
					</div>,
				];
			})}
			{face && faceAt && (
				<div
					class="butler-presence-avatar"
					style={{
						transform: `translate(${faceAt.x}px, ${faceAt.y}px) scale(${scale}) translate(-50%, -50%)`,
					}}
				>
					<ButlerAvatar size={28} label={`${face.label} is looking here`} />
				</div>
			)}
			{cursor && cursorAt && (
				<div
					class="butler-presence-cursor"
					style={{
						transform: `translate(${cursorAt.x + cursorAt.w * 0.68}px, ${cursorAt.y + cursorAt.h * 0.58}px) scale(${scale})`,
					}}
				>
					<ButlerCursor label={cursor.label} />
				</div>
			)}
		</>
	);
}
