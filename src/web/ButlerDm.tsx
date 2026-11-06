import "./butlerDm.css";
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ButlerDm } from "../shared/types.ts";
import { current } from "./annotations.ts";
import { arrangement } from "./arrangement.ts";
import { ButlerAvatar } from "./Butler.tsx";
import { butlerTargetRect } from "./ButlerLayer.tsx";
import { moodFaces } from "./butler/moods.ts";
import { butlerPresence, presenceOf } from "./butler.ts";
import {
	type Box,
	cornerSpot,
	type DmDock,
	defaultDock,
	dockAt,
	dockStorageKey,
	driftSpot,
	labelOnLeft,
	parseDock,
	pastThreshold,
	placeFace,
	ringOf,
	type Spot,
} from "./butlerDm.ts";
import { openParent, openThreadCard } from "./butlerThreads.ts";
import { clientPointOf, view } from "./Canvas.tsx";
import { threads } from "./comments.ts";
import { now } from "./state.ts";

// Butler's DM with Aaron, as his face floating over the board rather than a
// card on it: the mood of his latest reply, a ring for the DM's state, its
// one-line status and how many approvals wait. It drifts slowly, parks
// beside what Butler is touching, and docks in a corner when dropped there.

const reducedMotion = () =>
	typeof matchMedia === "function" &&
	matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How often a drifting face picks its next spot; its transition takes as long. */
const stepMs = 2000;

/** The page's fixed controls the face keeps off. */
const controlSelector = ".topbar, .rail, .zoom, .message-butler-fab";

const ringLabels = {
	idle: "idle",
	working: "working",
	waiting: "waiting on you",
	failed: "failed",
} as const;

function readDock(): DmDock {
	try {
		return parseDock(localStorage.getItem(dockStorageKey)) ?? defaultDock;
	} catch {
		return defaultDock;
	}
}

function saveDock(dock: DmDock): void {
	try {
		localStorage.setItem(dockStorageKey, JSON.stringify(dock));
	} catch {}
}

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

/** A board rect on screen, or null when the canvas is not there. */
function onScreen(rect: Box): Box | null {
	const a = clientPointOf({ x: rect.x, y: rect.y });
	const b = clientPointOf({ x: rect.x + rect.w, y: rect.y + rect.h });
	if (!a || !b) return null;
	return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

const visible = (box: Box, port: { w: number; h: number }) =>
	box.x < port.w && box.y < port.h && box.x + box.w > 0 && box.y + box.h > 0;

/** Every session, card, note and sticker on screen. */
function boardBoxes(port: { w: number; h: number }): Box[] {
	const rects: Box[] = [
		...(arrangement.value?.nodes.values() ?? []),
		...Object.values(current.value),
	];
	return rects.flatMap((rect) => {
		const box = onScreen(rect);
		return box && visible(box, port) ? [box] : [];
	});
}

function controlBoxes(): Box[] {
	return [...document.querySelectorAll(controlSelector)].flatMap((el) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0
			? [{ x: r.left, y: r.top, w: r.width, h: r.height }]
			: [];
	});
}

/** What Butler is touching, on screen, if it is in view. */
function touchedBox(port: { w: number; h: number }): Box | null {
	const { face, cursor } = presenceOf(
		butlerPresence.value,
		current.value,
		threads.value.values(),
		now.value,
	);
	const spot = face ?? cursor;
	const rect = spot ? butlerTargetRect(spot.target) : null;
	const box = rect ? onScreen(rect) : null;
	return box && visible(box, port) ? box : null;
}

function wantedSpot(dock: DmDock, size: { w: number; h: number }): Spot {
	const port = viewport();
	return "corner" in dock
		? cornerSpot(dock.corner, size, port)
		: driftSpot(dock.anchor, Date.now(), size, port, reducedMotion());
}

type Drag = {
	pointerId: number;
	start: Spot;
	offset: Spot;
	moved: boolean;
};

