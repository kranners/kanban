import { normaliseProjects } from "../server/projects.ts";
import { projectsOf } from "../shared/butlerRegions.ts";
import { type Dashboard, dashboardOf } from "../shared/projectDashboard.ts";
import type { Project } from "../shared/projects.ts";
import { ownedSubagents } from "../shared/reportedSubagents.ts";
import { subagentCountsBySession } from "../shared/subagents.ts";
import {
	isDiscordLink,
	parseThreadEntry,
	threadCardFields,
	threadCardId,
} from "../shared/threadEntry.ts";
import {
	type ButlerCard,
	discordIdPattern,
	type Session,
	type StatusReport,
	type Subagent,
} from "../shared/types.ts";
import { cardSession } from "../web/butlerSessions.ts";
import { butlerCardView, type CardView } from "../web/cardFace.ts";
import { defaultLayoutOptions } from "../web/layout.ts";
import { type SubagentChips, subagentChips } from "../web/subagentChips.ts";

// The card sheet's input: the JSON a renderer puts in #sheet-data, read
// into what the board's own components draw. A card is one of the daemon's
// thread cards, read by the board's own mapping, so a picture of it says
// what its card on the board says.

export const sheetKinds = ["cards", "strip", "dashboard", "report"] as const;
export type SheetKind = (typeof sheetKinds)[number];

export const defaultSheetWidth = 960;
export const cardSize = defaultLayoutOptions.session;

/** One card as the board draws it: the card, the session it stands as, its view, subagent chips and how many it started. */
export type SheetCard = {
	card: ButlerCard;
	session: Session;
	view: CardView;
	chips: SubagentChips;
	linked: number;
};

export type SheetInput = {
	kind: SheetKind;
	theme?: "dark" | "light";
	width: number;
	now: number;
	cards: SheetCard[];
	dashboard?: { project: Project; dash: Dashboard };
	report?: StatusReport;
};

export type Parsed =
	| { ok: true; input: SheetInput }
	| { ok: false; error: string };

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

class SheetError extends Error {}

const fail = (message: string): never => {
	throw new SheetError(message);
};

/**
 * A card as the daemon's thread cards file has it, with what a picture can
 * do without filled in: a card of a desk session not yet in a thread has no
 * Discord id or link, and a card without times is as of now.
 */
function asThreadEntry(raw: Fields, index: number, now: number): Fields {
	return {
		...raw,
		id:
			typeof raw.id === "string" && discordIdPattern.test(raw.id)
				? raw.id
				: `${10_000 + index}`,
		status: typeof raw.status === "string" ? raw.status : "",
		link: isDiscordLink(raw.link) ? raw.link : "https://discord.com/",
		createdAt: isTime(raw.createdAt) ? raw.createdAt : now,
		lastActiveAt: isTime(raw.lastActiveAt) ? raw.lastActiveAt : now,
		private: raw.private === true,
		events: [],
		approvals: [],
	};
}

/** A sheet card as the Butler card the board keeps for its thread. */
export function butlerCardOf(
	raw: unknown,
	index: number,
	now: number,
): ButlerCard {
	if (!isRecord(raw)) return fail(`card ${index + 1} is not an object`);
	const entry = parseThreadEntry(asThreadEntry(raw, index, now));
	if (!entry) {
		return fail(
			`card ${index + 1} is not a thread card: it needs a title, a kind of dm, conversation, board, job, desk, scheduled or voice, and a state of working, needs-you, idle, done or failed`,
		);
	}
	const { link, ...fields } = threadCardFields(entry);
	return {
		id: threadCardId(entry.id),
		kind: "butler-card",
		x: 0,
		y: 0,
		...cardSize,
		z: 0,
		updatedAt: entry.lastActiveAt,
		...fields,
		...(isDiscordLink(raw.link) ? { link } : {}),
	};
}

/** Each Butler card as the board draws it, its subagents owned by it and the cards it started counted. */
export function sheetCardsOf(
	cards: readonly ButlerCard[],
	now: number,
): SheetCard[] {
	const sessions = cards.map((card) => cardSession(card));
	const subagents: Subagent[] = sessions.flatMap((session) =>
		ownedSubagents(session.butler?.card.subagents ?? [], session.id),
	);
	const counts = subagentCountsBySession(subagents);
	return cards.map((card, i) => {
		const session = sessions[i] as Session;
		return {
			card,
			session,
			view: butlerCardView(card, now),
			chips: subagentChips(subagents, session.id, counts[session.id]),
			linked: card.thread
				? cards.filter(
						(other) => other.id !== card.id && other.parent === card.id,
					).length
				: 0,
		};
	});
}

