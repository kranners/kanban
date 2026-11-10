import type {
	Project,
	ProjectGraph,
	ProjectGraphNodeState,
} from "./projects.ts";
import type {
	Activity,
	ButlerCard,
	ButlerWaitingApproval,
	Session,
} from "./types.ts";

// A project's live dashboard, worked out from what the board already holds:
// the project record, the cards and sessions that belong to it, and the
// approvals waiting on Aaron. Pure, so the page and its tests read the same
// thing. The dependency graph is the one part no backend derives: a project
// may carry an authored one, whose nodes take their state live from the
// card or session they name.

export type WorkState = ProjectGraphNodeState;

const dayMs = 86_400_000;
export const bandWindowMs = dayMs;
const bandSlots = 96;

export const workStateOf = (activity: Activity): WorkState => {
	switch (activity) {
		case "working":
		case "watching":
			return "progress";
		case "needs-you":
			return "aaron";
		case "done":
			return "done";
		case "failed":
			return "other";
		default:
			return "idle";
	}
};

export type DashboardSession = Pick<
	Session,
	| "id"
	| "short"
	| "name"
	| "goal"
	| "activity"
	| "startedAt"
	| "updatedAt"
	| "needs"
	| "doing"
	| "cloud"
>;

export type WorkItem = {
	/** The card's or session's id on the board. */
	id: string;
	kind: "card" | "session";
	title: string;
	activity: Activity;
	state: WorkState;
	status: string;
	startedAt: number | null;
	finishedAt: number | null;
	updatedAt: number;
	link: string | null;
	/** Which project it came in through, when that is a sub-project. */
	via: string | null;
};

export type Band = { from: number; to: number; state: WorkState };

export type Movement = {
	state: "moving" | "idling" | "blocked";
	/** Who it is blocked on, when blocked. */
	on: "you" | "others" | null;
	working: number;
	/** State changes, starts and stage moves in the last 24 hours. */
	activity: number;
	/** The last 24 hours as runs of the loudest state, fractions of the window. */
	bands: Band[];
	/** The same window for each piece of work that ran in it, busiest state first. */
	rows: { id: string; title: string; state: WorkState; bands: Band[] }[];
};

export const maxMovementRows = 6;

export type TimelineEvent = {
	at: number;
	label: string;
	state: WorkState;
	kind: "stage" | "start" | "finish";
};

export type NeedItem = {
	key: string;
	title: string;
	detail: string;
	kind: "approval" | "session" | "blocked";
	/** The card, session or approval to open. */
	target: string | null;
	since: number | null;
};

export type GraphNode = {
	id: string;
	title: string;
	sub: string;
	state: WorkState;
	/** Whether its state came from a card or session on the board. */
	live: boolean;
	owner: string | null;
	layer: number;
	row: number;
	preds: string[];
	succs: string[];
	/** Open nodes downstream of it, which finishing it frees. */
	frees: number;
	critical: boolean;
	ready: boolean;
	target: string | null;
};

export type DashboardGraph = {
	authored: boolean;
	nodes: GraphNode[];
	edges: { from: string; to: string; critical: boolean }[];
	layers: number;
	rows: number;
	best: string | null;
	updatedAt: number | null;
};

export type Dashboard = {
	project: Project;
	children: Project[];
	work: WorkItem[];
	movement: Movement;
	timeline: TimelineEvent[];
	needs: NeedItem[];
	graph: DashboardGraph;
};

const statePriority: readonly WorkState[] = [
	"aaron",
	"progress",
	"other",
	"done",
	"idle",
	"unknown",
];
const louder = (a: WorkState, b: WorkState): WorkState =>
	statePriority.indexOf(a) <= statePriority.indexOf(b) ? a : b;

/** The project and every project below it, nearest first, stopping at a loop. */
export function familyOf(
	project: Project,
	projects: readonly Project[],
): Project[] {
	const out = [project];
	const seen = new Set([project.id]);
	for (let i = 0; i < out.length; i++) {
		for (const child of projects) {
			if (child.parent === out[i]?.id && !seen.has(child.id)) {
				seen.add(child.id);
				out.push(child);
			}
		}
	}
	return out;
}

const cardItem = (card: ButlerCard, via: string | null): WorkItem => ({
	id: card.id,
	kind: "card",
	title: card.title,
	activity: card.state,
	state: workStateOf(card.state),
	status: card.status ?? card.summary ?? "",
	startedAt: card.startedAt ?? card.history?.[0]?.at ?? null,
	finishedAt: card.finishedAt ?? null,
	updatedAt: card.updatedAt,
	link: card.link ?? null,
	via,
});

