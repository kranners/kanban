// The adapter for Butler's projects: the one place that knows the shape of
// the endpoint they come from, turning it into the board's own types in
// src/shared/projects.ts. It reads them on the server, never in the page,
// so the source's address and token stay off the browser.
//
// Assumed shape, from Butler's projects system:
//   { updated, projects: [ { id, title, parent, area, kind, stage, state,
//     next, blocked_on, created, touched, stage_since,
//     links: [ { type, ref, url? } ], history: [ { at, stage, note } ],
//     stale, progress, live: [ { type, id, state, title } ] } ] }
//
// No Node imports here, so the browser demo can use the fixture too.

import {
	emptyListing,
	type Project,
	type ProjectLink,
	type ProjectLinkKind,
	type ProjectLive,
	type ProjectStage,
	type ProjectStep,
	type ProjectsListing,
	projectSideStages,
	projectStages,
} from "../shared/projects.ts";

export type ProjectsConfig =
	| { mode: "off" }
	| { mode: "fixture" }
	| { mode: "file"; file: string }
	| { mode: "url"; url: string; token: string | null };

export const maxProjects = 500;
export const maxProjectBytes = 4 * 1024 * 1024;
const staleDays = 14;

/**
 * KANBAN_PROJECTS_FIXTURE=1 serves invented sample projects, for
 * development; otherwise KANBAN_PROJECTS_FILE reads a JSON file and
 * KANBAN_PROJECTS_URL fetches one, with KANBAN_PROJECTS_TOKEN as its bearer
 * token when set. Unset, the view says projects are not connected.
 */
export function parseProjectsConfig(env: NodeJS.ProcessEnv): ProjectsConfig {
	const fixture = env.KANBAN_PROJECTS_FIXTURE;
	if (fixture === "1" || fixture === "true") return { mode: "fixture" };
	if (env.KANBAN_PROJECTS_FILE) {
		return { mode: "file", file: env.KANBAN_PROJECTS_FILE };
	}
	const raw = env.KANBAN_PROJECTS_URL;
	if (!raw) return { mode: "off" };
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`KANBAN_PROJECTS_URL must be http or https, got "${raw}"`);
	}
	if (url.username || url.password) {
		throw new Error(
			"KANBAN_PROJECTS_URL must not carry credentials; use KANBAN_PROJECTS_TOKEN",
		);
	}
	const token = env.KANBAN_PROJECTS_TOKEN?.trim() || null;
	if (token !== null && !/^[\x21-\x7e]{8,512}$/.test(token)) {
		// Never echo the value: it is a secret even when malformed.
		throw new Error("KANBAN_PROJECTS_TOKEN is not a usable bearer token");
	}
	return { mode: "url", url: url.toString(), token };
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string =>
	typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, max)
		: typeof value === "number" && Number.isFinite(value)
			? String(value)
			: "";

const textOrNull = (value: unknown, max: number): string | null =>
	text(value, max) || null;

/** An ISO date or epoch seconds or milliseconds, as epoch milliseconds. */
export function timeOf(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
	}
	if (typeof value === "string" && value.trim()) {
		const at = Date.parse(value);
		return Number.isFinite(at) ? at : null;
	}
	return null;
}

const stageAliases: Record<string, ProjectStage> = {
	plan: "planned",
	planning: "planned",
	build: "building",
	land: "landing",
	maintain: "maintaining",
	maintenance: "maintaining",
	finished: "done",
	complete: "done",
	parked: "paused",
	abandoned: "dropped",
};

const allStages = new Set<string>([...projectStages, ...projectSideStages]);

export function stageOf(value: unknown): ProjectStage | null {
	const raw = text(value, 40).toLowerCase();
	if (allStages.has(raw)) return raw as ProjectStage;
	return stageAliases[raw] ?? null;
}

const linkKinds: Record<string, ProjectLinkKind> = {
	thread: "thread",
	discord: "thread",
	change: "change",
	"self-fix": "change",
	desk: "desk",
	session: "session",
	kanban: "session",
	"kanban-session": "session",
	card: "session",
	pr: "pr",
	"pull-request": "pr",
};