const boardProjectKeys: Record<string, string> = {
	blockedOn: "blocked_on",
	createdAt: "created",
	touchedAt: "touched",
	stageSince: "stage_since",
};

/** A project as projects.json has it, or as the board's Project has it, in projects.json's shape. */
function asListedProject(raw: unknown): unknown {
	if (!isRecord(raw)) return raw;
	const listed: Fields = { ...raw };
	for (const [board, file] of Object.entries(boardProjectKeys)) {
		if (board in raw && !(file in raw)) listed[file] = raw[board];
	}
	const kinds = (items: unknown) =>
		Array.isArray(items)
			? items.map((item) =>
					isRecord(item) && item.type === undefined && item.kind !== undefined
						? { ...item, type: item.kind }
						: item,
				)
			: items;
	listed.links = kinds(raw.links);
	listed.live = kinds(raw.live);
	if (isRecord(raw.graph) && raw.graph.updated === undefined) {
		listed.graph = { ...raw.graph, updated: raw.graph.updatedAt };
	}
	return listed;
}

function dashboardInput(
	raw: unknown,
	now: number,
): { project: Project; dash: Dashboard; cards: ButlerCard[] } {
	if (!isRecord(raw)) return fail("dashboard must be an object");
	if (!Array.isArray(raw.projects))
		return fail("dashboard.projects must be a list");
	const listing = normaliseProjects(
		{ projects: raw.projects.map(asListedProject) },
		now,
	);
	const projects = listing?.projects ?? [];
	const project = projects.find((p) => p.id === raw.project);
	if (!project) return fail(`dashboard.project names no project in the list`);
	const cards = cardList(raw.cards, now);
	const dash = dashboardOf({
		project,
		projects,
		owners: projectsOf(cards, projects),
		cards,
		sessions: [],
		approvals: [],
		now,
	});
	return { project, dash, cards };
}

function cardList(raw: unknown, now: number): ButlerCard[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return fail("cards must be a list");
	return raw.map((card, i) => butlerCardOf(card, i, now));
}

/** A status report as the board's ReportDashboard takes it; its screenshots stay off, since a picture loads nothing. */
function reportInput(raw: unknown): StatusReport {
	if (
		!isRecord(raw) ||
		!isTime(raw.at) ||
		typeof raw.title !== "string" ||
		!Array.isArray(raw.parts) ||
		!Array.isArray(raw.lanes)
	) {
		return fail("report must be a status report: at, title, parts and lanes");
	}
	return { ...(raw as unknown as StatusReport), shots: [] };
}

/** The sheet's JSON as what it draws, or why it cannot be drawn. */
export function parseSheetInput(text: string): Parsed {
	try {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return fail("sheet-data is not JSON");
		}
		if (!isRecord(raw)) return fail("sheet-data must be an object");
		if (!sheetKinds.includes(raw.kind as SheetKind)) {
			return fail(`kind must be one of ${sheetKinds.join(", ")}`);
		}
		const kind = raw.kind as SheetKind;
		if (!isTime(raw.now)) return fail("now must be a time in epoch ms");
		const now = raw.now;
		if (
			raw.theme !== undefined &&
			raw.theme !== "dark" &&
			raw.theme !== "light"
		) {
			return fail("theme must be dark or light");
		}
		const width =
			raw.width === undefined
				? defaultSheetWidth
				: typeof raw.width === "number" && raw.width >= 200 && raw.width <= 4000
					? Math.round(raw.width)
					: fail("width must be between 200 and 4000");
		const base = {
			kind,
			...(raw.theme ? { theme: raw.theme as "dark" | "light" } : {}),
			width,
			now,
		};
		if (kind === "cards" || kind === "strip") {
			const cards = cardList(raw.cards, now);
			if (cards.length === 0)
				return fail(`kind ${kind} needs at least one card`);
			const shown = kind === "strip" ? cards.slice(0, 1) : cards;
			return { ok: true, input: { ...base, cards: sheetCardsOf(shown, now) } };
		}
		if (kind === "dashboard") {
			const { project, dash, cards } = dashboardInput(raw.dashboard, now);
			return {
				ok: true,
				input: {
					...base,
					cards: sheetCardsOf(cards, now),
					dashboard: { project, dash },
				},
			};
		}
		return {
			ok: true,
			input: { ...base, cards: [], report: reportInput(raw.report) },
		};
	} catch (error) {
		if (error instanceof SheetError) return { ok: false, error: error.message };
		throw error;
	}
}