const sessionItem = (
	session: DashboardSession,
	via: string | null,
): WorkItem => ({
	id: session.id,
	kind: "session",
	title: session.goal ?? session.name,
	activity: session.activity,
	state: workStateOf(session.activity),
	status: session.needs ?? session.doing ?? "",
	startedAt: session.startedAt,
	finishedAt: null,
	updatedAt: session.updatedAt,
	link: session.cloud?.url ?? null,
	via,
});

const activityOrder: readonly WorkState[] = [
	"aaron",
	"progress",
	"other",
	"idle",
	"unknown",
	"done",
];

/** The cards and sessions of the project and its sub-projects, by the board's one project resolver. */
export function workOf(
	family: readonly Project[],
	owners: ReadonlyMap<string, string | null>,
	cards: readonly ButlerCard[],
	sessions: readonly DashboardSession[],
): WorkItem[] {
	const titles = new Map(family.map((p) => [p.id, p.title]));
	const top = family[0]?.id;
	const viaOf = (id: string): string | null | undefined => {
		const owner = owners.get(id);
		if (!owner || !titles.has(owner)) return undefined;
		return owner === top ? null : (titles.get(owner) ?? null);
	};
	const items: WorkItem[] = [];
	for (const card of cards) {
		const via = viaOf(card.id);
		if (via !== undefined) items.push(cardItem(card, via));
	}
	for (const session of sessions) {
		const via = viaOf(session.id);
		if (via !== undefined) items.push(sessionItem(session, via));
	}
	return items.sort(
		(a, b) =>
			activityOrder.indexOf(a.state) - activityOrder.indexOf(b.state) ||
			b.updatedAt - a.updatedAt,
	);
}

type Span = { from: number; to: number; state: WorkState };

function spansOf(
	item: WorkItem,
	card: ButlerCard | undefined,
	now: number,
): Span[] {
	const history = card?.history ?? [];
	if (history.length > 0) {
		const end = item.finishedAt ?? now;
		return history.map((event, i) => ({
			from: event.at,
			to: history[i + 1]?.at ?? (item.state === "done" ? event.at : end),
			state: workStateOf(event.state),
		}));
	}
	if (item.startedAt === null) return [];
	const open = item.state === "progress" || item.state === "aaron";
	return [
		{
			from: item.startedAt,
			to: open ? now : (item.finishedAt ?? item.updatedAt),
			state: item.state === "done" ? "progress" : item.state,
		},
	];
}

/** The last 24 hours of the project's work, as runs of its loudest state. */
export function bandsOf(spans: readonly Span[], now: number): Band[] {
	const start = now - bandWindowMs;
	const slotMs = bandWindowMs / bandSlots;
	const slots: WorkState[] = Array(bandSlots).fill("idle");
	for (const span of spans) {
		if (span.state === "idle" || span.to < start || span.from > now) continue;
		const first = Math.max(0, Math.floor((span.from - start) / slotMs));
		const last = Math.min(
			bandSlots - 1,
			Math.floor((Math.min(span.to, now) - start) / slotMs),
		);
		for (let i = first; i <= last; i++) {
			slots[i] = louder(span.state, slots[i] as WorkState);
		}
	}
	const bands: Band[] = [];
	slots.forEach((state, i) => {
		const last = bands.at(-1);
		if (last && last.state === state) last.to = (i + 1) / bandSlots;
		else bands.push({ from: i / bandSlots, to: (i + 1) / bandSlots, state });
	});
	return bands;
}

const isAaron = (blockedOn: string | null): boolean =>
	blockedOn !== null && /^(aaron|approval)\b/i.test(blockedOn.trim());

