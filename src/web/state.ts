import { computed, signal } from "@preact/signals";
import type { Activity, Board, Preview, Session } from "../shared/types.ts";
import { layoutForStage } from "./layout.ts";
import type { Size } from "./viewport.ts";

export type Connection = "connecting" | "open" | "reconnecting" | "lost";

export const board = signal<Board | null>(null);
export const previews = signal<ReadonlyMap<string, Preview>>(new Map());
export const connection = signal<Connection>("connecting");
export const activityFilter = signal<ReadonlySet<Activity>>(new Set());
export const search = signal("");
export const hoveredMessage = signal<string | null>(null);
export const selectedMessage = signal<string | null>(null);
export const litMessage = computed(
	() => hoveredMessage.value ?? selectedMessage.value,
);
export const focusedSessionId = signal<string | null>(null);
export const newSessionOpen = signal(false);
export const awaitingShort = signal<string | null>(null);
export const railOpen = signal(innerWidth > 720);
export const now = signal(Date.now());

setInterval(() => {
	now.value = Date.now();
}, 5000);

const compactWidth = 720;

function measureStage(): Size {
	const railWidth = innerWidth <= compactWidth ? 0 : railOpen.value ? 320 : 44;
	return { width: innerWidth - railWidth, height: innerHeight - 52 };
}

export const stageSize = signal<Size>(measureStage());

addEventListener("resize", () => {
	stageSize.value = measureStage();
});

railOpen.subscribe(() => {
	stageSize.value = measureStage();
});

export const layout = computed(() =>
	board.value ? layoutForStage(board.value, stageSize.value) : null,
);

export const sessionsById = computed(
	() => new Map((board.value?.sessions ?? []).map((s) => [s.id, s])),
);

export const subagentsById = computed(
	() => new Map((board.value?.subagents ?? []).map((a) => [a.id, a])),
);

export const focusedSession = computed(() =>
	focusedSessionId.value
		? (sessionsById.value.get(focusedSessionId.value) ?? null)
		: null,
);

export const knownCwds = computed(() => [
	...new Set(
		[...(board.value?.sessions ?? [])]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((s) => s.cwd),
	),
]);

export const activityCounts = computed(() => {
	const counts = new Map<Activity, number>();
	for (const s of board.value?.sessions ?? []) {
		counts.set(s.activity, (counts.get(s.activity) ?? 0) + 1);
	}
	return counts;
});

export function sessionMatches(session: Session): boolean {
	const filter = activityFilter.value;
	if (filter.size > 0 && !filter.has(session.activity)) return false;
	const query = search.value.trim().toLowerCase();
	if (!query) return true;
	return [
		session.name,
		session.project,
		session.cwd,
		session.doing ?? "",
		session.short ?? "",
	].some((field) => field.toLowerCase().includes(query));
}

export const filtering = computed(
	() => activityFilter.value.size > 0 || search.value.trim() !== "",
);

export function toggleActivity(activity: Activity): void {
	const next = new Set(activityFilter.value);
	if (next.has(activity)) next.delete(activity);
	else next.add(activity);
	activityFilter.value = next;
}

export const focusOrigin = signal<DOMRect | undefined>(undefined);

export function openSession(id: string, origin?: DOMRect): void {
	focusOrigin.value = origin;
	focusedSessionId.value = id;
}
