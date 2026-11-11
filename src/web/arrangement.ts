import { computed, effect, signal } from "@preact/signals";
import type {
	Layout,
	LayoutUpdate,
	Placement,
	Point,
} from "../shared/types.ts";
import { current as drafts, save as saveAnnotations } from "./annotations.ts";
import { ownCards } from "./butlerSessions.ts";
import { departing } from "./exitState.ts";
import { groupsOf } from "./groups.ts";
import { type NodeKey, nodeKey } from "./layout.ts";
import type { Bounds, Rect } from "./placement.ts";
import { arrange, boundsOf, seedsOf } from "./placement.ts";
import { unreachablePeers } from "./reach.ts";
import { shownRegions } from "./regionState.ts";
import { regionGroups } from "./regions.ts";
import { annotations, board, layout } from "./state.ts";

const settleMs = 1500;
const echoMs = 3000;

export const overrides = signal<ReadonlyMap<NodeKey, Placement>>(new Map());
export const reserved = signal<readonly Rect[]>([]);

/** Butler's cards drawn as sessions stand where Tidy or Aaron put the card, as though placed by hand. */
const cardPlacements = computed(() => {
	const shown = drafts.value;
	return new Map(
		ownCards(board.value).flatMap((card) => {
			const { x, y, w, h } = shown[card.id] ?? card;
			const placement: Placement = { x, y, w, h, pinned: true };
			return [[nodeKey({ kind: "session", id: card.id }), placement] as const];
		}),
	);
});

const cardKeys = computed(() => new Set(cardPlacements.value.keys()));

const seeds = computed(() =>
	board.value
		? seedsOf(
				board.value,
				ownCards(board.value).map((card) => card.id),
			)
		: null,
);

const remembered = new Map<NodeKey, Point>();
const requested = new Set<NodeKey>();

/** Lets every session the server sent back to auto be laid out afresh, not put back where it was. */
export function forgetAutoSpots(): void {
	remembered.clear();
	requested.clear();
}

function withOverrides(saved: Layout): Layout {
	return {
		...saved,
		...Object.fromEntries(cardPlacements.value),
		...Object.fromEntries(overrides.value),
	};
}

export const arrangement = computed(() => {
	const current = board.value;
	const seeded = seeds.value;
	if (!current || !seeded) return null;
	return arrange(
		current,
		withOverrides(layout.value),
		seeded,
		remembered,
		[
			...reserved.value,
			...Object.values(annotations.value).filter(
				(annotation) => annotation.kind !== "butler-card",
			),
		],
		shownRegions.value,
	);
});

export const groups = computed(() => {
	const current = board.value;
	const placed = arrangement.value;
	if (!current || !placed) return [];
	const leaving = departing.value;
	const sessions = current.sessions.filter((s) => !leaving.has(s.id));
	return regionGroups(
		shownRegions.value,
		groupsOf(sessions, placed.nodes),
		sessions,
		placed.nodes,
	);
});

/** Everything drawn on the board: sessions, their frames, regions, cards, notes and stickers. */
export function boardBounds(): Bounds | null {
	const rects: Rect[] = [
		...(arrangement.peek()?.nodes.values() ?? []),
		...groups.peek().map((group) => group.frame),
		...shownRegions.peek(),
		...Object.values(annotations.peek()),
	];
	return rects.length > 0 ? boundsOf(rects) : null;
}

export const unreachable = computed(() =>
	unreachablePeers(groups.value, board.value?.sessions ?? []),
);

async function putLayout(update: LayoutUpdate): Promise<void> {
	const response = await fetch("/api/layout", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(update),
	});
	if (!response.ok) throw new Error(`layout ${response.status}`);
}

function persistAuto(key: NodeKey): void {
	if (requested.has(key)) return;
	requested.add(key);
	setTimeout(() => {
		const spot = arrangement.peek()?.auto.get(key);
		if (!spot || layout.peek()[key] || overrides.peek().has(key)) return;
		putLayout({ key, placement: spot }).catch(() => requested.delete(key));
	}, settleMs);
}

effect(() => {
	for (const [key, spot] of arrangement.value?.auto ?? []) {
		remembered.set(key, spot);
		persistAuto(key);
	}
});

function samePlacement(a: Placement | undefined, b: Placement): boolean {
	return (
		a?.x === b.x &&
		a.y === b.y &&
		a.w === b.w &&
		a.h === b.h &&
		a.pinned === b.pinned
	);
}

function forget(key: NodeKey, placement: Placement): void {
	if (overrides.peek().get(key) !== placement) return;
	const next = new Map(overrides.peek());
	next.delete(key);
	overrides.value = next;
}

effect(() => {
	const saved = layout.value;
	for (const [key, placement] of overrides.peek()) {
		if (samePlacement(saved[key], placement)) forget(key, placement);
	}
});

export function previewPlacement(key: NodeKey, placement: Placement): void {
	overrides.value = new Map(overrides.peek()).set(key, placement);
}

/** A card of Butler's moved or resized as a session is saved on the card, where Tidy reads it. */
function commitCard(key: NodeKey, placement: Placement): boolean {
	if (!cardKeys.peek().has(key)) return false;
	const id = key.slice(key.indexOf(":") + 1);
	const card = drafts.peek()[id];
	if (card?.kind !== "butler-card") return false;
	const { x, y } = placement;
	saveAnnotations([
		{
			...card,
			x,
			y,
			...(placement.w !== undefined && placement.h !== undefined
				? { w: placement.w, h: placement.h }
				: {}),
		},
	]);
	forget(key, overrides.peek().get(key) ?? placement);
	return true;
}

export async function commitPlacement(
	key: NodeKey,
	placement: Placement,
): Promise<void> {
	if (commitCard(key, placement)) return;
	previewPlacement(key, placement);
	try {
		await putLayout({ key, placement });
	} catch {
		forget(key, placement);
		return;
	}
	if (samePlacement(layout.peek()[key], placement)) forget(key, placement);
	else setTimeout(() => forget(key, placement), echoMs);
}

export function cancelPlacement(key: NodeKey): void {
	const placement = overrides.peek().get(key);
	if (placement) forget(key, placement);
}

export type Arranging = {
	key: NodeKey;
	mode: "move" | "resize";
	rect: { x: number; y: number; w: number; h: number };
	phase: "move" | "drop" | "cancel";
};

export function savedPlacement(key: NodeKey): Placement | undefined {
	return overrides.peek().get(key) ?? layout.peek()[key];
}

export function arrangeNode(gesture: Arranging): void {
	const { key, mode, rect, phase } = gesture;
	if (phase === "cancel") {
		cancelPlacement(key);
		return;
	}
	const saved = savedPlacement(key);
	const size =
		mode === "resize"
			? { w: rect.w, h: rect.h }
			: saved?.w !== undefined && saved.h !== undefined
				? { w: saved.w, h: saved.h }
				: {};
	const placement = { x: rect.x, y: rect.y, ...size, pinned: true as const };
	if (phase === "move") previewPlacement(key, placement);
	else void commitPlacement(key, placement);
}
