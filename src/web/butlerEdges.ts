import { signal } from "@preact/signals";
import type {
	ButlerEdgeEnd,
	ButlerEdgeMessage,
	ButlerEdgeSummary,
	Message,
	Point,
	Session,
} from "../shared/types.ts";
import { type Outcome, request } from "./comments.ts";
import { relativeTime } from "./time.ts";

// The page's side of Butler's message edges: the dotted links between his
// thread cards and the sessions they messaged, each with a count and when
// it last carried something, and the small view that lists the messages
// once Aaron clicks one. The feed carries only counts and times; the words
// come from GET /api/butler/edges alone, while it is open.

/** Butler's message edges of the last day, without their words. */
export const butlerEdges = signal<ButlerEdgeSummary[]>([]);

type Box = { x: number; y: number; w: number; h: number };

/** What the open edge view shows: one way between two ends, or a pair of sessions' messages. */
export type OpenEdge =
	| {
			kind: "butler";
			from: ButlerEdgeEnd;
			to: ButlerEdgeEnd;
			title: string;
			at: Point;
	  }
	| {
			kind: "pair";
			key: string;
			title: string;
			at: Point;
			messages: Pick<Message, "at" | "summary" | "kind">[];
	  };

export const openEdge = signal<OpenEdge | null>(null);

export const edgeEndKey = (end: ButlerEdgeEnd) => `${end.kind}:${end.id}`;

/** Where an end sits on the board, the DM, which has no card, or nowhere. */
export type ResolvedEnd =
	| { kind: "box"; box: Box; label: string }
	| { kind: "dm" }
	| null;

export function resolveEnd(
	end: ButlerEdgeEnd,
	sessions: readonly Session[],
	box: (sessionId: string) => Box | undefined,
	dmThread: string | undefined,
): ResolvedEnd {
	if (end.kind === "thread" && end.id === dmThread) return { kind: "dm" };
	// A thread's card is a session of the board, and a local session Butler started is known by its short id until it lands.
	const session =
		end.kind === "thread"
			? sessions.find((s) => s.id === `thread-${end.id}`)
			: (sessions.find((s) => s.id === end.id) ??
				sessions.find((s) => s.short === end.id));
	const placed = session ? box(session.id) : undefined;
	return session && placed
		? { kind: "box", box: placed, label: session.name }
		: null;
}

/** One dotted link: every message one way between two ends, whatever carried it. */
export type EdgeLine = {
	key: string;
	from: ButlerEdgeEnd;
	to: ButlerEdgeEnd;
	fromBox: Box;
	toBox: Box;
	title: string;
	count: number;
	lastAt: number;
	vias: string[];
};

/** A chip on a card for messages to or from the DM, which has no card to draw a link to. */
export type EdgeChip = {
	key: string;
	from: ButlerEdgeEnd;
	to: ButlerEdgeEnd;
	/** Whether the DM sent them, or received them. */
	fromDm: boolean;
	box: Box;
	/** Its place among the chips on the same card, from 0. */
	index: number;
	title: string;
	count: number;
	lastAt: number;
};

/**
 * The links and DM chips to draw: each pair of ends one way, its vias
 * merged, with only ends on the board drawn, a DM end becoming a chip on
 * the other end, and an edge from an end to itself never drawn.
 */
export function drawnEdges(
	edges: readonly ButlerEdgeSummary[],
	sessions: readonly Session[],
	box: (sessionId: string) => Box | undefined,
	dmThread: string | undefined,
): { lines: EdgeLine[]; chips: EdgeChip[] } {
	const merged = new Map<
		string,
		{
			from: ButlerEdgeEnd;
			to: ButlerEdgeEnd;
			count: number;
			lastAt: number;
			vias: string[];
		}
	>();
	for (const edge of edges) {
		const key = `${edgeEndKey(edge.from)}>${edgeEndKey(edge.to)}`;
		const held = merged.get(key) ?? {
			from: edge.from,
			to: edge.to,
			count: 0,
			lastAt: 0,
			vias: [],
		};
		held.count += edge.count;
		held.lastAt = Math.max(held.lastAt, edge.lastAt);
		if (!held.vias.includes(edge.via)) held.vias.push(edge.via);
		merged.set(key, held);
	}
	const lines: EdgeLine[] = [];
	const chips: EdgeChip[] = [];
	const chipsOn = new Map<string, number>();
	for (const [key, edge] of merged) {
		const from = resolveEnd(edge.from, sessions, box, dmThread);
		const to = resolveEnd(edge.to, sessions, box, dmThread);
		if (!from || !to) continue;
		if (from.kind === "box" && to.kind === "box") {
			if (sameBox(from.box, to.box)) continue;
			lines.push({
				key,
				from: edge.from,
				to: edge.to,
				fromBox: from.box,
				toBox: to.box,
				title: `${from.label} → ${to.label}`,
				count: edge.count,
				lastAt: edge.lastAt,
				vias: edge.vias,
			});
			continue;
		}
		const other = from.kind === "box" ? from : to.kind === "box" ? to : null;
		if (!other) continue;
		const fromDm = from.kind === "dm";
		const onKey = `${other.box.x},${other.box.y}`;
		const index = chipsOn.get(onKey) ?? 0;
		chipsOn.set(onKey, index + 1);
		chips.push({
			key,
			from: edge.from,
			to: edge.to,
			fromDm,
			box: other.box,
			index,
			title: fromDm ? `DM → ${other.label}` : `${other.label} → DM`,
			count: edge.count,
			lastAt: edge.lastAt,
		});
	}
	return { lines, chips };
}