export function movementOf(
	project: Project,
	work: readonly WorkItem[],
	cards: ReadonlyMap<string, ButlerCard>,
	graph: DashboardGraph,
	needs: readonly NeedItem[],
	now: number,
): Movement {
	const since = now - bandWindowMs;
	const spansByItem = work.map((item) => ({
		item,
		spans: spansOf(item, cards.get(item.id), now).filter(
			(span) => span.state !== "idle" && span.to >= since,
		),
	}));
	const spans = spansByItem.flatMap((entry) => entry.spans);
	const working = work.filter((item) => item.state === "progress").length;
	const activity =
		project.history.filter((step) => step.at >= since).length +
		work.reduce(
			(sum, item) =>
				sum +
				(cards.get(item.id)?.history ?? []).filter((e) => e.at >= since)
					.length +
				(item.kind === "session" &&
				item.startedAt !== null &&
				item.startedAt >= since
					? 1
					: 0),
			0,
		);
	const open = graph.nodes.filter((n) => n.state !== "done");
	const frontier = open.filter((n) => n.preds.length === 0 || n.ready);
	const waitingOnYou =
		needs.some((n) => n.kind !== "blocked") ||
		isAaron(project.blockedOn) ||
		open.some((n) => n.state === "aaron");
	const allStuck =
		frontier.length > 0 &&
		frontier.every((n) => n.state === "aaron" || n.state === "other");
	const blocked =
		working === 0 && (project.blockedOn !== null || waitingOnYou || allStuck);
	return {
		state: blocked
			? "blocked"
			: working > 0 || activity > 0
				? "moving"
				: "idling",
		on: blocked ? (waitingOnYou ? "you" : "others") : null,
		working,
		activity,
		bands: bandsOf(spans, now),
		rows: spansByItem
			.filter((entry) => entry.spans.length > 0)
			.slice(0, maxMovementRows)
			.map(({ item, spans }) => ({
				id: item.id,
				title: item.title,
				state: item.state,
				bands: bandsOf(spans, now),
			})),
	};
}

/** Stage moves, and each card or session starting and finishing, oldest first. */
export function timelineOf(
	project: Project,
	work: readonly WorkItem[],
): TimelineEvent[] {
	const events: TimelineEvent[] = project.history.map((step) => ({
		at: step.at,
		label: step.note || `Moved to ${step.stage}`,
		state: "done",
		kind: "stage",
	}));
	for (const item of work) {
		if (item.startedAt !== null) {
			events.push({
				at: item.startedAt,
				label: item.title,
				state: item.state === "done" ? "done" : item.state,
				kind: "start",
			});
		}
		if (item.finishedAt !== null) {
			events.push({
				at: item.finishedAt,
				label: item.title,
				state: item.activity === "failed" ? "other" : "done",
				kind: "finish",
			});
		}
	}
	return events.sort((a, b) => a.at - b.at);
}

/** What waits on Aaron: approvals on the project's thread cards, sessions asking him, and what blocks it. */
export function needsOf(
	project: Project,
	work: readonly WorkItem[],
	cards: ReadonlyMap<string, ButlerCard>,
	approvals: readonly ButlerWaitingApproval[],
): NeedItem[] {
	const threadCards = new Map(
		work.flatMap((item) => {
			const thread = cards.get(item.id)?.thread?.id;
			return thread ? [[thread, item] as const] : [];
		}),
	);
	const needs: NeedItem[] = [];
	const asked = new Set<string>();
	for (const waiting of approvals) {
		const item = threadCards.get(waiting.thread);
		if (!item) continue;
		asked.add(item.id);
		needs.push({
			key: `approval:${waiting.thread}:${waiting.approval.at}`,
			title: waiting.approval.headline || waiting.title,
			detail: item.title,
			kind: "approval",
			target: item.id,
			since: waiting.approval.at,
		});
	}
	for (const item of work) {
		if (item.activity !== "needs-you" || asked.has(item.id)) continue;
		needs.push({
			key: `${item.kind}:${item.id}`,
			title: item.status || "Waiting for your answer",
			detail: item.title,
			kind: "session",
			target: item.id,
			since: item.updatedAt,
		});
	}
	if (project.blockedOn) {
		needs.push({
			key: "blocked",
			title: project.blockedOn,
			detail: isAaron(project.blockedOn)
				? "Blocked on you"
				: "Blocked on others",
			kind: "blocked",
			target: null,
			since: null,
		});
	}
	return needs;
}

/** Where a link's ref finds its card or session on the board. */
function liveStateOf(
	ref: string,
	work: readonly WorkItem[],
	cards: ReadonlyMap<string, ButlerCard>,
): WorkItem | undefined {
	return work.find((item) => {
		if (item.id === ref || item.id === `session:${ref}`) return true;
		if (item.kind === "session" && ref.length >= 8 && item.id.startsWith(ref)) {
			return true;
		}
		const card = cards.get(item.id);
		return (
			card !== undefined &&
			(card.selfFix === ref ||
				card.desk === ref ||
				card.thread?.id === ref ||
				(card.selfFix !== undefined &&
					/^\d{8}-\d{6}$/.test(ref) &&
					card.selfFix.startsWith(`${ref}-`)))
		);
	});
}

