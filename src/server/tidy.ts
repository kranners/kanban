import {
	isTidyRegion,
	projectCwd,
	projectOfRegion,
	projectsOfCards,
	unsortedCwd,
	waitingCwd,
} from "../shared/butlerRegions.ts";
import type { Project, ProjectStage } from "../shared/projects.ts";
import { ownedSubagents } from "../shared/reportedSubagents.ts";
import type { Annotation, ButlerCard, Region } from "../shared/types.ts";
import { snap } from "../web/grid.ts";

export {
	isTidyRegion,
	projectCwd,
	projectOfRegion,
	projectsOfCards,
	unsortedCwd,
	waitingCwd,
} from "../shared/butlerRegions.ts";

import { cardFollowerReach, type Rect } from "../web/placement.ts";

// Butler's cards are laid out by construction, never left where a sync
// dropped them: each goes into the region of the project it belongs to,
// from Butler's projects list, with a strip of Waiting on you across the
// top, since that is the one queue across every project, and Unsorted for
// cards no project claims. Regions sit in rows, by stage, to the left of
// the board's sessions, each sized for its cards on a grid in a fixed
// order, working first, each card followed by the cards it started, and
// its done cards in one stack unless Aaron opened it. A card Aaron pinned,
// or dragged in the last 10 minutes, stays where it is, and a region he
// moved or resized keeps his bounds; the grid flows around both.

/** How long a card Aaron dragged is left where he put it. */
export const movedHoldMs = 10 * 60_000;
const gap = 48;
const padding = 24;
const headroom = 72;
const regionGap = 72;
/** How wide a row of project regions may grow before the next starts. */
const rowWidth = 3200;
/** Room between the Butler regions and the sessions to their right. */
const clearance = 96;
const slotDefault = { w: 312, h: 216 };
const noteGap = 24;
const stackStep = 12;
const emptyHeight = 120;
const maxRegionName = 60;

const stateRank: Record<ButlerCard["state"], number> = {
	working: 0,
	"needs-you": 1,
	failed: 2,
	watching: 3,
	idle: 4,
	stopped: 5,
	done: 6,
};

/** Projects in flight come first, then those being kept, then the rest. */
const stageRank: Record<ProjectStage, number> = {
	landing: 0,
	building: 1,
	live: 2,
	planned: 3,
	maintaining: 4,
	idea: 5,
	paused: 6,
	done: 7,
	dropped: 8,
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

/** Cards in grid order: each root in order, then the cards it started, depth first. */
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
	/** Butler's projects; with none, every card not waiting on Aaron is Unsorted. */
	projects?: readonly Project[];
	now: number;
};

export type TidyRegion = {
	id?: string;
	name: string;
	cwd: string;
	x: number;
	y: number;
	w: number;
	h: number;
};

export type TidyPlan = {
	/** New spots for cards and the notes on them. */
	moves: { id: string; x: number; y: number }[];
	/** Tidy's regions, each with its new bounds, and the id of the existing one when there is one. */
	regions: TidyRegion[];
	/** Tidy's regions it no longer keeps, by id. */
	removed: string[];
};

/** How far a card's subagents reach below it and out to its left, and how wide they stand, laid out as the page lays them. */
export const subagentReach = (
	card: ButlerCard,
): { below: number; left: number; w: number } =>
	card.subagents?.length
		? cardFollowerReach(
				{
					sessions: [],
					subagents: ownedSubagents(card.subagents, card.id),
					subagentCounts: {},
					subagentStates: {},
					workflowRuns: {},
					workflows: [],
					links: [],
					messages: [],
					generatedAt: 0,
				},
				card.id,
			)
		: { below: 0, left: 0, w: 0 };

const boundsOf = (rects: readonly Rect[]): Rect | null => {
	if (rects.length === 0) return null;
	const x = Math.min(...rects.map((r) => r.x));
	const y = Math.min(...rects.map((r) => r.y));
	const right = Math.max(...rects.map((r) => r.x + r.w));
	const bottom = Math.max(...rects.map((r) => r.y + r.h));
	return { x, y, w: right - x, h: bottom - y };
};

/** Columns for a region of this many slots: square-ish, never one tall column. */
export const columnsFor = (slots: number): number =>
	slots <= 1 ? 1 : slots <= 4 ? 2 : slots <= 9 ? 3 : 4;

type Group = {
	cwd: string;
	name: string;
	existing?: Region;
	/** Cards laid out one to a slot. */
	cards: ButlerCard[];
	/** Done cards stacked in the last slot, or empty when the stack is open. */
	stack: ButlerCard[];
};

/**
 * Where every one of Butler's cards goes. Pure: the same board always
 * gives the same plan, and a tidy board gives no moves.
 */
