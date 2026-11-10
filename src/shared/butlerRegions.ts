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

/** A change named in a project's links by its date and time alone, which the change's full id starts with. */
const changeRefPattern = /^\d{8}-\d{6}$/;

const namesChange = (ref: string, change: string): boolean =>
	changeRefPattern.test(ref) && change.startsWith(`${ref}-`);

/** Words too common across Aaron's projects and Butler's titles to tell one project from another. */
const plainWords = new Set([
	"and",
	"for",
	"the",
	"with",
	"from",
	"into",
	"its",
	"butler",
	"butlers",
	"aaron",
	"work",
	"data",
	"desk",
	"plan",
	"get",
	"new",
	"fix",
	"change",
]);

const wordsOf = (text: string): string[] =>
	text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 3 && !plainWords.has(word));

/** Where a guess may file a card: a project still under way, never one done or dropped. */
const guessable = (project: Project): boolean =>
	project.stage !== "done" && project.stage !== "dropped";

/**
 * The project a card's title names, by words of the projects' ids and
 * titles: a word counts when the projects using it lie on one line of
 * parent and children, naming the topmost of them, and the most specific
 * named project wins when all lie on one line. Null when no word names
 * one or the words point at unrelated projects, so a doubtful card stays
 * in Unsorted.
 */
export const guessProject = (
	title: string,
	projects: readonly Project[],
): Project | null => {
	const open = projects.filter(guessable);
	const byId = new Map(open.map((p) => [p.id, p]));
	const lineOf = (project: Project): string[] => {
		const line = [project.id];
		let at = project;
		while (at.parent && byId.has(at.parent) && !line.includes(at.parent)) {
			at = byId.get(at.parent) as Project;
			line.push(at.id);
		}
		return line;
	};
	const lines = new Map(open.map((p) => [p.id, lineOf(p)]));
	const depth = (project: Project): number =>
		lines.get(project.id)?.length ?? 0;
	const isUnder = (project: Project, above: Project): boolean =>
		lines.get(project.id)?.includes(above.id) === true;
	const shallowestOnOneLine = (held: readonly Project[]): Project | null => {
		const top = [...held].sort((a, b) => depth(a) - depth(b))[0];
		return top && held.every((p) => isUnder(p, top)) ? top : null;
	};
	const holders = new Map<string, Project[]>();
	for (const project of open) {
		for (const word of new Set(wordsOf(`${project.id} ${project.title}`))) {
			holders.set(word, [...(holders.get(word) ?? []), project]);
		}
	}
	const named = new Set<Project>();
	for (const word of new Set(wordsOf(title))) {
		const top = shallowestOnOneLine(holders.get(word) ?? []);
		if (top) named.add(top);
	}
	const deepest = [...named].sort((a, b) => depth(b) - depth(a))[0];
	return deepest && [...named].every((p) => isUnder(deepest, p))
		? deepest
		: null;
};

/**
 * The project each card belongs to, by id, or null when none claims it:
 * a project whose links name the card, its change, desk session or
 * thread, a child project before its parent, else the project of the card
 * that started it, else the one its title names.
 */
export const projectsOfCards = (
	cards: readonly ButlerCard[],
	projects: readonly Project[],
): Map<string, string | null> => {
	const claims = new Map<string, Project>();
	const changeClaims: [string, Project][] = [];
	for (const project of projects) {
		for (const ref of [
			...project.links.map((link) => link.ref),
			...project.sessions,
		]) {
			const held = claims.get(ref);
			if (!held || (held.parent === null && project.parent !== null)) {
				claims.set(ref, project);
			}
			if (changeRefPattern.test(ref)) changeClaims.push([ref, project]);
		}
	}
	const claimOf = (card: ButlerCard): Project | undefined =>
		refsOf(card)
			.map((ref) => claims.get(ref))
			.find(Boolean) ??
		changeClaims
			.filter(([ref]) => card.selfFix && namesChange(ref, card.selfFix))
			.map(([, project]) => project)
			.sort((a, b) => Number(a.parent === null) - Number(b.parent === null))[0];
	const byId = new Map(cards.map((c) => [c.id, c]));
	const resolve = (card: ButlerCard, seen: Set<string>): string | null => {
		const own = claimOf(card);
		if (own) return own.id;
		const parent = card.parent ? byId.get(card.parent) : undefined;
		if (parent && !seen.has(parent.id)) {
			seen.add(parent.id);
			const inherited = resolve(parent, seen);
			if (inherited) return inherited;
		}
		return guessProject(card.title, projects)?.id ?? null;
	};
	return new Map(
		cards.map((card) => [card.id, resolve(card, new Set([card.id]))]),
	);
};
