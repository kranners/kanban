import "./butler.css";
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
import { view } from "./Canvas.tsx";
import { nodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";
import { now } from "./state.ts";
import { ago } from "./time.ts";

/** One of Butler's cards: a change he started, or one he made himself. */
export function ButlerCardBody(props: { card: ButlerCard }): JSX.Element {
	const { card } = props;
	const t = now.value;
	return (
		<div class={`butler-card-body butler-${card.state}`}>
			<div class="butler-card-head">
				{card.selfFix ? (
					<SelfFixIcon size={16} class="butler-card-kind-icon" />
				) : (
					<ButlerMark size={16} />
				)}
				<span class="butler-card-kind">
					{card.selfFix ? "Change" : "Butler"}
				</span>
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
			<div class="butler-card-title">{card.title}</div>
			{card.status && <div class="butler-card-status">{card.status}</div>}
			{card.summary && <div class="butler-card-summary">{card.summary}</div>}
			<div class="butler-card-foot">
				<ButlerAvatar size={16} />
				<span>Butler · {ago(card.updatedAt, t)}</span>
				{card.link && (
					<a
						class="butler-card-link"
						href={card.link}
						target="_blank"
						rel="noopener noreferrer"
					>
						Open session ↗
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
	return current.value[target] ?? null;
}

/** Keeps a chip legible when the board is zoomed out. */
function chipScale(): number {
	return Math.min(3, Math.max(1, 0.85 / view.value.k));
}

/**
 * Butler's presence on the board: his cursor and avatar on the card he is
 * at, and the monocle on every session he watches.
 */
export function ButlerLayer(): JSX.Element {
	const state = butlerPresence.value;
	const at = presenceOf(state, current.value, now.value);
	const rect = at ? rectOf(at.target) : null;
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
			{at && rect && (
				<>
					<div
						class="butler-presence-avatar"
						style={{
							transform: `translate(${rect.x}px, ${rect.y}px) scale(${scale}) translate(-50%, -50%)`,
						}}
					>
						<ButlerAvatar size={28} label={`${at.label} is here`} />
					</div>
					<div
						class="butler-presence-cursor"
						style={{
							transform: `translate(${rect.x + rect.w * 0.68}px, ${rect.y + rect.h * 0.58}px) scale(${scale})`,
						}}
					>
						<ButlerCursor label={at.label} />
					</div>
				</>
			)}
		</>
	);
}
