import type { Project, ProjectStage } from "../shared/projects.ts";
import type { Annotation, ButlerCard, Region } from "../shared/types.ts";
import { snap } from "../web/grid.ts";
import type { Rect } from "../web/placement.ts";

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

export const waitingCwd = "/kanban/butler/waiting";
export const unsortedCwd = "/kanban/butler/unsorted";
const projectPrefix = "/kanban/butler/project/";
/** The regions of the layout before projects, which Tidy now removes. */
const retiredCwds = new Set([
	"/kanban/butler/threads",
	"/kanban/butler/jobs",
	"/kanban/butler/changes",
]);

export const projectCwd = (id: string): string => `${projectPrefix}${id}`;

/** The project a region of Tidy's is for, or null for any other region. */
export const projectOfRegion = (cwd: string): string | null =>
	cwd.startsWith(projectPrefix) ? cwd.slice(projectPrefix.length) : null;

export const isTidyRegion = (region: Pick<Region, "cwd">): boolean =>
	region.cwd === waitingCwd ||
	region.cwd === unsortedCwd ||
	retiredCwds.has(region.cwd) ||
	projectOfRegion(region.cwd) !== null;

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
	idle: 3,
	done: 4,
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

/** The refs a card is known by in a project's links. */
const refsOf = (card: ButlerCard): string[] =>
	[
		card.id,
		card.selfFix,
		card.desk,
		card.thread?.id,
		card.thread ? `thread-${card.thread.id}` : undefined,
	].filter((ref): ref is string => typeof ref === "string" && ref !== "");

/**
 * The project each card belongs to, by id, or null when none claims it:
 * a project whose links name the card, its change, desk session or
 * thread, a child project before its parent, else the project of the card
 * that started it.
 */
export const projectsOfCards = (
	cards: readonly ButlerCard[],
	projects: readonly Project[],
): Map<string, string | null> => {
	const claims = new Map<string, Project>();
	for (const project of projects) {
		for (const ref of [
			...project.links.map((link) => link.ref),
			...project.sessions,
		]) {
			const held = claims.get(ref);
			if (!held || (held.parent === null && project.parent !== null)) {
				claims.set(ref, project);
			}
		}
	}
	const byId = new Map(cards.map((c) => [c.id, c]));
	const resolve = (card: ButlerCard, seen: Set<string>): string | null => {
		const own = refsOf(card)
			.map((ref) => claims.get(ref))
			.find(Boolean);
		if (own) return own.id;
		const parent = card.parent ? byId.get(card.parent) : undefined;
		if (!parent || seen.has(parent.id)) return null;
		seen.add(parent.id);
		return resolve(parent, seen);
	};
	return new Map(
		cards.map((card) => [card.id, resolve(card, new Set([card.id]))]),
	);
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
		.flatMap((c) => [c, ...(notesOn.get(c.id) ?? [])]);
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
		return { w: card.w + noteW, h: Math.max(card.h, noteH) };
	};

	const groupOf = (cwd: string, name: string, cards: ButlerCard[]): Group => {
		const existing = regionAt(cwd);
		const ordered = orderCards(cards);
		const open = existing?.doneOpen === true;
		return {
			cwd,
			name: name.slice(0, maxRegionName),
			...(existing ? { existing } : {}),
			cards: open ? ordered : ordered.filter((c) => c.state !== "done"),
			stack: open ? [] : ordered.filter((c) => c.state === "done"),
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

	const laidCards = [waiting, ...groups].flatMap((g) => g.cards);
	const slot = {
		w: snap(Math.max(slotDefault.w, ...laidCards.map((c) => footprint(c).w))),
		h: snap(Math.max(slotDefault.h, ...laidCards.map((c) => footprint(c).h))),
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

	// Project regions in rows, by stage, wrapping at rowWidth.
	type Spot = { group: Group; x: number; w: number; h: number };
	const rows: Spot[][] = [];
	for (const group of groups.filter((g) => !g.existing?.manual)) {
		const columns = columnsFor(slotsOf(group));
		const w = widthFor(columns);
		const h = heightFor(slotsOf(group), columns);
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

	const outside = boundsOf(input.obstacles);
	const top = snap(outside ? outside.y : 0);
	const left = snap((outside ? outside.x - clearance : 0) - dashboardW);

	const bounds = new Map<Group, Rect>();
	const manual = (group: Group) =>
		group.existing?.manual ? group.existing : null;
	const waitingBox = manual(waiting) ?? {
		x: left,
		y: top,
		w: dashboardW,
		h: heightFor(slotsOf(waiting), columnsIn(dashboardW)),
	};
	bounds.set(waiting, waitingBox);
	let y = top + (manual(waiting) ? 0 : waitingBox.h + regionGap);
	for (const r of rows) {
		for (const spot of r) {
			bounds.set(spot.group, { x: left + spot.x, y, w: spot.w, h: spot.h });
		}
		y = snap(y + Math.max(...r.map((s) => s.h)) + regionGap);
	}
	for (const group of groups) {
		const kept = manual(group);
		if (kept) bounds.set(group, kept);
	}

	const moves: TidyPlan["moves"] = [];
	const moveTo = (card: ButlerCard, spot: { x: number; y: number }) => {
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
	};
	const regions: TidyRegion[] = [];
	for (const group of [waiting, ...groups]) {
		const box = bounds.get(group) as Rect;
		const columns = Math.min(columnsIn(box.w), Math.max(1, slotsOf(group)));
		const origin = { x: box.x + padding, y: box.y + headroom };
		let slotIndex = 0;
		// The next slot clear of every card Aaron is holding where it is.
		const nextSpot = (size: { w: number; h: number }) => {
			for (;;) {
				const spot = {
					x: snap(origin.x + (slotIndex % columns) * (slot.w + gap)),
					y: snap(origin.y + Math.floor(slotIndex / columns) * (slot.h + gap)),
				};
				slotIndex += 1;
				if (!heldRects.some((h) => overlaps({ ...spot, ...size }, h, gap / 2)))
					return spot;
			}
		};
		for (const card of group.cards) moveTo(card, nextSpot(footprint(card)));
		if (group.stack.length > 0) {
			const base = nextSpot(slot);
			group.stack.forEach((card, index) => {
				const step = Math.min(index, 2) * stackStep;
				moveTo(card, { x: snap(base.x + step), y: snap(base.y + step) });
			});
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
	const keptCwds = new Set(regions.map((r) => r.cwd));
	const removed = input.regions
		.filter((r) => isTidyRegion(r) && !keptCwds.has(r.cwd) && !r.manual)
		.map((r) => r.id);
	return { moves, regions, removed };
};
