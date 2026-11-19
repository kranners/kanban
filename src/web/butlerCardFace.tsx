import { Pin } from "lucide-preact";
import type { JSX } from "preact";
import type { ButlerCard } from "../shared/types.ts";
import { ButlerWatchingIcon } from "./Butler.tsx";
import { CardFoot } from "./cardBody.tsx";
import { threadKindLabels } from "./threadKinds.ts";

// The parts of one of Butler's cards that come from the card alone.

/** What a Butler card is: a change, one of his Discord threads by its kind, or one he made. */
export function kindOf(card: ButlerCard): string {
	if (card.selfFix) return "Change";
	if (card.thread) return threadKindLabels[card.thread.kind];
	return "Butler";
}

/** What a Butler card's bar names it: its kind, or a change's cloud session. */
export function barName(card: ButlerCard): string {
	return card.selfFix && !card.thread ? "Cloud session" : kindOf(card);
}

/** The thread's engine when it is not Claude, its mission, the machines it drove and whether its question may be stale, as chips; nothing when it has none. */
export function ButlerChips(props: { card: ButlerCard }): JSX.Element | null {
	const { mission, machines, stale } = props.card;
	const engine = props.card.engine === "Claude" ? undefined : props.card.engine;
	if (!engine && !mission && !machines?.length && !stale) return null;
	return (
		<div class="butler-card-chips">
			{engine && (
				<span class="butler-chip butler-chip-engine" title={`Ran on ${engine}`}>
					{engine}
				</span>
			)}
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

export function CardLink(props: { card: ButlerCard }) {
	const { card } = props;
	if (!card.link) return null;
	return (
		<a
			class="butler-card-link"
			href={card.link}
			target="_blank"
			rel="noopener noreferrer"
		>
			{card.thread ? "Open in Discord ↗" : "Open session ↗"}
		</a>
	);
}

export function WatchingMark(props: { card: ButlerCard; size: number }) {
	if (!props.card.watching) return null;
	return (
		<ButlerWatchingIcon size={props.size} aria-label="Butler is watching" />
	);
}

/** A Butler card's foot: its kind, how many it started, its marks and link. */
export function ButlerCardFootView(props: {
	card: ButlerCard;
	linked: number;
	now: number;
}) {
	const { card, linked } = props;
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