export const planTidy = (input: TidyInput): TidyPlan => {
	const { now } = input;
	const projects = input.projects ?? [];
	const notesOn = new Map<string, Annotation[]>();
	for (const note of input.notes) {
		if (note.kind !== "note" || !note.session) continue;
		notesOn.set(note.session, [...(notesOn.get(note.session) ?? []), note]);
	}
	const heldRects: Rect[] = input.cards
		.filter((c) => isHeld(c, now))
		.flatMap((c) => [
			{
				...c,
				x: c.x - subagentReach(c).left,
				w: Math.max(c.w, subagentReach(c).w),
				h: c.h + subagentReach(c).below,
			},
			...(notesOn.get(c.id) ?? []),
		]);
	const free = input.cards.filter((c) => !isHeld(c, now));
	const owner = projectsOfCards(input.cards, projects);
	const regionAt = (cwd: string) => input.regions.find((r) => r.cwd === cwd);

	// Each slot holds a card and, to its right, the notes on it.
	const footprint = (card: ButlerCard) => {
		const notes = notesOn.get(card.id) ?? [];
		const noteW = notes.length
			? Math.max(...notes.map((n) => n.w)) + noteGap
			: 0;
		const noteH = notes.reduce((sum, n) => sum + n.h + noteGap, -noteGap);
		return {
			w: Math.max(card.w, subagentReach(card).w) + noteW,
			h: Math.max(card.h, noteH),
		};
	};

	// A done card whose subagents still show keeps a slot of its own, since a stack would pile them up.
	const stacked = (card: ButlerCard) =>
		card.state === "done" && !card.subagents?.length;

	const groupOf = (cwd: string, name: string, cards: ButlerCard[]): Group => {
		const existing = regionAt(cwd);
		const ordered = orderCards(cards);
		const open = existing?.doneOpen === true;
		return {
			cwd,
			name: name.slice(0, maxRegionName),
			...(existing ? { existing } : {}),
			cards: open ? ordered : ordered.filter((c) => !stacked(c)),
			stack: open ? [] : ordered.filter(stacked),
		};
	};

	const waiting = groupOf(
		waitingCwd,
		"Waiting on you",
		free.filter((c) => c.state === "needs-you"),
	);
	const rest = free.filter((c) => c.state !== "needs-you");
	const known = new Set(projects.map((p) => p.id));
	const ownerOf = (card: ButlerCard) => {
		const id = owner.get(card.id);
		return id && known.has(id) ? id : null;
	};
	const claimed = new Set(input.cards.map(ownerOf));
	const projectGroups = projects
		.filter(
			(p) => claimed.has(p.id) || regionAt(projectCwd(p.id))?.manual === true,
		)
		.sort(
			(a, b) =>
				stageRank[a.stage] - stageRank[b.stage] ||
				a.title.localeCompare(b.title) ||
				a.id.localeCompare(b.id),
		)
		.map((project) =>
			groupOf(
				projectCwd(project.id),
				project.title,
				rest.filter((c) => ownerOf(c) === project.id),
			),
		);
	const unsorted = rest.filter((c) => ownerOf(c) === null);
	const groups = [
		...projectGroups,
		...(unsorted.length > 0 || regionAt(unsortedCwd)?.manual
			? [groupOf(unsortedCwd, "Unsorted", unsorted)]
			: []),
	];

	const slotCards = [waiting, ...groups].flatMap((g) => [
		...g.cards,
		...g.stack,
	]);
	const slot = {
		w: snap(Math.max(slotDefault.w, ...slotCards.map((c) => footprint(c).w))),
		h: snap(Math.max(slotDefault.h, ...slotCards.map((c) => footprint(c).h))),
	};
	const slotsOf = (group: Group) =>
		group.cards.length + (group.stack.length > 0 ? 1 : 0);
	const widthFor = (columns: number) =>
		snap(padding * 2 + columns * (slot.w + gap) - gap);
	const columnsIn = (width: number) =>
		Math.max(1, Math.floor((width - padding * 2 + gap) / (slot.w + gap)));
	const heightFor = (slots: number, columns: number) =>
		slots === 0
			? emptyHeight
			: snap(
					headroom +
						Math.ceil(slots / columns) * (slot.h + gap) -
						gap +
						padding,
				);
	const outside = boundsOf(input.obstacles);
	const top = snap(outside ? outside.y : 0);

	// Slots each group needs, counting those it skips around held cards, which a pass can find it needs more of.
	const needed = new Map<Group, number>();
	const slotsNeeded = (group: Group) => needed.get(group) ?? slotsOf(group);
	// Height each group adds for the subagents standing under its cards, which a pass can find it needs more of.
	const deeper = new Map<Group, number>();
	const depthOf = (group: Group) => deeper.get(group) ?? 0;

	const place = () => {
		// Project regions in rows, by stage, wrapping at rowWidth.
		type Spot = { group: Group; x: number; w: number; h: number };
		const rows: Spot[][] = [];
		for (const group of groups.filter((g) => !g.existing?.manual)) {
			const columns = columnsFor(slotsOf(group));
			// Never narrower than two cards, so its zoomed-out tile reads.
			const w = widthFor(Math.max(2, columns));
			const h =
				heightFor(
					Math.max(1, slotsNeeded(group)),
					Math.min(columnsIn(w), Math.max(1, slotsOf(group))),
				) + depthOf(group);
			const row = rows.at(-1);
			const end = row ? (row.at(-1) as Spot) : null;
			const x = end ? end.x + end.w + regionGap : 0;
			if (row && x + w <= rowWidth) row.push({ group, x, w, h });
			else rows.push([{ group, x: 0, w, h }]);
		}
		const dashboardW = Math.max(
			widthFor(1),
			...rows.map((r) => {
				const end = r.at(-1) as Spot;
				return end.x + end.w;
			}),
		);
		const left = snap((outside ? outside.x - clearance : 0) - dashboardW);

		// A region Aaron shaped keeps his bounds, growing taller only when its cards would not fit.
		const kept = (group: Group): Rect | null => {
			const region = group.existing;
			if (!region?.manual) return null;
			const fits =
				heightFor(slotsNeeded(group), columnsIn(region.w)) + depthOf(group);
			return { ...region, h: Math.max(region.h, fits) };
		};
		const bounds = new Map<Group, Rect>();
		const waitingBox = kept(waiting) ?? {
			x: left,
			y: top,
			w: dashboardW,
			h:
				heightFor(slotsNeeded(waiting), columnsIn(dashboardW)) +
				depthOf(waiting),
		};
		bounds.set(waiting, waitingBox);
		let y = top + (kept(waiting) ? 0 : waitingBox.h + regionGap);
		for (const r of rows) {
			for (const spot of r) {
				bounds.set(spot.group, { x: left + spot.x, y, w: spot.w, h: spot.h });
			}
			y = snap(y + Math.max(...r.map((s) => s.h)) + regionGap);
		}
		for (const group of groups) {
			const box = kept(group);
			if (box) bounds.set(group, box);
		}

		const moves: TidyPlan["moves"] = [];
		const moveTo = (card: ButlerCard, spot: { x: number; y: number }) => {
			if (card.x !== spot.x || card.y !== spot.y) {
				moves.push({ id: card.id, ...spot });
			}
			const reach = subagentReach(card);
			const noteX = spot.x - reach.left + Math.max(card.w, reach.w) + noteGap;
			let noteY = spot.y;
			for (const note of notesOn.get(card.id) ?? []) {
				const at = { x: snap(noteX), y: snap(noteY) };
				if (note.x !== at.x || note.y !== at.y) {
					moves.push({ id: note.id, ...at });
				}
				noteY += note.h + noteGap;
			}
		};
		const regions: TidyRegion[] = [];
		let short = false;
		for (const group of [waiting, ...groups]) {
			const box = bounds.get(group) as Rect;
			const columns = Math.min(columnsIn(box.w), Math.max(1, slotsOf(group)));
			const origin = { x: box.x + padding, y: box.y + headroom };
			let slotIndex = 0;
			let row = 0;
			let rowY = origin.y;
			let rowDepth = 0;
			let depth = 0;
			// The next slot clear of every card Aaron is holding where it is, each row as deep as its cards' subagents reach.
			const nextSpot = (size: { w: number; h: number }, below = 0) => {
				for (;;) {
					for (; Math.floor(slotIndex / columns) > row; row += 1) {
						rowY += slot.h + gap + rowDepth;
						depth += rowDepth;
						rowDepth = 0;
					}
					const spot = {
						x: snap(origin.x + (slotIndex % columns) * (slot.w + gap)),
						y: snap(rowY),
					};
					slotIndex += 1;
					const reach = { ...spot, w: size.w, h: size.h + below };
					if (!heldRects.some((h) => overlaps(reach, h, gap / 2))) {
						rowDepth = Math.max(rowDepth, below);
						return spot;
					}
				}
			};
			for (const card of group.cards) {
				const { below, left } = subagentReach(card);
				const spot = nextSpot(footprint(card), below > 0 ? below + gap : 0);
				moveTo(card, { x: snap(spot.x + left), y: spot.y });
			}
			if (group.stack.length > 0) {
				const base = nextSpot(slot);
				group.stack.forEach((card, index) => {
					const step = Math.min(index, 2) * stackStep;
					moveTo(card, { x: snap(base.x + step), y: snap(base.y + step) });
				});
			}
			if (slotIndex > slotsNeeded(group)) {
				needed.set(group, slotIndex);
				short = true;
			}
			depth = snap(depth + rowDepth);
			if (depth > depthOf(group)) {
				deeper.set(group, depth);
				short = true;
			}
			regions.push({
				...(group.existing ? { id: group.existing.id } : {}),
				name: group.name,
				cwd: group.cwd,
				x: box.x,
				y: box.y,
				w: box.w,
				h: box.h,
			});
		}
		return { moves, regions, short };
	};

	// Growing a region can move held cards' overlaps, so a few passes settle it.
	let laid = place();
	for (let pass = 0; laid.short && pass < 5; pass += 1) laid = place();
	const { moves, regions } = laid;
	const keptCwds = new Set(regions.map((r) => r.cwd));
	const gone = (region: Region) => {
		const id = projectOfRegion(region.cwd);
		return id !== null && !known.has(id);
	};
	const removed = input.regions
		.filter(
			(r) => isTidyRegion(r) && !keptCwds.has(r.cwd) && (!r.manual || gone(r)),
		)
		.map((r) => r.id);
	return { moves, regions, removed };
};
