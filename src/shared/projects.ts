// The board's own picture of Butler's projects, each with its lifecycle.
// Nothing here knows the shape of the endpoint they come from: the server's
// adapter, src/server/projects.ts, turns that into these types, so a change
// of shape there is a one-line fix in one file.

/** The lifecycle, in order, from first thought to finished. */
export const projectStages = [
	"idea",
	"planned",
	"building",
	"landing",
	"live",
	"maintaining",
	"done",
] as const;

/** Off the main line: a project put down for now, or for good. */
export const projectSideStages = ["paused", "dropped"] as const;

export type ProjectMainStage = (typeof projectStages)[number];
export type ProjectSideStage = (typeof projectSideStages)[number];
export type ProjectStage = ProjectMainStage | ProjectSideStage;

export const stageNames: Record<ProjectStage, string> = {
	idea: "Idea",
	planned: "Planned",
	building: "Building",
	landing: "Landing",
	live: "Live",
	maintaining: "Maintaining",
	done: "Done",
	paused: "Paused",
	dropped: "Dropped",
};

export const isSideStage = (stage: ProjectStage): stage is ProjectSideStage =>
	(projectSideStages as readonly string[]).includes(stage);

export type ProjectLinkKind =
	| "thread"
	| "change"
	| "desk"
	| "session"
	| "pr"
	| "other";

export type ProjectLink = {
	kind: ProjectLinkKind;
	ref: string;
	url: string | null;
};

export type ProjectLive = {
	kind: ProjectLinkKind;
	id: string;
	state: string;
	title: string;
};

export type ProjectStep = { at: number; stage: ProjectStage; note: string };

export type Project = {
	id: string;
	title: string;
	parent: string | null;
	area: string;
	kind: string;
	stage: ProjectStage;
	/** One line on where it stands. */
	state: string;
	next: string;
	/** What it waits on, or null when nothing blocks it. */
	blockedOn: string | null;
	createdAt: number | null;
	touchedAt: number | null;
	stageSince: number | null;
	links: ProjectLink[];
	/** Oldest first. */
	history: ProjectStep[];
	stale: boolean;
	/** 0 to 1, or null when nothing says how far along it is. */
	progress: number | null;
	live: ProjectLive[];
	/** Board sessions or cards it links to, by id. */
	sessions: string[];
};

export type ProjectsStatus = "ok" | "fixture" | "unconfigured" | "unavailable";

export type ProjectsListing = {
	status: ProjectsStatus;
	/** When the source last wrote its projects, if it says. */
	updatedAt: number | null;
	/** When the board last read them. */
	fetchedAt: number | null;
	projects: Project[];
	/** Why the last read failed, kept beside the projects read before it. */
	error?: string;
};

export const emptyListing = (
	status: ProjectsStatus,
	error?: string,
): ProjectsListing => ({
	status,
	updatedAt: null,
	fetchedAt: null,
	projects: [],
	...(error ? { error } : {}),
});

/** The column a project sits in: its stage, with paused and dropped together. */
export const columnOf = (stage: ProjectStage): ProjectMainStage | "aside" =>
	isSideStage(stage) ? "aside" : stage;

export type StripSegment = {
	stage: ProjectMainStage;
	state: "reached" | "current" | "ahead";
	/** When the project first entered this stage, from its history. */
	since: number | null;
};

/**
 * The lifecycle strip: one segment per main stage, reached, current or still
 * ahead. A paused or dropped project shows where it was when it stopped.
 */
export function lifecycleStrip(project: Project): StripSegment[] {
	const first = new Map<ProjectMainStage, number>();
	for (const step of project.history) {
		if (isSideStage(step.stage)) continue;
		if (!first.has(step.stage)) first.set(step.stage, step.at);
	}
	let at: number = projectStages.indexOf(project.stage as ProjectMainStage);
	if (at < 0) {
		const before = [...project.history]
			.reverse()
			.find((step) => !isSideStage(step.stage));
		at = before ? projectStages.indexOf(before.stage as ProjectMainStage) : -1;
	}
	return projectStages.map((stage, index) => ({
		stage,
		state: index < at ? "reached" : index === at ? "current" : "ahead",
		since:
			first.get(stage) ??
			(index === at && project.stageSince !== null ? project.stageSince : null),
	}));
}

/** Whole days since a time, never below zero. */
export const daysSince = (at: number | null, now: number): number | null =>
	at === null ? null : Math.max(0, Math.floor((now - at) / 86_400_000));

/**
 * The projects of one column, each top-level one followed by its children
 * in the same column, so a parent and its sub-projects read as one group.
 */
export function columnProjects(
	projects: readonly Project[],
	column: ProjectMainStage | "aside",
): { project: Project; depth: number }[] {
	const here = projects.filter((p) => columnOf(p.stage) === column);
	const ids = new Set(here.map((p) => p.id));
	const byTouch = (a: Project, b: Project) =>
		(b.touchedAt ?? 0) - (a.touchedAt ?? 0) || a.title.localeCompare(b.title);
	const children = new Map<string, Project[]>();
	for (const project of here) {
		if (project.parent && ids.has(project.parent)) {
			const list = children.get(project.parent) ?? [];
			list.push(project);
			children.set(project.parent, list);
		}
	}
	const out: { project: Project; depth: number }[] = [];
	const seen = new Set<string>();
	const visit = (project: Project, depth: number) => {
		if (seen.has(project.id)) return;
		seen.add(project.id);
		out.push({ project, depth });
		for (const child of (children.get(project.id) ?? []).sort(byTouch)) {
			visit(child, Math.min(depth + 1, 3));
		}
	};
	for (const project of here
		.filter((p) => !p.parent || !ids.has(p.parent))
		.sort(byTouch)) {
		visit(project, 0);
	}
	// A parent loop would leave its members unvisited: list them flat.
	for (const project of here.sort(byTouch)) visit(project, 0);
	return out;
}

/** The projects linked to a board session, by its id or short id. */
export function projectsOfSession(
	projects: readonly Project[],
	session: { id: string; short: string | null },
): Project[] {
	return projects.filter((project) =>
		project.sessions.some(
			(ref) =>
				ref === session.id ||
				(session.short !== null && ref === session.short) ||
				(ref.length >= 8 && session.id.startsWith(ref)),
		),
	);
}
