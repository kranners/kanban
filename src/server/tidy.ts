import type { Annotation, ButlerCard, Region } from "../shared/types.ts";
import { snap } from "../web/grid.ts";
import type { Rect } from "../web/placement.ts";

// Butler's cards are laid out by construction, never left where a sync
// dropped them: each goes into one of four regions by topic, side by side
// to the left of the board's sessions, and on a grid inside it in a fixed
// order, state first and then newest first, each card followed by the
// cards it started. A card Aaron pinned, or dragged in the last 10
// minutes, stays where it is and the grid flows around it.

/** The regions Tidy keeps, left to right; each is found again by its cwd, which no session has. */
export const tidyTopics = [
	{ id: "waiting", name: "Waiting on you", cwd: "/kanban/butler/waiting" },
	{ id: "butler", name: "Butler", cwd: "/kanban/butler/threads" },
	{ id: "jobs", name: "Jobs", cwd: "/kanban/butler/jobs" },
	{ id: "changes", name: "Changes", cwd: "/kanban/butler/changes" },
] as const;

export type TidyTopic = (typeof tidyTopics)[number]["id"];

export const isTidyRegion = (region: Pick<Region, "cwd">): boolean =>
	tidyTopics.some((topic) => topic.cwd === region.cwd);

/** How long a card Aaron dragged is left where he put it. */
export const movedHoldMs = 10 * 60_000;
const columns = 2;
const gap = 48;
const padding = 24;
const headroom = 48;
const regionGap = 72;
/** Room between the Butler regions and the sessions to their right. */
const clearance = 96;
const slotDefault = { w: 312, h: 216 };
const noteGap = 24;

const stateRank: Record<ButlerCard["state"], number> = {
	"needs-you": 0,
	working: 1,
	failed: 2,
	idle: 3,
	done: 4,
};

/** The region a card belongs in. */
export const topicOf = (card: ButlerCard): TidyTopic => {
	if (card.state === "needs-you") return "waiting";
	if (card.selfFix && !card.thread) return "changes";
	if (card.thread?.kind === "job" || card.thread?.kind === "scheduled") {
		return "jobs";
	}
	return "butler";
};

/** When a change's id says it was asked for, such as 20261106-141450-402386. */
const changeTime = (fix: string | undefined): number | undefined => {
	const m = fix?.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/);
	if (!m) return undefined;
	const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
	return new Date(
		y as number,
		(mo as number) - 1,
		d as number,
		h as number,
		mi as number,
		s as number,
	).getTime();
};

/** When a card's work began, as best the board knows. */
export const startOf = (card: ButlerCard): number =>
	card.startedAt ??
	changeTime(card.selfFix) ??
	card.history?.[0]?.at ??
	card.updatedAt;

/** True for a card Tidy must leave where it is. */
export const isHeld = (card: ButlerCard, now: number): boolean =>
	card.pinned === true ||
	(card.movedAt !== undefined && now - card.movedAt < movedHoldMs);

const byOrder = (a: ButlerCard, b: ButlerCard) =>
	stateRank[a.state] - stateRank[b.state] ||
	startOf(b) - startOf(a) ||
	a.id.localeCompare(b.id);

/** A topic's cards in grid order: each root in order, then the cards it started, depth first. */
export const orderCards = (cards: readonly ButlerCard[]): ButlerCard[] => {
	const ids = new Set(cards.map((c) => c.id));
	const children = new Map<string, ButlerCard[]>();
	const roots: ButlerCard[] = [];
	for (const card of cards) {
		if (card.parent && card.parent !== card.id && ids.has(card.parent)) {
			children.set(card.parent, [...(children.get(card.parent) ?? []), card]);
		} else roots.push(card);
	}
	const out: ButlerCard[] = [];
	const seen = new Set<string>();
	const visit = (card: ButlerCard) => {
		if (seen.has(card.id)) return;
		seen.add(card.id);
		out.push(card);
		for (const child of (children.get(card.id) ?? []).sort(byOrder)) {
			visit(child);
		}
	};
	for (const root of roots.sort(byOrder)) visit(root);
	// A loop of parents leaves cards unvisited; they go last, in order.
	for (const card of [...cards].sort(byOrder)) visit(card);
	return out;
};

const overlaps = (a: Rect, b: Rect, margin = 0) =>
	a.x < b.x + b.w + margin &&
	b.x < a.x + a.w + margin &&
	a.y < b.y + b.h + margin &&
	b.y < a.y + a.h + margin;

export type TidyInput = {
	cards: readonly ButlerCard[];
	/** Butler's notes, which move with the card they are on. */
	notes: readonly Annotation[];
	/** Everything else on the board: sessions, their project frames and other regions, notes and stickers. */
	obstacles: readonly Rect[];
	regions: readonly Region[];
	now: number;
};

