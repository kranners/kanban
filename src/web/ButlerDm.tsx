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
	type Activity,
	activityOf,
	anchorSpot,
	type Box,
	cornerSpot,
	type DmDock,
	defaultDock,
	dockAt,
	dockButtonShown,
	dockButtonSpot,
	dockStorageKey,
	faceHoldMs,
	faceShown,
	isDmKey,
	labelOnLeft,
	newActivity,
	parseDock,
	pastThreshold,
	placeFace,
	ringOf,
	type Spot,
} from "./butlerDm.ts";
import { faceSettings } from "./butlerFaceSettings.ts";
import { openParent, openThreadCard } from "./butlerThreads.ts";
import { clientPointOf, view } from "./Canvas.tsx";
import { threads } from "./comments.ts";
import { blocked, isTyping } from "./Spawning.tsx";
import { now } from "./state.ts";

// Butler's DM with Aaron, as his face over the board rather than a card on
// it: the mood of his latest reply, a ring for the DM's state, its one-line
// status and how many approvals wait. It shows only while Butler is doing
// something (unless the board's settings say always or never), snaps
// beside what he is touching, docks in a corner when dropped there, and
// hides a few seconds after he stops, leaving a small button that opens
// the DM.

/** The page's fixed controls the face keeps off. */
// Fixed controls, and the controls drawn on the board: region bars and their buttons, edge pills.
const controlSelector =
	".topbar, .rail, .zoom, .message-butler-fab, .project-bar, .region-corner, .butler-edge-pill";

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
		: anchorSpot(dock.anchor, size, port);
}

type Drag = {
	pointerId: number;
	start: Spot;
	offset: Spot;
	moved: boolean;
};

function DmFace(props: {
	dm: ButlerDm;
	onHold: (held: boolean) => void;
}): JSX.Element {
	const { dm, onHold } = props;
	const element = useRef<HTMLButtonElement>(null);
	const [dock, setDock] = useState<DmDock>(readDock);
	const [spot, setSpot] = useState<Spot | null>(null);
	const [dragging, setDragging] = useState(false);
	const [tick, setTick] = useState(0);
	// Placed once without a transition, so it appears where it belongs rather than sliding in.
	const [settled, setSettled] = useState(false);
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
		const resized = () => setTick((n) => n + 1);
		window.addEventListener("resize", resized);
		const frame = requestAnimationFrame(() => setSettled(true));
		return () => {
			cancelAnimationFrame(frame);
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
			class={`dm-face dm-ring-${ring}${left ? " dm-face-left" : ""}${dragging ? " dm-face-dragging" : ""}${settled ? "" : " dm-face-placing"}`}
			style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
			data-no-pan
			aria-label={label}
			title={`${label}. Drag to a corner to dock it. B opens the DM.`}
			onPointerEnter={() => onHold(true)}
			onPointerLeave={() => {
				if (!drag.current) onHold(false);
			}}
			onFocus={() => onHold(true)}
			onBlur={() => onHold(false)}
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
				onHold(false);
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
						<img
							key={dm.mood}
							class="dm-face-mood"
							src={moodFaces[dm.mood]}
							alt=""
							draggable={false}
						/>
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

/** The small face the DM leaves in the board's corner while hidden; it opens the DM. */
function DockButton(props: { dm: ButlerDm }): JSX.Element {
	const { dm } = props;
	const [spot, setSpot] = useState<Spot | null>(null);
	const [tick, setTick] = useState(0);
	const k = view.value;

	useEffect(() => {
		const resized = () => setTick((n) => n + 1);
		window.addEventListener("resize", resized);
		return () => window.removeEventListener("resize", resized);
	}, []);

	useLayoutEffect(() => {
		// The board's canvas, or the main area while it has none, short of the rail.
		const area = (
			document.querySelector(".viewport") ?? document.querySelector(".main")
		)?.getBoundingClientRect();
		if (!area) return;
		const rail = document.querySelector(".rail")?.getBoundingClientRect();
		const right =
			rail && rail.width > 0 && rail.left > area.left
				? Math.min(area.right, rail.left)
				: area.right;
		setSpot(
			dockButtonSpot(
				{ x: area.left, y: area.top, w: right - area.left, h: area.height },
				controlBoxes(),
			),
		);
	}, [tick, k]);

	const label = `Open Butler's DM${dm.waiting > 0 ? `, ${dm.waiting} waiting on you` : ""} (B)`;
	return (
		<button
			type="button"
			class="dm-dock"
			style={spot ? { left: `${spot.x}px`, top: `${spot.y}px` } : undefined}
			hidden={!spot}
			data-no-pan
			aria-label={label}
			title={label}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				openThreadCard.value = dm.thread;
			}}
		>
			{dm.mood ? (
				<img src={moodFaces[dm.mood]} alt="" draggable={false} />
			) : (
				<ButlerAvatar size={22} />
			)}
			{dm.waiting > 0 && <span class="dm-dock-badge" aria-hidden="true" />}
		</button>
	);
}

/**
 * Butler's DM face, shown at every zoom while the daemon lists a DM: up
 * while he is active and for a few seconds after, otherwise the small
 * dock button, unless the board's settings say otherwise.
 */
export function ButlerDmFace(): JSX.Element | null {
	const presence = butlerPresence.value;
	const dm = presence.dm;
	const settings = faceSettings.value;
	const seen = useRef<Activity | null>(null);
	const [lastActive, setLastActive] = useState<number | null>(null);
	const [held, setHeld] = useState(false);
	const [clock, setClock] = useState(Date.now());

	useEffect(() => {
		const next = activityOf(presence);
		const at = newActivity(seen.current, next, Date.now());
		seen.current = next;
		if (at !== null) setLastActive((last) => Math.max(last ?? 0, at));
	}, [presence]);

	// Wake once the hold runs out, so the face hides on time.
	useEffect(() => {
		if (lastActive === null) return;
		const left = lastActive + faceHoldMs - Date.now();
		if (left <= 0) return;
		const timer = setTimeout(() => setClock(Date.now()), left + 20);
		return () => clearTimeout(timer);
	}, [lastActive]);

	useEffect(() => {
		if (!dm) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isDmKey(event, isTyping(event.target)) || blocked()) return;
			event.preventDefault();
			openThreadCard.value = dm.thread;
		};
		addEventListener("keydown", onKeyDown);
		return () => removeEventListener("keydown", onKeyDown);
	}, [dm?.thread]);

	if (!dm) return null;
	const up = faceShown({
		mode: settings.mode,
		lastActive,
		now: Math.max(clock, Date.now()),
		held,
	});
	if (up) return <DmFace dm={dm} onHold={setHeld} />;
	return dockButtonShown(settings, up) ? <DockButton dm={dm} /> : null;
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