const kindOf = (value: unknown): ProjectLinkKind =>
	linkKinds[text(value, 40).toLowerCase()] ?? "other";

const safeUrl = (value: unknown): string | null => {
	const raw = text(value, 2000);
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.toString()
			: null;
	} catch {
		return null;
	}
};

const list = (value: unknown, max: number): Raw[] =>
	Array.isArray(value) ? value.filter(isRecord).slice(0, max) : [];

/** A session ref as the board knows it, without a `session:` card prefix. */
const sessionRef = (ref: string): string => ref.replace(/^session:/, "");

function projectOf(raw: Raw, now: number): Project | null {
	const id = text(raw.id, 120);
	const title = text(raw.title, 200) || id;
	if (!id) return null;
	const links: ProjectLink[] = list(raw.links, 50).flatMap((link) => {
		const ref = text(link.ref, 300);
		return ref
			? [{ kind: kindOf(link.type), ref, url: safeUrl(link.url) }]
			: [];
	});
	const live: ProjectLive[] = list(raw.live, 50).flatMap((item) => {
		const itemId = text(item.id, 300);
		return itemId
			? [
					{
						kind: kindOf(item.type),
						id: itemId,
						state: text(item.state, 60),
						title: text(item.title, 200),
					},
				]
			: [];
	});
	const history: ProjectStep[] = list(raw.history, 200)
		.flatMap((step) => {
			const at = timeOf(step.at);
			const stage = stageOf(step.stage);
			return at !== null && stage
				? [{ at, stage, note: text(step.note, 300) }]
				: [];
		})
		.sort((a, b) => a.at - b.at);
	const stage = stageOf(raw.stage) ?? history.at(-1)?.stage ?? "idea";
	const touchedAt =
		timeOf(raw.touched) ?? history.at(-1)?.at ?? timeOf(raw.created);
	const progress =
		typeof raw.progress === "number" && Number.isFinite(raw.progress)
			? Math.min(
					1,
					Math.max(0, raw.progress > 1 ? raw.progress / 100 : raw.progress),
				)
			: null;
	const stale =
		typeof raw.stale === "boolean"
			? raw.stale
			: stage !== "done" &&
				stage !== "dropped" &&
				touchedAt !== null &&
				now - touchedAt > staleDays * 86_400_000;
	const sessions = [
		...links.filter((l) => l.kind === "session").map((l) => l.ref),
		...live.filter((l) => l.kind === "session").map((l) => l.id),
	].map(sessionRef);
	return {
		id,
		title,
		parent: textOrNull(raw.parent, 120),
		area: text(raw.area, 60),
		kind: text(raw.kind, 60),
		stage,
		state: text(raw.state, 300),
		next: text(raw.next, 300),
		blockedOn: textOrNull(raw.blocked_on, 300),
		createdAt: timeOf(raw.created),
		touchedAt,
		stageSince: timeOf(raw.stage_since),
		links,
		history,
		stale,
		progress,
		live,
		sessions: [...new Set(sessions)],
		keywords: [
			...new Set(
				(Array.isArray(raw.keywords) ? raw.keywords : [])
					.slice(0, 20)
					.map((word) => text(word, 40).toLowerCase())
					.filter((word) => /^[a-z0-9]{3,40}$/.test(word)),
			),
		],
	};
}

/** The endpoint's JSON as the board's projects, dropping what it cannot read. */
export function normaliseProjects(
	body: unknown,
	now: number,
): { updatedAt: number | null; projects: Project[] } | null {
	if (!isRecord(body) || !Array.isArray(body.projects)) return null;
	const seen = new Set<string>();
	const projects = list(body.projects, maxProjects).flatMap((raw) => {
		const project = projectOf(raw, now);
		if (!project || seen.has(project.id)) return [];
		seen.add(project.id);
		return [project];
	});
	return { updatedAt: timeOf(body.updated), projects };
}

