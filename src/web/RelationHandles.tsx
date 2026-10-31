import type { JSX } from "preact";
import type { Point, RelationEnd } from "../shared/types.ts";
import { current as shownAnnotations } from "./annotations.ts";
import { arrangement } from "./arrangement.ts";
import { boardPointAt } from "./Canvas.tsx";
import { type Side, sidePoint, sides } from "./geometry.ts";
import {
	type Linkable,
	linkableAt,
	linkables,
	linkDraft,
	linkError,
	rectOfEnd,
} from "./linking.ts";
import { createRelation, relations } from "./relationState.ts";
import "./relations.css";
import { board } from "./state.ts";

const dragThreshold = 4;
const errorMs = 4000;

type Gesture = {
	pointerId: number;
	handle: Element;
	from: RelationEnd;
	side: Side;
	start: Point;
	client: Point;
	candidates: Linkable[];
	moved: boolean;
};

let gesture: Gesture | null = null;
let errorTimer: ReturnType<typeof setTimeout> | undefined;

function showError(at: Point, text: string): void {
	clearTimeout(errorTimer);
	linkError.value = { at, text };
	errorTimer = setTimeout(() => {
		linkError.value = null;
	}, errorMs);
}

function setArranging(on: boolean): void {
	document.querySelector(".viewport")?.classList.toggle("arranging", on);
}

function follow(on: boolean): void {
	const toggle = on ? addEventListener : removeEventListener;
	toggle("pointermove", continueLink);
	toggle("pointerup", endLink);
	toggle("pointercancel", endLink);
	toggle("keydown", escapeLink, true);
}

type Finished = { at: Point; to: RelationEnd };

function finish(): Finished | null {
	const ended = gesture;
	gesture = null;
	follow(false);
	const draft = linkDraft.peek();
	linkDraft.value = null;
	if (!ended?.moved) return null;
	setArranging(false);
	return draft?.over ? { at: draft.at, to: draft.over } : null;
}

function beginLink(event: PointerEvent, from: RelationEnd, side: Side): void {
	if (event.button !== 0) return;
	event.stopPropagation();
	event.preventDefault();
	if (gesture) return;
	const nodes = arrangement.peek()?.nodes ?? new Map();
	const annotations = shownAnnotations.peek();
	const rect = rectOfEnd(from, nodes, annotations);
	const start = rect
		? sidePoint(rect, side)
		: boardPointAt(event.clientX, event.clientY);
	if (!start) return;
	gesture = {
		pointerId: event.pointerId,
		handle: event.currentTarget as Element,
		from,
		side,
		start,
		client: { x: event.clientX, y: event.clientY },
		candidates: linkables(nodes, board.peek()?.sessions ?? [], annotations),
		moved: false,
	};
	follow(true);
}

function continueLink(event: PointerEvent): void {
	if (!gesture || event.pointerId !== gesture.pointerId) return;
	const dx = event.clientX - gesture.client.x;
	const dy = event.clientY - gesture.client.y;
	if (!gesture.moved && Math.hypot(dx, dy) < dragThreshold) return;
	if (!gesture.moved) {
		gesture.handle.setPointerCapture(gesture.pointerId);
		gesture.moved = true;
		setArranging(true);
	}
	const at = boardPointAt(event.clientX, event.clientY);
	if (!at) return;
	const { from, side, start, candidates } = gesture;
	linkDraft.value = {
		from,
		side,
		start,
		at,
		over: linkableAt(at, candidates, from, relations.peek()),
	};
}

function endLink(event: PointerEvent): void {
	if (!gesture || event.pointerId !== gesture.pointerId) return;
	const from = gesture.from;
	const ended = finish();
	if (event.type !== "pointerup" || !ended) return;
	void createRelation({ from, to: ended.to }).then((error) => {
		if (error) showError(ended.at, error);
	});
}

function escapeLink(event: KeyboardEvent): void {
	if (event.key !== "Escape" || !gesture) return;
	event.stopPropagation();
	event.preventDefault();
	finish();
}

export function RelationHandles(props: { end: RelationEnd }): JSX.Element {
	return (
		<>
			{sides.map((side) => (
				<span
					key={side}
					class="relation-handle"
					data-side={side}
					data-no-pan
					aria-hidden="true"
					onPointerDown={(event) => beginLink(event, props.end, side)}
				/>
			))}
		</>
	);
}
