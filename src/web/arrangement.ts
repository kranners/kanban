import { computed, effect, signal } from "@preact/signals";
import type {
	Layout,
	LayoutUpdate,
	Placement,
	Point,
} from "../shared/types.ts";
import { departing } from "./exitState.ts";
import { groupsOf } from "./groups.ts";
import type { NodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";
import { arrange, seedsOf } from "./placement.ts";
import { board, layout } from "./state.ts";

const settleMs = 1500;
const echoMs = 3000;

export const overrides = signal<ReadonlyMap<NodeKey, Placement>>(new Map());
export const reserved = signal<readonly Rect[]>([]);

const seeds = computed(() => (board.value ? seedsOf(board.value) : null));

const remembered = new Map<NodeKey, Point>();
const requested = new Set<NodeKey>();

function withOverrides(saved: Layout): Layout {
	const local = overrides.value;
	return local.size === 0 ? saved : { ...saved, ...Object.fromEntries(local) };
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
		reserved.value,
	);
});

export const groups = computed(() => {
	const current = board.value;
	const placed = arrangement.value;
	if (!current || !placed) return [];
	const leaving = departing.value;
	return groupsOf(
		current.sessions.filter((s) => !leaving.has(s.id)),
		placed.nodes,
	);
});

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
	return a?.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
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

export async function commitPlacement(
	key: NodeKey,
	placement: Placement,
): Promise<void> {
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
	const placement = { x: rect.x, y: rect.y, ...size };
	if (phase === "move") previewPlacement(key, placement);
	else void commitPlacement(key, placement);
}
