import { signal } from "@preact/signals";
import { Maximize, Minus, Plus } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Point } from "../shared/types.ts";
import type { Arranging } from "./arrangement.ts";
import { dotGrid, snap, snapWithin } from "./grid.ts";
import type { NodeKey } from "./layout.ts";
import type { Bounds, Rect } from "./placement.ts";
import { maxSessionSize, minSessionSize } from "./placement.ts";
import type { Span, View } from "./viewport.ts";
import {
	centredOn,
	fitPadding,
	fitView,
	fromOrigin,
	initialView,
	toBoard,
	toScreen,
	zoomAround,
} from "./viewport.ts";

export const view = signal<View>({ x: 0, y: 0, k: 1 });

const dragThreshold = 4;
const touchHoldMs = 350;
let suppressClick = false;
let stage: HTMLDivElement | null = null;

export function boardPointAt(clientX: number, clientY: number): Point | null {
	if (!stage) return null;
	const box = stage.getBoundingClientRect();
	return toBoard(view.value, { x: clientX - box.left, y: clientY - box.top });
}

export const glideMs = 360;
const farZoom = 0.45;

export function centreOn(rect: Rect): void {
	const world = stage?.querySelector<HTMLElement>(".world");
	if (!stage || !world) return;
	world.classList.add("gliding");
	setTimeout(() => world.classList.remove("gliding"), glideMs);
	view.value = centredOn(
		rect,
		{ width: stage.clientWidth, height: stage.clientHeight },
		view.value.k,
	);
}

export function keepInView(rect: Rect): void {
	if (!stage) return;
	const v = view.value;
	const topLeft = toScreen(v, rect);
	const inside =
		topLeft.x >= 0 &&
		topLeft.y >= 0 &&
		topLeft.x + rect.w * v.k <= stage.clientWidth &&
		topLeft.y + rect.h * v.k <= stage.clientHeight;
	if (!inside) centreOn(rect);
}

export function clientPointOf(point: Point): Point | null {
	if (!stage) return null;
	const box = stage.getBoundingClientRect();
	const screen = toScreen(view.value, point);
	return { x: screen.x + box.left, y: screen.y + box.top };
}

type Grab = {
	pointerId: number;
	key: NodeKey;
	mode: Arranging["mode"];
	card: HTMLElement;
	origin: Rect;
	start: Point;
	last: Point;
	rect: Rect;
	moved: boolean;
	held: boolean;
	hold?: ReturnType<typeof setTimeout>;
};

