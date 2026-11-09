import { computed, effect, signal } from "@preact/signals";
import { projectsOfCards } from "../shared/butlerRegions.ts";
import type { ButlerCard, Region } from "../shared/types.ts";
import { projectsById, projectsListing } from "./projects.ts";
import {
	filterKey,
	type ProjectTile,
	tileKeyOf,
	tileOf,
} from "./projectTiles.ts";
import { regions } from "./regionState.ts";
import { annotations } from "./state.ts";

export * from "./projectTiles.ts";

const butlerCards = computed(() =>
	Object.values(annotations.value).filter(
		(a): a is ButlerCard => a.kind === "butler-card",
	),
);

/** Each of Butler's cards' project, as Tidy reads it. */
export const cardOwners = computed(() =>
	projectsOfCards(butlerCards.value, projectsListing.value.projects),
);

export function tileFor(region: Region, now: number): ProjectTile | null {
	const key = tileKeyOf(region.cwd);
	if (key === undefined) return null;
	return tileOf(
		key,
		butlerCards.value,
		cardOwners.value,
		projectsById.value,
		now,
	);
}

/** The one project the board shows, by id or `unsorted`, the rest dimmed; null shows them all. */
export const projectFilter = signal<string | null>(null);

export function toggleProjectFilter(key: string | null): void {
	projectFilter.value =
		projectFilter.peek() === filterKey(key) ? null : filterKey(key);
}

export const isFilteredTo = (key: string | null): boolean =>
	projectFilter.value === filterKey(key);

// A filter whose region has gone has no button left to clear it, so it clears itself.
effect(() => {
	const filter = projectFilter.value;
	if (filter === null) return;
	const shown = regions.value.some((region) => {
		const key = tileKeyOf(region.cwd);
		return key !== undefined && filterKey(key) === filter;
	});
	if (!shown) projectFilter.value = null;
});