function DmFace(props: { dm: ButlerDm }): JSX.Element {
	const { dm } = props;
	const element = useRef<HTMLButtonElement>(null);
	const [dock, setDock] = useState<DmDock>(readDock);
	const [spot, setSpot] = useState<Spot | null>(null);
	const [dragging, setDragging] = useState(false);
	const [tick, setTick] = useState(0);
	const drag = useRef<Drag | null>(null);
	const dragged = useRef(false);

	const size = () => {
		const el = element.current;
		return el ? { w: el.offsetWidth, h: el.offsetHeight } : { w: 220, h: 56 };
	};

	// Read the signals here so the face moves when the board, view or presence does.
	const k = view.value;
	const presence = butlerPresence.value;
	const annotations = current.value;
	const placed = arrangement.value;

	useEffect(() => {
		const timer = setInterval(() => setTick((n) => n + 1), stepMs);
		const resized = () => setTick((n) => n + 1);
		window.addEventListener("resize", resized);
		return () => {
			clearInterval(timer);
			window.removeEventListener("resize", resized);
		};
	}, []);

	// The signals read above are its triggers, so the face moves when the board, view or presence does.
	useLayoutEffect(() => {
		if (drag.current?.moved) return;
		const port = viewport();
		const docked = "corner" in dock;
		setSpot(
			placeFace({
				size: size(),
				viewport: port,
				avoid: docked ? [] : boardBoxes(port),
				controls: controlBoxes(),
				target: docked ? null : touchedBox(port),
				wanted: wantedSpot(dock, size()),
				docked,
			}),
		);
	}, [dock, tick, k, presence, annotations, placed]);

	const ring = ringOf(dm.state, dm.waiting);
	const at = spot ?? wantedSpot(dock, size());
	const left = labelOnLeft(at, size(), viewport());
	const label = `Butler's DM, ${ringLabels[ring]}${dm.waiting > 0 ? `, ${dm.waiting} waiting on you` : ""}${dm.status ? `: ${dm.status}` : ""}`;

	return (
		<button
			type="button"
			ref={element}
			class={`dm-face dm-ring-${ring}${left ? " dm-face-left" : ""}${dragging ? " dm-face-dragging" : ""}`}
			style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
			data-no-pan
			aria-label={label}
			title={`${label}. Drag to a corner to dock it.`}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.stopPropagation();
				dragged.current = false;
				drag.current = {
					pointerId: event.pointerId,
					start: { x: event.clientX, y: event.clientY },
					offset: { x: event.clientX - at.x, y: event.clientY - at.y },
					moved: false,
				};
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				const held = drag.current;
				if (!held || held.pointerId !== event.pointerId) return;
				const point = { x: event.clientX, y: event.clientY };
				if (!held.moved && !pastThreshold(held.start, point)) return;
				held.moved = true;
				setDragging(true);
				setSpot({ x: point.x - held.offset.x, y: point.y - held.offset.y });
			}}
			onPointerUp={(event) => {
				const held = drag.current;
				if (!held || held.pointerId !== event.pointerId) return;
				drag.current = null;
				if (!held.moved) return;
				dragged.current = true;
				setDragging(false);
				const next = dockAt(
					{
						x: event.clientX - held.offset.x,
						y: event.clientY - held.offset.y,
					},
					size(),
					viewport(),
				);
				saveDock(next);
				setDock(next);
			}}
			onPointerCancel={() => {
				drag.current = null;
				setDragging(false);
			}}
			onClick={(event) => {
				event.stopPropagation();
				if (dragged.current) {
					dragged.current = false;
					return;
				}
				openThreadCard.value = dm.thread;
			}}
		>
			<span class="dm-face-ring" aria-hidden="true">
				<span class="dm-face-picture">
					{dm.mood ? (
						<img src={moodFaces[dm.mood]} alt="" draggable={false} />
					) : (
						<ButlerAvatar size={40} />
					)}
				</span>
				{dm.waiting > 0 && <span class="dm-face-badge num">{dm.waiting}</span>}
			</span>
			{dm.status && (
				<span class="dm-face-status" aria-hidden="true">
					{dm.status}
				</span>
			)}
		</button>
	);
}

/** Butler's DM face, shown at every zoom while the daemon lists a DM. */
export function ButlerDmFace(): JSX.Element | null {
	const dm = butlerPresence.value.dm;
	return dm ? <DmFace dm={dm} /> : null;
}

/** "from DM" on a card or session the DM started, which opens the DM. */
export function FromDmChip(props: {
	parent: string | undefined;
	class?: string;
}): JSX.Element {
	const dm = butlerPresence.value.dm;
	return (
		<button
			type="button"
			class={`butler-card-from dm-from${props.class ? ` ${props.class}` : ""}`}
			data-no-pan
			title="Open the DM"
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				if (dm) openThreadCard.value = dm.thread;
				else openParent(props.parent);
			}}
		>
			{dm?.mood ? (
				<img class="dm-from-face" src={moodFaces[dm.mood]} alt="" />
			) : (
				<ButlerAvatar size={12} />
			)}
			from DM
		</button>
	);
}
