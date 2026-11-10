import "./butler.css";
import { Pin, TriangleAlert } from "lucide-preact";
import type { JSX } from "preact";
import type { RegionColour } from "../shared/colours.ts";
import type { ButlerCard, Note } from "../shared/types.ts";
import { current } from "./annotations.ts";
import { arrangement } from "./arrangement.ts";
import {
	ButlerAvatar,
	ButlerCursor,
	ButlerNoteIcon,
	ButlerWatchingIcon,
} from "./Butler.tsx";
import { FromDmChip } from "./ButlerDm.tsx";
import { butlerPresence, presenceOf } from "./butler.ts";
import { butlerLanes } from "./butlerCards.ts";
import {
	isFromDm,
	linkedCount,
	openParent,
	parentTitle,
	threadKindLabels,
} from "./butlerThreads.ts";
import { centreOn, detail, view } from "./Canvas.tsx";
import { SubagentChips } from "./Card.tsx";
import { AuthorChip, CardFace, StatusBadge } from "./CardFace.tsx";
import {
	authorFilter,
	butlerCardAuthor,
	butlerCardLastActivity,
	dimmedByAuthor,
	statusOf,
} from "./cardFace.ts";
import { threads } from "./comments.ts";
import { nodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";
import { board, now } from "./state.ts";
import { Timeline } from "./Timeline.tsx";
import { relativeTime } from "./time.ts";

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
	const { parent } = props.card;
	if (
		isFromDm({ card: parent }, butlerPresence.value.dm?.thread, current.value)
	) {
		return <FromDmChip parent={parent} />;
	}
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

/** The thread's mission, the machines it drove and whether its question may be stale, as chips; nothing when it has none. */
function ButlerChips(props: { card: ButlerCard }): JSX.Element | null {
	const { mission, machines, stale } = props.card;
	if (!mission && !machines?.length && !stale) return null;
	return (
		<div class="butler-card-chips">
			{stale && (
				<span class="butler-chip" title="Its question has waited over 6 hours">
					stale?
				</span>
			)}
			{mission && (
				<span
					class="butler-chip butler-chip-mission"
					title={mission.covers || `Mission ${mission.id}`}
				>
					Mission {mission.id}
				</span>
			)}
			{machines?.map((machine) => (
				<span key={machine} class="butler-chip">
					{machine}
				</span>
			))}
		</div>
	);
}

/** A Butler card's subagents as chips, each centring the board on its own card. */
function CardSubagentChips(props: { card: ButlerCard; now: number }) {
	return (
		<SubagentChips
			owner={props.card.id}
			now={props.now}
			onOpen={(subagent) => {
				const node = arrangement
					.peek()
					?.nodes.get(nodeKey({ kind: "subagent", id: subagent.id }));
				if (node) centreOn(node);
			}}
		/>
	);
}

/** A Butler card zoomed in, laid out as a session card's near view, with its timeline. */
function ButlerNearPanel(props: {
	card: ButlerCard;
	now: number;
}): JSX.Element {
	const { card } = props;
	const kind = kindOf(card);
	const lastActivity = butlerCardLastActivity(card);
	return (
		<div class={`near-panel butler-near butler-${card.state}`} data-scrollable>
			<header class="near-head">
				<div class="near-meta">
					<StatusBadge
						status={statusOf(card.state, lastActivity, props.now)}
						lastActivity={lastActivity}
						now={props.now}
					/>
					<span class="near-name butler-near-kind">
						<AuthorChip author={butlerCardAuthor(card)} />
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
				<ButlerChips card={card} />
				<CardSubagentChips card={card} now={props.now} />
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

/** What a Butler card's bar names it: its kind, or a change's cloud session. */
function barName(card: ButlerCard): string {
	return card.selfFix && !card.thread ? "Cloud session" : kindOf(card);
}

function ButlerCardFoot(props: { card: ButlerCard; now: number }) {
	const { card } = props;
	const linked = card.thread
		? linkedCount(card, current.value, board.value?.sessions ?? [])
		: 0;
	return (
		<div class="foot">
			<span class="foot-project">{kindOf(card)}</span>
			{linked > 0 && (
				<span class="butler-card-linked" title="Cards and sessions it started">
					↳ {linked} linked
				</span>
			)}
			<span class="foot-end">
				{card.pinned && (
					<Pin
						size={13}
						class="butler-pinned-icon"
						aria-label="Pinned: Tidy leaves it here"
					/>
				)}
				{card.watching && (
					<ButlerWatchingIcon
						size={14}
						class="butler-watching-icon"
						aria-label="Butler is watching"
					/>
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
				<time class="num">{relativeTime(card.updatedAt, props.now)}</time>
			</span>
		</div>
	);
}

const idleHint: Record<ButlerCard["state"], string> = {
	working: "Working",
	"needs-you": "Needs you",
	idle: "Between turns",
	done: "Finished",
	failed: "Failed",
};

/**
 * One of Butler's cards, a thread, desk session, job or change, drawn by
 * the same card face as a session, with its author on the bar. Away from
 * near zoom nothing in it scrolls, so the wheel always moves the board.
 */
export function ButlerCardBody(props: {
	card: ButlerCard;
	region?: RegionColour;
}): JSX.Element {
	const { card } = props;
	const t = now.value;
	const author = butlerCardAuthor(card);
	const lastActivity = butlerCardLastActivity(card);
	return (
		<CardFace
			status={statusOf(card.state, lastActivity, t)}
			lastActivity={lastActivity}
			author={author}
			name={barName(card)}
			now={t}
			class={[
				"butler-face",
				dimmedByAuthor(author, authorFilter.value) && "dimmed",
				props.region && `grouped region region-${props.region}`,
			]
				.filter(Boolean)
				.join(" ")}
			frame={
				detail.value === "near" ? (
					<ButlerNearPanel card={card} now={t} />
				) : (
					<>
						<div class="body">
							<p class="goal">{card.title}</p>
							<ParentLine card={card} />
							{card.state === "needs-you" ? (
								<div class="needs" title={card.status}>
									{card.status ?? idleHint[card.state]}
								</div>
							) : (
								<div class="card-doing" title={card.status}>
									{card.status ?? idleHint[card.state]}
								</div>
							)}
							<ButlerChips card={card} />
							<CardSubagentChips card={card} now={t} />
						</div>
						<ButlerCardFoot card={card} now={t} />
					</>
				)
			}
		/>
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

/** Where on the board Butler's target is: a session, an annotation or a message's pin. */
export function butlerTargetRect(target: string): Rect | null {
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
	const faceAt = face && !state.dm ? butlerTargetRect(face.target) : null;
	const cursorAt = cursor ? butlerTargetRect(cursor.target) : null;
	const scale = chipScale();
	return (
		<>
			{state.watching.flatMap((id) => {
				const watched = butlerTargetRect(id);
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
			{/* With the DM face on screen it is Butler's face; only his cursor goes on the board. */}
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