/**
 * The authored graph with each node's state live from the card or session
 * it names, or else a graph of the project's sub-projects and work, which
 * shows what there is but not what blocks what.
 */
export function graphOf(
	project: Project,
	children: readonly Project[],
	work: readonly WorkItem[],
	cards: ReadonlyMap<string, ButlerCard>,
): DashboardGraph {
	const authored: ProjectGraph | null = project.graph ?? null;
	const raw = authored
		? authored.nodes.map((node) => {
				const live = node.ref ? liveStateOf(node.ref, work, cards) : undefined;
				return {
					id: node.id,
					title: node.title,
					sub: live?.status || node.sub,
					state: live ? live.state : node.state,
					live: live !== undefined,
					owner: node.owner,
					target: live?.id ?? null,
				};
			})
		: [
				...children.map((child) => ({
					id: `project:${child.id}`,
					title: child.title,
					sub: child.state || child.next,
					state: stageState(child),
					live: false,
					owner: null,
					target: null,
				})),
				...work
					.filter((item) => item.via === null)
					.slice(0, 12)
					.map((item) => ({
						id: item.id,
						title: item.title,
						sub: item.status,
						state: item.state,
						live: true,
						owner: null,
						target: item.id,
					})),
			];
	const ids = new Set(raw.map((n) => n.id));
	const edges = (authored?.edges ?? []).filter(
		(e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to,
	);
	const preds = new Map(raw.map((n) => [n.id, [] as string[]]));
	const succs = new Map(raw.map((n) => [n.id, [] as string[]]));
	for (const edge of edges) {
		preds.get(edge.to)?.push(edge.from);
		succs.get(edge.from)?.push(edge.to);
	}
	const layer = new Map<string, number>();
	const layerOf = (id: string, path: Set<string>): number => {
		const known = layer.get(id);
		if (known !== undefined) return known;
		if (path.has(id)) return 0;
		path.add(id);
		const before = preds.get(id) ?? [];
		const at = before.length
			? 1 + Math.max(...before.map((p) => layerOf(p, path)))
			: 0;
		path.delete(id);
		layer.set(id, at);
		return at;
	};
	for (const node of raw) layerOf(node.id, new Set());
	const stateOf = new Map(raw.map((n) => [n.id, n.state]));
	const downstream = (id: string): Set<string> => {
		const seen = new Set<string>();
		const walk = (at: string) => {
			for (const next of succs.get(at) ?? []) {
				if (!seen.has(next)) {
					seen.add(next);
					walk(next);
				}
			}
		};
		walk(id);
		return seen;
	};
	const ordered = [...raw].sort(
		(a, b) => (layer.get(a.id) ?? 0) - (layer.get(b.id) ?? 0),
	);
	const length = new Map<string, number>();
	const via = new Map<string, string | null>();
	for (const node of ordered) {
		let best = 0;
		let from: string | null = null;
		for (const p of preds.get(node.id) ?? []) {
			if (
				(length.get(p) ?? 0) > best &&
				(layer.get(p) ?? 0) < (layer.get(node.id) ?? 0)
			) {
				best = length.get(p) ?? 0;
				from = p;
			}
		}
		length.set(node.id, best + 1);
		via.set(node.id, from);
	}
	const critical = new Set<string>();
	if (edges.length > 0) {
		let at = [...length.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
		while (at) {
			const from = via.get(at) ?? null;
			if (from) critical.add(`${from}>${at}`);
			at = from;
		}
	}
	const rowOf = rowsByBarycentre(ordered, layer, preds, succs);
	const rows = new Map<number, number>();
	for (const [id, row] of rowOf) {
		const at = layer.get(id) ?? 0;
		rows.set(at, Math.max(rows.get(at) ?? 0, row + 1));
	}
	const nodes: GraphNode[] = ordered.map((node) => {
		const at = layer.get(node.id) ?? 0;
		const row = rowOf.get(node.id) ?? 0;
		const before = preds.get(node.id) ?? [];
		return {
			...node,
			layer: at,
			row,
			preds: before,
			succs: succs.get(node.id) ?? [],
			frees:
				node.state === "done"
					? 0
					: [...downstream(node.id)].filter((id) => stateOf.get(id) !== "done")
							.length,
			critical: [...critical].some(
				(key) => key.startsWith(`${node.id}>`) || key.endsWith(`>${node.id}`),
			),
			ready:
				(node.state === "idle" || node.state === "unknown") &&
				before.every((p) => stateOf.get(p) === "done"),
		};
	});
	const best =
		edges.length > 0
			? ([...nodes]
					.filter((n) => n.state !== "done" && n.frees > 0)
					.sort((a, b) => b.frees - a.frees || a.layer - b.layer)[0]?.id ??
				null)
			: null;
	return {
		authored: authored !== null,
		nodes,
		edges: edges.map((e) => ({
			...e,
			critical: critical.has(`${e.from}>${e.to}`),
		})),
		layers: nodes.length ? Math.max(...nodes.map((n) => n.layer)) + 1 : 0,
		rows: Math.max(0, ...rows.values()),
		best,
		updatedAt: authored?.updatedAt ?? null,
	};
}

/**
 * Each node's row within its layer, ordered by the mean row of its
 * neighbours, down the layers and back up a few times, so edges cross as
 * little as a cheap pass can manage.
 */
function rowsByBarycentre(
	nodes: readonly { id: string }[],
	layer: ReadonlyMap<string, number>,
	preds: ReadonlyMap<string, string[]>,
	succs: ReadonlyMap<string, string[]>,
): Map<string, number> {
	const layers: string[][] = [];
	for (const node of nodes) {
		const at = layer.get(node.id) ?? 0;
		layers[at] = [...(layers[at] ?? []), node.id];
	}
	const row = new Map<string, number>();
	for (const ids of layers) {
		for (const [i, id] of (ids ?? []).entries()) row.set(id, i);
	}
	const mean = (ids: readonly string[], fallback: number) =>
		ids.length
			? ids.reduce((sum, id) => sum + (row.get(id) ?? 0), 0) / ids.length
			: fallback;
	const sweep = (ids: string[], by: ReadonlyMap<string, string[]>) => {
		const keyed = ids.map((id, i) => ({
			id,
			key: mean(by.get(id) ?? [], row.get(id) ?? i),
		}));
		keyed.sort((a, b) => a.key - b.key);
		keyed.forEach(({ id }, i) => {
			ids[i] = id;
			row.set(id, i);
		});
	};
	for (let pass = 0; pass < 4; pass++) {
		for (let at = 1; at < layers.length; at++) {
			const ids = layers[at];
			if (ids) sweep(ids, preds);
		}
		for (let at = layers.length - 2; at >= 0; at--) {
			const ids = layers[at];
			if (ids) sweep(ids, succs);
		}
	}
	return row;
}

export const stageState = (project: Project): WorkState => {
	if (
		project.stage === "done" ||
		project.stage === "live" ||
		project.stage === "maintaining"
	) {
		return "done";
	}
	if (project.blockedOn) return isAaron(project.blockedOn) ? "aaron" : "other";
	if (project.stage === "building" || project.stage === "landing") {
		return "progress";
	}
	return "idle";
};

export function dashboardOf(input: {
	project: Project;
	projects: readonly Project[];
	owners: ReadonlyMap<string, string | null>;
	cards: readonly ButlerCard[];
	sessions: readonly DashboardSession[];
	approvals: readonly ButlerWaitingApproval[];
	now: number;
}): Dashboard {
	const family = familyOf(input.project, input.projects);
	const children = input.projects.filter((p) => p.parent === input.project.id);
	const cards = new Map(input.cards.map((card) => [card.id, card]));
	const work = workOf(family, input.owners, input.cards, input.sessions);
	const graph = graphOf(input.project, children, work, cards);
	const needs = needsOf(input.project, work, cards, input.approvals);
	return {
		project: input.project,
		children,
		work,
		movement: movementOf(input.project, work, cards, graph, needs, input.now),
		timeline: timelineOf(input.project, work),
		needs,
		graph,
	};
}

/** The projects of one status column in its order, and where one sits in it. */
export function neighboursIn(
	column: readonly { project: Project }[],
	id: string,
): {
	index: number;
	count: number;
	previous: string | null;
	next: string | null;
} {
	const ids = column.map((entry) => entry.project.id);
	const index = ids.indexOf(id);
	return {
		index,
		count: ids.length,
		previous: index > 0 ? (ids[index - 1] ?? null) : null,
		next:
			index >= 0 && index < ids.length - 1 ? (ids[index + 1] ?? null) : null,
	};
}
