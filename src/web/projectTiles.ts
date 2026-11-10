import { projectOfRegion, unsortedCwd } from "../shared/butlerRegions.ts";
import type { Project } from "../shared/projects.ts";
import type { ButlerCard } from "../shared/types.ts";

// How a project region reads at a glance: its cards by status, its
// progress, and whether the one-project filter keeps a card lit. Pure, so
// the page's tiles and headers and their tests read the same thing.

/** A working card with no news this long has stalled. */
export const stalledMs = 10 * 60_000;

export type TileStatus =
	| "working"
	| "needs-you"
	| "stalled"
	| "failed"
	| "idle"
	| "done";

export const tileStatuses: readonly TileStatus[] = [
	"working",
	"needs-you",
	"stalled",
	"failed",
	"idle",
	"done",
];

export const tileStatusLabel: Record<TileStatus, string> = {
	working: "working",
	"needs-you": "needs you",
	stalled: "stalled",
	failed: "failed",
	idle: "idle",
	done: "done",
};

export const statusOf = (card: ButlerCard, now: number): TileStatus => {
	if (card.state === "working" && now - card.updatedAt > stalledMs) {
		return "stalled";
	}
	if (card.state === "watching") return "working";
	if (card.state === "stopped") return "idle";
	return card.state;
};

export type ProjectTile = {
	/** The project's id, or null for Unsorted. */
	id: string | null;
	title: string;
	project: Project | null;
	counts: Record<TileStatus, number>;
	cards: ButlerCard[];
};

/** Which region, by its project id or null for Unsorted, a region's cwd is for; undefined for any other region. */
export const tileKeyOf = (cwd: string): string | null | undefined =>
	cwd === unsortedCwd ? null : (projectOfRegion(cwd) ?? undefined);

/**
 * A project's overview: its cards by status, counted by the project they
 * belong to rather than where they sit, so one waiting on Aaron in the
 * strip still counts for its project.
 */
export function tileOf(
	key: string | null,
	cards: readonly ButlerCard[],
	owners: ReadonlyMap<string, string | null>,
	byId: ReadonlyMap<string, Project>,
	now: number,
): ProjectTile {
	const project = key === null ? null : (byId.get(key) ?? null);
	const mine = cards.filter((card) => {
		const owner = owners.get(card.id) ?? null;
		const known = owner !== null && byId.has(owner) ? owner : null;
		return known === key;
	});
	const counts = Object.fromEntries(
		tileStatuses.map((status) => [status, 0]),
	) as Record<TileStatus, number>;
	for (const card of mine) counts[statusOf(card, now)] += 1;
	return {
		id: key,
		title: project?.title ?? (key === null ? "Unsorted" : key),
		project,
		counts,
		cards: mine,
	};
}

export const filterKey = (key: string | null) => key ?? "unsorted";

/** Whether a card or session stays lit under the project filter. */
export function inFilter(
	filter: string | null,
	ref: { card?: string; session?: string },
	owners: ReadonlyMap<string, string | null>,
	byId: ReadonlyMap<string, Project>,
): boolean {
	if (filter === null) return true;
	if (ref.card !== undefined) {
		const owner = owners.get(ref.card) ?? null;
		const known = owner !== null && byId.has(owner) ? owner : null;
		return filterKey(known) === filter;
	}
	if (ref.session !== undefined) {
		return byId.get(filter)?.sessions.includes(ref.session) ?? false;
	}
	return true;
}

/** The share of a project's main lifecycle behind it, from its own progress or its stage. */
export function progressOf(project: Project | null): number | null {
	if (!project) return null;
	if (project.progress !== null) return project.progress;
	const order = [
		"idea",
		"planned",
		"building",
		"landing",
		"live",
		"maintaining",
		"done",
	];
	const at = order.indexOf(project.stage);
	return at < 0 ? null : at / (order.length - 1);
}