function sameRect(a: Rect, b: Rect): boolean {
	return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function arranged(grab: Grab, dx: number, dy: number): Rect {
	const { origin } = grab;
	if (grab.mode === "move")
		return { ...origin, x: snap(origin.x + dx), y: snap(origin.y + dy) };
	return {
		...origin,
		w: snapWithin(origin.w + dx, minSessionSize.w, maxSessionSize.w),
		h: snapWithin(origin.h + dy, minSessionSize.h, maxSessionSize.h),
	};
}

export function Canvas(props: {
	content: Bounds | null;
	anchor?: Span;
	fitKey: string;
	rectOf?: (key: NodeKey) => Rect | undefined;
	onArrange?: (gesture: Arranging) => void;
	tools?: ComponentChildren;
	children: ComponentChildren;
}) {
	const viewport = useRef<HTMLDivElement>(null);
	const fitted = useRef("");
	const latest = useRef(props);
	latest.current = props;

	const fit = () => {
		const el = viewport.current;
		const content = props.content;
		if (!el || !content) return;
		view.value = fromOrigin(
			fitView(content, { width: el.clientWidth, height: el.clientHeight }),
			content,
		);
	};

	useEffect(() => {
		const el = viewport.current;
		const content = props.content;
		if (!el || !content || fitted.current === props.fitKey) return;
		fitted.current = props.fitKey;
		const anchor = props.anchor;
		view.value = fromOrigin(
			initialView(
				content,
				{ width: el.clientWidth, height: el.clientHeight },
				anchor ? { x: anchor.x - content.x, w: anchor.w } : undefined,
			),
			content,
		);
	});

	useEffect(() => {
		stage = viewport.current;
		return () => {
			stage = null;
		};
	}, []);

	useEffect(() => {
		const el = viewport.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			if ((event.target as Element).closest("[data-scrollable]")) return;
			event.preventDefault();
			const rect = el.getBoundingClientRect();
			const v = view.value;
			if (event.ctrlKey || event.metaKey) {
				const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
				view.value = zoomAround(
					v,
					v.k * factor,
					event.clientX - rect.left,
					event.clientY - rect.top,
				);
			} else {
				view.value = { ...v, x: v.x - event.deltaX, y: v.y - event.deltaY };
			}
		};
		el.addEventListener("wheel", onWheel, { passive: false });

		const pointers = new Map<number, { x: number; y: number }>();
		let start: { x: number; y: number } | null = null;
		let moved = false;
		let pinch: { distance: number; k: number } | null = null;
		let grab: Grab | null = null;

		const grabCard = (event: PointerEvent): Grab | null => {
			const target = event.target as Element;
			const card = target.closest<HTMLElement>("[data-node]");
			const key = card?.dataset.node;
			const rect = key ? latest.current.rectOf?.(key) : undefined;
			if (!card || !key || !rect || !latest.current.onArrange) return null;
			const mode = target.closest("[data-resize]") ? "resize" : "move";
			const point = { x: event.clientX, y: event.clientY };
			const next: Grab = {
				pointerId: event.pointerId,
				key,
				mode,
				card,
				origin: rect,
				start: point,
				last: point,
				rect,
				moved: false,
				held: event.pointerType !== "touch" || mode === "resize",
			};
			if (!next.held) {
				next.hold = setTimeout(() => {
					next.held = true;
					navigator.vibrate?.(10);
				}, touchHoldMs);
			}
			return next;
		};

		const releaseGrab = (): Grab | null => {
			const released = grab;
			if (!released) return null;
			clearTimeout(released.hold);
			if (released.moved) finishGrab("cancel");
			grab = null;
			return released;
		};

		const finishGrab = (phase: "drop" | "cancel") => {
			if (!grab) return;
			const { key, mode, rect, card, moved: wasMoved, hold } = grab;
			clearTimeout(hold);
			grab = null;
			if (!wasMoved) return;
			delete card.dataset.arranging;
			el.classList.remove("arranging");
			latest.current.onArrange?.({ key, mode, rect, phase });
			suppressClick = true;
			setTimeout(() => {
				suppressClick = false;
			}, 0);
		};

		const moveGrab = (event: PointerEvent) => {
			if (!grab || event.pointerId !== grab.pointerId) return;
			grab.last = { x: event.clientX, y: event.clientY };
			const dx = event.clientX - grab.start.x;
			const dy = event.clientY - grab.start.y;
			if (!grab.moved && Math.hypot(dx, dy) < dragThreshold) return;
			if (!grab.held) {
				const released = releaseGrab();
				if (released) panFrom(released.pointerId, released.start);
				onMove(event);
				return;
			}
			if (!grab.moved) {
				grab.moved = true;
				el.setPointerCapture(event.pointerId);
				el.classList.add("arranging");
				grab.card.dataset.arranging = grab.mode;
			}
			const k = view.value.k;
			const rect = arranged(grab, dx / k, dy / k);
			if (sameRect(rect, grab.rect)) return;
			grab.rect = rect;
			latest.current.onArrange?.({
				key: grab.key,
				mode: grab.mode,
				rect,
				phase: "move",
			});
		};

		const spread = () => {
			const [a, b] = [...pointers.values()];
			if (!a || !b) return null;
			return {
				distance: Math.hypot(a.x - b.x, a.y - b.y),
				mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
			};
		};

		const panFrom = (pointerId: number, point: Point) => {
			pointers.set(pointerId, point);
			start = point;
			moved = false;
		};

		const onDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			if (grab) {
				if (event.pointerType !== "touch") return;
				const released = releaseGrab();
				if (released) panFrom(released.pointerId, released.last);
			}
			const target = event.target as Element;
			if (target.closest("input, [data-no-pan]")) return;
			if (target.closest("a") && !target.closest("[data-node]")) return;
			if (pointers.size === 0) {
				grab = grabCard(event);
				if (grab) return;
			}
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			start = { x: event.clientX, y: event.clientY };
			moved = false;
			const s = spread();
			pinch = s ? { distance: s.distance, k: view.value.k } : null;
		};
		const onMove = (event: PointerEvent) => {
			if (grab) {
				moveGrab(event);
				return;
			}
			const last = pointers.get(event.pointerId);
			if (!last) return;
			const current = { x: event.clientX, y: event.clientY };
			pointers.set(event.pointerId, current);
			if (pinch) {
				const s = spread();
				if (!s) return;
				const rect = el.getBoundingClientRect();
				const zoomed = zoomAround(
					view.value,
					pinch.k * (s.distance / pinch.distance),
					s.mid.x - rect.left,
					s.mid.y - rect.top,
				);
				view.value = {
					...zoomed,
					x: zoomed.x + (current.x - last.x) / 2,
					y: zoomed.y + (current.y - last.y) / 2,
				};
				moved = true;
				return;
			}
			if (
				!moved &&
				start &&
				Math.hypot(current.x - start.x, current.y - start.y) < dragThreshold
			)
				return;
			if (!moved) {
				moved = true;
				el.setPointerCapture(event.pointerId);
				el.classList.add("panning");
			}
			const v = view.value;
			view.value = {
				...v,
				x: v.x + current.x - last.x,
				y: v.y + current.y - last.y,
			};
		};
		const onUp = (event: PointerEvent) => {
			if (grab && event.pointerId === grab.pointerId) {
				finishGrab(event.type === "pointercancel" ? "cancel" : "drop");
				return;
			}
			if (!pointers.delete(event.pointerId)) return;
			if (pointers.size < 2) pinch = null;
			if (pointers.size === 0) {
				el.classList.remove("panning");
				suppressClick = moved;
				setTimeout(() => {
					suppressClick = false;
				}, 0);
			}
		};
		const onClickCapture = (event: MouseEvent) => {
			if (suppressClick) {
				event.stopPropagation();
				event.preventDefault();
			}
		};
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target as Element;
			if (!target.closest(".world") || !target.matches(":focus-visible"))
				return;
			const box = el.getBoundingClientRect();
			const card = target.getBoundingClientRect();
			const shift = (start: number, end: number, from: number, to: number) => {
				if (start < from + fitPadding) return from + fitPadding - start;
				if (end > to - fitPadding) return to - fitPadding - end;
				return 0;
			};
			const v = view.value;
			view.value = {
				...v,
				x: v.x + shift(card.left, card.right, box.left, box.right),
				y: v.y + shift(card.top, card.bottom, box.top, box.bottom),
			};
		};
		el.addEventListener("focusin", onFocusIn);
		el.addEventListener("pointerdown", onDown);
		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerup", onUp);
		el.addEventListener("pointercancel", onUp);
		el.addEventListener("click", onClickCapture, true);
		return () => {
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("focusin", onFocusIn);
			el.removeEventListener("pointerdown", onDown);
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerup", onUp);
			el.removeEventListener("pointercancel", onUp);
			el.removeEventListener("click", onClickCapture, true);
		};
	}, []);

	const zoomBy = (factor: number) => {
		const el = viewport.current;
		if (!el) return;
		view.value = zoomAround(
			view.value,
			view.value.k * factor,
			el.clientWidth / 2,
			el.clientHeight / 2,
		);
	};

	const v = view.value;
	const dots = dotGrid(v);
	return (
		<div
			class="viewport"
			ref={viewport}
			style={{
				"--dot-spacing": `${dots.spacing}px`,
				"--dot-x": `${dots.x}px`,
				"--dot-y": `${dots.y}px`,
				"--dot-fade": dots.fade,
			}}
		>
			<div
				class="world"
				data-far={v.k < farZoom ? "" : undefined}
				style={{
					transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})`,
					"--unzoom": Math.max(1, 1 / v.k),
				}}
			>
				{props.children}
			</div>
			<div class="zoom" data-no-pan>
				<button
					type="button"
					class="icon-button"
					onClick={() => zoomBy(1 / 1.2)}
					aria-label="Zoom out"
					title="Zoom out"
				>
					<Minus size={16} />
				</button>
				<span class="zoom-level num">{Math.round(v.k * 100)}%</span>
				<button
					type="button"
					class="icon-button"
					onClick={() => zoomBy(1.2)}
					aria-label="Zoom in"
					title="Zoom in"
				>
					<Plus size={16} />
				</button>
				<span class="zoom-sep" />
				<button
					type="button"
					class="icon-button"
					onClick={fit}
					aria-label="Fit to view"
					title="Fit to view"
				>
					<Maximize size={15} />
				</button>
				{props.tools && (
					<>
						<span class="zoom-sep" />
						{props.tools}
					</>
				)}
			</div>
		</div>
	);
}
