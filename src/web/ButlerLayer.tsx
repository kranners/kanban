import "./butler.css";
import { Pin } from "lucide-preact";
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
import { butlerPresence, presenceOf } from "./butler.ts";
import { butlerLanes } from "./butlerCards.ts";
import { linkedCount, threadKindLabels } from "./butlerThreads.ts";
import { centreOn, detail, view } from "./Canvas.tsx";
import { SubagentChips } from "./Card.tsx";
import { CardFace } from "./CardFace.tsx";
import { CardBody, CardFoot, NearPanel } from "./CardParts.tsx";
import {
	authorFilter,
	butlerCardView,
	type CardView,
	dimmedByAuthor,
} from "./cardFace.ts";
import { threads } from "./comments.ts";
import { nodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";
import { board, now } from "./state.ts";

/** What a Butler card is: a change, one of his Discord threads by its kind, or one he made. */
function kindOf(card: ButlerCard): string {
	if (card.selfFix) return "Change";
	if (card.thread) return threadKindLabels[card.thread.kind];
	return "Butler";
}

function linkLabel(card: ButlerCard): string {
	return card.thread ? "Open in Discord ↗" : "Open session ↗";
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

function CardLink(props: { card: ButlerCard }) {
	const { card } = props;
	if (!card.link) return null;
	return (
		<a
			class="butler-card-link"
			href={card.link}
			target="_blank"
			rel="noopener noreferrer"
		>
			{linkLabel(card)}
		</a>
	);
}

function WatchingMark(props: { card: ButlerCard; size: number }) {
	if (!props.card.watching) return null;
	return (
		<ButlerWatchingIcon
			size={props.size}
			class="butler-watching-icon"
			aria-label="Butler is watching"
		/>
	);
}

/** A Butler card zoomed in: the same near view as a session's, with its link, chips, summary and timeline. */
function ButlerNearPanel(props: {
	card: ButlerCard;
	view: CardView;
	now: number;
}): JSX.Element {
	const { card } = props;
	const kind = kindOf(card);
	return (
		<NearPanel
			view={props.view}
			now={props.now}
			class={`butler-near butler-${card.state}`}
			name={<span class="near-name">{kind}</span>}
			marks={<WatchingMark card={card} size={16} />}
			extras={
				<>
					<CardLink card={card} />
					<ButlerChips card={card} />
					<CardSubagentChips card={card} now={props.now} />
				</>
			}
			side={
				card.summary && (
					<section class="detail-section" aria-label="Summary">
						<div class="detail-head">
							<span>Summary</span>
						</div>
						<p class="butler-near-summary">{card.summary}</p>
					</section>
				)
			}
			lanes={butlerLanes(card, props.now)}
			timeline={`${kind} timeline`}
		/>
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
		<CardFoot
			label={kindOf(card)}
			beside={
				linked > 0 && (
					<span
						class="butler-card-linked"
						title="Cards and sessions it started"
					>
						↳ {linked} linked
					</span>
				)
			}
			marks={
				<>
					{card.pinned && (
						<Pin
							size={13}
							class="butler-pinned-icon"
							aria-label="Pinned: Tidy leaves it here"
						/>
					)}
					<WatchingMark card={card} size={14} />
					<CardLink card={card} />
				</>
			}
			updatedAt={card.updatedAt}
			now={props.now}
		/>
	);
}

/**
 * One of Butler's cards, a thread, desk session, job or change, drawn by
 * the same card face and parts as a session, with its author on the bar.
 * Away from near zoom nothing in it scrolls, so the wheel always moves the board.
 */
export function ButlerCardBody(props: {
	card: ButlerCard;
	region?: RegionColour;
}): JSX.Element {
	const { card } = props;
	const t = now.value;
	const view = butlerCardView(card, t);
	return (
		<CardFace
			status={view.status}
			lastActivity={view.lastActivity}
			author={view.author}
			name={barName(card)}
			now={t}
			class={[
				"butler-face",
				dimmedByAuthor(view.author, authorFilter.value) && "dimmed",
				props.region && `grouped region region-${props.region}`,
			]
				.filter(Boolean)
				.join(" ")}
			frame={
				detail.value === "near" ? (
					<ButlerNearPanel card={card} view={view} now={t} />
				) : (
					<>
						<CardBody
							view={view}
							after={<ButlerChips card={card} />}
							subagents={<CardSubagentChips card={card} now={t} />}
						/>
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
