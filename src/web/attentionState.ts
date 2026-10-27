import { computed, effect, signal } from "@preact/signals";
import type { Activity } from "../shared/types.ts";
import { arrangement } from "./arrangement.ts";
import type { Activities } from "./attention.ts";
import {
	activitiesOf,
	arrivals,
	needingYou,
	nextInLine,
	readingOrder,
} from "./attention.ts";
import { centreOn, glideMs } from "./Canvas.tsx";
import type { NodeKey } from "./layout.ts";
import { board } from "./state.ts";

const arrivalMs = 1400;
const beckonMs = 1600;

export const activities = computed<Activities>(() =>
	board.value ? activitiesOf(board.value) : new Map(),
);

export const needing = computed(() => needingYou(activities.value));

export const arrived = signal<ReadonlyMap<NodeKey, Activity>>(new Map());

export const beckoned = signal<NodeKey | null>(null);

let previous: Activities = new Map();

effect(() => {
	const current = activities.value;
	const fresh = arrivals(previous, current);
	previous = current;
	if (fresh.size === 0) return;
	arrived.value = new Map([...arrived.peek(), ...fresh]);
	setTimeout(() => {
		const remaining = new Map(arrived.peek());
		for (const key of fresh.keys()) remaining.delete(key);
		arrived.value = remaining;
	}, arrivalMs);
});

let lastVisited: NodeKey | null = null;
let beckonTimer: ReturnType<typeof setTimeout> | undefined;

export function visitNextNeedingYou(): void {
	const placed = arrangement.peek();
	if (!placed) return;
	const waiting = needing.peek();
	const order = readingOrder(
		[...placed.nodes.values()].filter((node) => waiting.has(node.key)),
	);
	const key = nextInLine(
		order.map((node) => node.key),
		lastVisited,
	);
	const node = key ? placed.nodes.get(key) : undefined;
	if (!key || !node) return;
	lastVisited = key;
	centreOn(node);
	beckoned.value = key;
	clearTimeout(beckonTimer);
	beckonTimer = setTimeout(() => {
		beckoned.value = null;
	}, beckonMs);
	setTimeout(() => {
		document
			.querySelector<HTMLElement>(`[data-node="${CSS.escape(key)}"] .frame`)
			?.focus({ preventScroll: true });
	}, glideMs);
}
