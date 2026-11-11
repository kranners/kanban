import "./butler.css";
import type { JSX } from "preact";
import type { Note } from "../shared/types.ts";
import { current } from "./annotations.ts";
import { arrangement } from "./arrangement.ts";
import {
	ButlerAvatar,
	ButlerCursor,
	ButlerNoteIcon,
	ButlerWatchingIcon,
} from "./Butler.tsx";
import { butlerPresence, presenceOf } from "./butler.ts";
import { view } from "./Canvas.tsx";
import { threads } from "./comments.ts";
import { nodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";
import { now } from "./state.ts";

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
