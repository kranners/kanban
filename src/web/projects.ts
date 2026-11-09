import { computed, signal } from "@preact/signals";
import {
	emptyListing,
	type Project,
	type ProjectsListing,
} from "../shared/projects.ts";

// Butler's projects, read from the board's own /api/projects, which reads
// them on the server: the page never learns where they come from.

export const projectsListing = signal<ProjectsListing>(
	emptyListing("unconfigured"),
);
/** Whether the Projects view is open. */
export const projectsOpen = signal(false);
/** The project shown in full in the view, if any. */
export const openProjectId = signal<string | null>(null);

export const projectsById = computed(
	() => new Map(projectsListing.value.projects.map((p) => [p.id, p])),
);

/** Whether the board has any projects to show, so their chips and button appear. */
export const projectsShown = computed(
	() => projectsListing.value.status !== "unconfigured",
);

export async function loadProjects(): Promise<void> {
	try {
		const response = await fetch("/api/projects", {
			headers: { accept: "application/json" },
		});
		if (!response.ok) return;
		const body = (await response.json()) as ProjectsListing;
		if (body && Array.isArray(body.projects)) projectsListing.value = body;
	} catch {
		// Offline: keep what the page last read.
	}
}

export const projectsPollMs = 45_000;

let polling: ReturnType<typeof setInterval> | null = null;

/** Reads the projects now and every 45 seconds while the page is visible. */
export function pollProjects(): () => void {
	void loadProjects();
	polling ??= setInterval(() => {
		if (document.visibilityState === "visible") void loadProjects();
	}, projectsPollMs);
	return () => {
		if (polling) clearInterval(polling);
		polling = null;
	};
}

export function openProject(id: string | null): void {
	openProjectId.value = id;
	projectsOpen.value = true;
	void loadProjects();
}

/** The project's parent chain, nearest first, stopping at a loop. */
export function ancestors(
	project: Project,
	byId: ReadonlyMap<string, Project>,
): Project[] {
	const out: Project[] = [];
	const seen = new Set([project.id]);
	let at = project.parent ? byId.get(project.parent) : undefined;
	while (at && !seen.has(at.id)) {
		out.push(at);
		seen.add(at.id);
		at = at.parent ? byId.get(at.parent) : undefined;
	}
	return out;
}
