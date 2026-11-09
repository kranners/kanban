import type { Project } from "./projects.ts";
import type { ButlerCard, Region } from "./types.ts";

// Butler's own regions, which Tidy keeps, and which project each of his
// cards belongs to. Shared by the server's Tidy and the page's region
// headers and overview tiles, so both read a card's project the same way.

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