export type TidyPlan = {
	/** New spots for cards and the notes on them. */
	moves: { id: string; x: number; y: number }[];
	/** The four regions, each with its new bounds, and the id of the existing one when there is one. */
	regions: {
		topic: TidyTopic;
		id?: string;
		name: string;
		cwd: string;
		x: number;
		y: number;
		w: number;
		h: number;
	}[];
};

const boundsOf = (rects: readonly Rect[]): Rect | null => {
	if (rects.length === 0) return null;
	const x = Math.min(...rects.map((r) => r.x));
	const y = Math.min(...rects.map((r) => r.y));
	const right = Math.max(...rects.map((r) => r.x + r.w));
	const bottom = Math.max(...rects.map((r) => r.y + r.h));
	return { x, y, w: right - x, h: bottom - y };
};

/**
 * Where every one of Butler's cards goes. Pure: the same board always
 * gives the same plan, and a tidy board gives no moves.
 */
export const planTidy = (input: TidyInput): TidyPlan => {
	const { now } = input;
	const notesOn = new Map<string, Annotation[]>();
	for (const note of input.notes) {
		if (note.kind !== "note" || !note.session) continue;
		notesOn.set(note.session, [...(notesOn.get(note.session) ?? []), note]);
	}
	const held = input.cards.filter((c) => isHeld(c, now));
	const heldRects: Rect[] = held.flatMap((c) => [
		c,
		...(notesOn.get(c.id) ?? []),
	]);
	const free = input.cards.filter((c) => !isHeld(c, now));

	// Each slot holds a card and, to its right, the notes on it.
	const footprint = (card: ButlerCard) => {
		const notes = notesOn.get(card.id) ?? [];
		const noteW = notes.length
			? Math.max(...notes.map((n) => n.w)) + noteGap
			: 0;
		const noteH = notes.reduce((sum, n) => sum + n.h + noteGap, -noteGap);
		return { w: card.w + noteW, h: Math.max(card.h, noteH) };
	};

	const outside = boundsOf(input.obstacles);
	const top = snap(outside ? outside.y : 0);
	const right = snap(outside ? outside.x - clearance : 0);

	const groups = tidyTopics.map((topic) => {
		const cards = orderCards(free.filter((c) => topicOf(c) === topic.id));
		const sizes = cards.map(footprint);
		const slot = {
			w: snap(Math.max(slotDefault.w, ...sizes.map((s) => s.w))),
			h: snap(Math.max(slotDefault.h, ...sizes.map((s) => s.h))),
		};
		return { topic, cards, slot };
	});

	// The width each region needs, so the row of regions can end left of the sessions.
	const widthOf = (slotW: number, count: number) =>
		padding * 2 + Math.max(1, Math.min(columns, count)) * (slotW + gap) - gap;
	const widths = groups.map((g) => widthOf(g.slot.w, g.cards.length));
	const total =
		widths.reduce((sum, w) => sum + w, 0) + regionGap * (groups.length - 1);
	let x = snap(right - total);

	const moves: TidyPlan["moves"] = [];
	const regions: TidyPlan["regions"] = [];
	groups.forEach((group, index) => {
		const width = widths[index] as number;
		const existing = input.regions.find((r) => r.cwd === group.topic.cwd);
		const origin = { x: x + padding, y: top + headroom };
		let slotIndex = 0;
		let rows = 1;
		for (const card of group.cards) {
			// The next slot clear of every card Aaron is holding where it is.
			for (;;) {
				const col = slotIndex % columns;
				const row = Math.floor(slotIndex / columns);
				const spot = {
					x: snap(origin.x + col * (group.slot.w + gap)),
					y: snap(origin.y + row * (group.slot.h + gap)),
				};
				slotIndex += 1;
				const box = { ...spot, ...footprint(card) };
				if (heldRects.some((h) => overlaps(box, h, gap / 2))) continue;
				rows = Math.max(rows, row + 1);
				if (card.x !== spot.x || card.y !== spot.y) {
					moves.push({ id: card.id, ...spot });
				}
				let noteY = spot.y;
				for (const note of notesOn.get(card.id) ?? []) {
					const at = { x: snap(spot.x + card.w + noteGap), y: snap(noteY) };
					if (note.x !== at.x || note.y !== at.y) {
						moves.push({ id: note.id, ...at });
					}
					noteY += note.h + noteGap;
				}
				break;
			}
		}
		const height =
			group.cards.length === 0
				? 96
				: headroom + rows * (group.slot.h + gap) - gap + padding;
		regions.push({
			topic: group.topic.id,
			...(existing ? { id: existing.id } : {}),
			name: group.topic.name,
			cwd: group.topic.cwd,
			x,
			y: top,
			w: snap(width),
			h: snap(Math.max(96, height)),
		});
		x = snap(x + width + regionGap);
	});
	return { moves, regions };
};
