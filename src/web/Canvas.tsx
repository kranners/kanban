import { signal } from "@preact/signals";
import { Maximize, Minus, Plus } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Size, Span, View } from "./viewport.ts";
import { fitPadding, fitView, initialView, zoomAround } from "./viewport.ts";

export const view = signal<View>({ x: 0, y: 0, k: 1 });

const dragThreshold = 4;
let suppressClick = false;

export function Canvas(props: {
	content: Size | null;
	anchor?: Span;
	fitKey: string;
	children: ComponentChildren;
}) {
	const viewport = useRef<HTMLDivElement>(null);
	const fitted = useRef("");

	const fit = () => {
		const el = viewport.current;
		if (!el || !props.content) return;
		view.value = fitView(props.content, {
			width: el.clientWidth,
			height: el.clientHeight,
		});
	};

	useEffect(() => {
		const el = viewport.current;
		if (!el || !props.content || fitted.current === props.fitKey) return;
		fitted.current = props.fitKey;
		view.value = initialView(
			props.content,
			{ width: el.clientWidth, height: el.clientHeight },
			props.anchor,
		);
	});

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

		const spread = () => {
			const [a, b] = [...pointers.values()];
			if (!a || !b) return null;
			return {
				distance: Math.hypot(a.x - b.x, a.y - b.y),
				mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
			};
		};

		const onDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			if ((event.target as Element).closest("input, a, [data-no-pan]")) return;
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			start = { x: event.clientX, y: event.clientY };
			moved = false;
			const s = spread();
			pinch = s ? { distance: s.distance, k: view.value.k } : null;
		};
		const onMove = (event: PointerEvent) => {
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
	return (
		<div class="viewport" ref={viewport}>
			<div
				class="world"
				style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})` }}
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
			</div>
		</div>
	);
}