export type ProjectsSource = { list(): Promise<ProjectsListing> };

type SourceDeps = {
	config: ProjectsConfig;
	fetch?: typeof fetch;
	readFile?: (file: string) => Promise<string>;
	now?: () => number;
	/** How long one read serves before the next, so polling pages share it. */
	cacheMs?: number;
	timeoutMs?: number;
};

const describe = (error: unknown): string =>
	error instanceof Error
		? error.message.slice(0, 200)
		: "Could not read projects";

export function createProjectsSource(deps: SourceDeps): ProjectsSource {
	const now = deps.now ?? Date.now;
	const cacheMs = deps.cacheMs ?? 30_000;
	const timeoutMs = deps.timeoutMs ?? 10_000;
	const { config } = deps;
	let last: ProjectsListing | null = null;
	let lastTry = 0;
	let pending: Promise<ProjectsListing> | null = null;

	const readBody = async (): Promise<string> => {
		if (config.mode === "file") {
			if (!deps.readFile) throw new Error("No file reader");
			return deps.readFile(config.file);
		}
		if (config.mode !== "url") throw new Error("Projects are not connected");
		const doFetch = deps.fetch ?? fetch;
		const response = await doFetch(config.url, {
			headers: {
				accept: "application/json",
				...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
			},
			redirect: "error",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			throw new Error(`The projects endpoint answered ${response.status}`);
		}
		const length = Number(response.headers.get("content-length"));
		if (length > maxProjectBytes) throw new Error("The projects are too big");
		return response.text();
	};

	const read = async (): Promise<ProjectsListing> => {
		const at = now();
		lastTry = at;
		try {
			const body = await readBody();
			if (body.length > maxProjectBytes) {
				throw new Error("The projects are too big");
			}
			const read = normaliseProjects(JSON.parse(body), at);
			if (!read) throw new Error("The projects are not in the expected shape");
			last = { status: "ok", fetchedAt: at, ...read };
			return last;
		} catch (error) {
			const why = describe(error);
			if (last && last.projects.length > 0) {
				last = { ...last, error: why };
				return last;
			}
			last = { ...emptyListing("unavailable", why), fetchedAt: at };
			return last;
		}
	};

	return {
		async list() {
			if (config.mode === "off") return emptyListing("unconfigured");
			if (config.mode === "fixture") {
				const at = now();
				return {
					status: "fixture",
					fetchedAt: at,
					...(normaliseProjects(projectsFixture(at), at) ?? {
						updatedAt: null,
						projects: [],
					}),
				};
			}
			if (last && now() - lastTry < cacheMs) return last;
			pending ??= read().finally(() => {
				pending = null;
			});
			return pending;
		},
	};
}

const day = 86_400_000;

/**
 * Invented sample projects in the endpoint's shape, for development and the
 * demo. Session ids match the demo board's, so their cards carry chips.
 */
export function projectsFixture(now: number): unknown {
	const ago = (days: number) => new Date(now - days * day).toISOString();
	const steps = (...pairs: [number, string, string][]) =>
		pairs.map(([days, stage, note]) => ({ at: ago(days), stage, note }));
	return {
		updated: ago(0),
		projects: [
			{
				id: "garden",
				title: "Garden automation",
				parent: null,
				area: "home",
				kind: "project",
				stage: "building",
				state: "Watering schedule works; the soil sensors are next",
				next: "Pair the second soil sensor",
				blocked_on: null,
				created: ago(40),
				touched: ago(1),
				stage_since: ago(9),
				links: [
					{ type: "session", ref: "a1f0c2d4e5" },
					{
						type: "pr",
						ref: "garden#12",
						url: "https://example.com/garden/pull/12",
					},
				],
				history: steps(
					[40, "idea", "Thought of it while away"],
					[25, "planned", "Parts list written"],
					[9, "building", "Valves wired"],
				),
				progress: 0.45,
				live: [
					{
						type: "session",
						id: "a1f0c2d4e5",
						state: "working",
						title: "Sensor pairing",
					},
				],
			},
			{
				id: "garden-valves",
				title: "Valve controller",
				parent: "garden",
				area: "home",
				kind: "sub-project",
				stage: "live",
				state: "Running every morning",
				next: "Watch it through a hot week",
				created: ago(30),
				touched: ago(3),
				stage_since: ago(3),
				history: steps(
					[30, "planned", ""],
					[12, "building", ""],
					[5, "landing", "Testing on one bed"],
					[3, "live", "All beds"],
				),
				links: [],
				live: [],
			},
			{
				id: "garden-sensors",
				title: "Soil sensors",
				parent: "garden",
				area: "home",
				kind: "sub-project",
				stage: "building",
				state: "One of two paired",
				next: "Pair the second sensor",
				blocked_on: "The second sensor's batteries",
				created: ago(20),
				touched: ago(2),
				stage_since: ago(6),
				history: steps(
					[20, "idea", ""],
					[10, "planned", ""],
					[6, "building", ""],
				),
				links: [{ type: "session", ref: "c3d2e4f5a7" }],
				live: [],
			},
			{
				id: "reading-app",
				title: "Reading tracker",
				parent: null,
				area: "personal",
				kind: "project",
				stage: "idea",
				state: "Just a thought",
				next: "Sketch what it would show",
				created: ago(30),
				touched: ago(30),
				history: steps([30, "idea", ""]),
				links: [],
				live: [],
			},
			{
				id: "photo-backup",
				title: "Photo backup",
				parent: null,
				area: "home",
				kind: "project",
				stage: "landing",
				state: "Last test restore under way",
				next: "Check the restored album",
				created: ago(50),
				touched: ago(0.2),
				stage_since: ago(1),
				history: steps(
					[50, "idea", ""],
					[44, "planned", ""],
					[20, "building", ""],
					[1, "landing", "Test restore"],
				),
				progress: 0.9,
				links: [{ type: "change", ref: "20260101-000000-1" }],
				live: [
					{
						type: "change",
						id: "20260101-000000-1",
						state: "running",
						title: "Restore check",
					},
				],
			},
			{
				id: "board-themes",
				title: "Board themes",
				parent: null,
				area: "tools",
				kind: "project",
				stage: "maintaining",
				state: "Light and dark both done",
				next: "Nothing until someone asks",
				created: ago(90),
				touched: ago(21),
				stage_since: ago(60),
				history: steps(
					[90, "idea", ""],
					[85, "building", ""],
					[70, "live", ""],
					[60, "maintaining", ""],
				),
				links: [],
				live: [],
			},
			{
				id: "trip-planner",
				title: "Trip planner",
				parent: null,
				area: "personal",
				kind: "project",
				stage: "paused",
				state: "Waiting for dates",
				next: "Pick the dates",
				blocked_on: "Dates not settled",
				created: ago(35),
				touched: ago(16),
				stage_since: ago(16),
				history: steps(
					[35, "idea", ""],
					[28, "planned", ""],
					[16, "paused", "No dates yet"],
				),
				links: [],
				live: [],
			},
			{
				id: "old-widget",
				title: "Desk clock widget",
				parent: null,
				area: "tools",
				kind: "project",
				stage: "done",
				state: "Shipped and retired",
				next: "",
				created: ago(120),
				touched: ago(45),
				history: steps(
					[120, "idea", ""],
					[110, "building", ""],
					[100, "live", ""],
					[45, "done", ""],
				),
				links: [],
				live: [],
			},
			{
				id: "planned-notes",
				title: "Notes search",
				parent: null,
				area: "tools",
				kind: "project",
				stage: "planned",
				state: "Design agreed",
				next: "Start the index",
				created: ago(8),
				touched: ago(4),
				stage_since: ago(4),
				history: steps([8, "idea", ""], [4, "planned", ""]),
				links: [],
				live: [],
			},
		],
	};
}
