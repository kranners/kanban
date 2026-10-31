import { computed, effect, signal } from "@preact/signals";
import type {
	Activity,
	Annotations,
	Board,
	Landing,
	Layout,
	Session,
} from "../shared/types.ts";
import { totalSubagentCounts } from "./subagentCounts.ts";

export type Connection = "connecting" | "open" | "reconnecting" | "lost";

export const board = signal<Board | null>(null);
export const connection = signal<Connection>("connecting");
export const activityFilter = signal<ReadonlySet<Activity>>(new Set());
export const workingSubagentsOnly = signal(false);
export const search = signal("");
export const hoveredMessage = signal<string | null>(null);
export const selectedMessage = signal<string | null>(null);
export const litMessage = computed(
	() => hoveredMessage.value ?? selectedMessage.value,
);
export const focusedSessionId = signal<string | null>(null);
export const focusedSubagentId = signal<string | null>(null);
export const newSessionOpen = signal(false);
export const awaitingLanding = signal<Landing | null>(null);
export type RailView = "search" | "status" | "docs" | "usage" | "messages";
export const railView = signal<RailView | null>(
	innerWidth > 720 ? "messages" : null,
);
const wide = matchMedia("(min-width: 1280px)");
export const docked = signal(wide.matches);
wide.addEventListener("change", () => {
	docked.value = wide.matches;
});
export const now = signal(Date.now());

setInterval(() => {
	now.value = Date.now();
}, 5000);

export const layout = signal<Layout>({});

export const annotations = signal<Annotations>({});

export const sessionsById = computed(
	() => new Map((board.value?.sessions ?? []).map((s) => [s.id, s])),
);

export const subagentsById = computed(
	() => new Map((board.value?.subagents ?? []).map((a) => [a.id, a])),
);

export const subagentTotals = computed(() =>
	totalSubagentCounts(board.value?.subagentCounts ?? {}),
);

effect(() => {
	const { working, idle, done } = subagentTotals.value;
	if (working + idle + done === 0) workingSubagentsOnly.value = false;
});

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

export const focusedSubagent = computed(() =>
	focusedSubagentId.value
		? (subagentsById.value.get(focusedSubagentId.value) ?? null)
		: null,
);

export function openSession(id: string, origin?: DOMRect): void {
	focusOrigin.value = origin;
	focusedSubagentId.value = null;
	focusedSessionId.value = id;
}

export function openSubagent(id: string, origin?: DOMRect): void {
	focusOrigin.value = origin;
	focusedSessionId.value = null;
	focusedSubagentId.value = id;
}

export function closeFocus(): void {
	focusedSessionId.value = null;
	focusedSubagentId.value = null;
}