const sameBox = (a: Box, b: Box) =>
	a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** "3 · 4m ago" on a link's pill. */
export function pillLabel(count: number, lastAt: number, now: number): string {
	const when = relativeTime(lastAt, now);
	return `${count} · ${when === "now" ? "just now" : `${when} ago`}`;
}

/** "✉ 2 from DM · 5m" on a DM chip. */
export function chipLabel(chip: EdgeChip, now: number): string {
	return `✉ ${chip.count} ${chip.fromDm ? "from" : "to"} DM · ${relativeTime(chip.lastAt, now)}`;
}

/** Where a DM chip sits: above its card's top right corner, the next one above it. */
export function chipSpot(chip: Pick<EdgeChip, "box" | "index">): Point {
	return { x: chip.box.x + chip.box.w, y: chip.box.y - 6 - chip.index * 24 };
}

const centre = (box: Box): Point => ({
	x: box.x + box.w / 2,
	y: box.y + box.h / 2,
});

/** Where the line from a box's centre toward a point leaves the box. */
function edgeToward(box: Box, target: Point): Point {
	const c = centre(box);
	const dx = target.x - c.x;
	const dy = target.y - c.y;
	const scale = Math.min(
		dx === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(dx),
		dy === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(dy),
		1,
	);
	return { x: c.x + dx * scale, y: c.y + dy * scale };
}

const overlapping = (a: Box, b: Box) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * A gentle curve from one box's edge to the other's, bending the opposite
 * way to the session message arcs so the two never lie on top of each
 * other, and its midpoint for the pill; null when the boxes overlap.
 */
export function edgeCurve(
	from: Box,
	to: Box,
): { path: string; mid: Point } | null {
	if (overlapping(from, to)) return null;
	const a0 = centre(from);
	const b0 = centre(to);
	const dx = b0.x - a0.x;
	const dy = b0.y - a0.y;
	const length = Math.hypot(dx, dy) || 1;
	const bend = Math.min(80, Math.max(24, length * 0.12));
	const control = {
		x: (a0.x + b0.x) / 2 - (dy / length) * bend,
		y: (a0.y + b0.y) / 2 + (dx / length) * bend,
	};
	const a = edgeToward(from, control);
	const b = edgeToward(to, control);
	const round = (n: number) => Math.round(n * 10) / 10;
	return {
		path: `M${round(a.x)} ${round(a.y)} Q${round(control.x)} ${round(control.y)} ${round(b.x)} ${round(b.y)}`,
		mid: {
			x: round(0.25 * a.x + 0.5 * control.x + 0.25 * b.x),
			y: round(0.25 * a.y + 0.5 * control.y + 0.25 * b.y),
		},
	};
}

/** Whether a pair of sessions' messages came through a prompt or claude.ai's remote tools, drawn like Butler's. */
export const isRelayedPair = (messages: readonly Pick<Message, "kind">[]) =>
	messages.some((m) => m.kind === "cloud" || m.kind === "prompt");

export function fetchEdgeMessages(
	from: ButlerEdgeEnd,
	to: ButlerEdgeEnd,
): Promise<Outcome<{ messages: ButlerEdgeMessage[] }>> {
	const query = new URLSearchParams({
		from: edgeEndKey(from),
		to: edgeEndKey(to),
	});
	return request("GET", `/api/butler/edges?${query}`);
}
