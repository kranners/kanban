import { computed, effect, signal } from "@preact/signals";
import type { Activity, Point } from "../shared/types.ts";
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
import { ignoredSessions } from "./ignoreState.ts";
import type { NodeKey } from "./layout.ts";
import { nodeKey } from "./layout.ts";
import { board } from "./state.ts";

const arrivalMs = 1400;
const beckonMs = 1600;

export const activities = computed<Activities>(() =>
	board.value ? activitiesOf(board.value) : new Map(),
);

export const needing = computed(() => {
	const ignored = [...ignoredSessions.value].map((id) =>
		nodeKey({ kind: "session", id }),
	);
	const waiting = needingYou(activities.value);
	for (const key of ignored) waiting.delete(key);
	return waiting;
});

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

let lastVisited: Point | null = null;
let beckonTimer: ReturnType<typeof setTimeout> | undefined;

export function visitNextNeedingYou(): void {
	const placed = arrangement.peek();
	if (!placed) return;
	const waiting = needing.peek();
	const order = readingOrder(
		[...placed.nodes.values()].filter((node) => waiting.has(node.key)),
	);
	const node = nextInLine(order, lastVisited);
	if (!node) return;
	const { key } = node;
	lastVisited = { x: node.x, y: node.y };
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
