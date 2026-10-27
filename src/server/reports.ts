import { randomUUID } from "node:crypto";
import type {
	Annotations,
	Board,
	Layout,
	Note,
	Point,
	Region,
	ReportResult,
	Session,
} from "../shared/types.ts";
import { maxNoteText } from "../shared/types.ts";
import { gridSize, snap } from "../web/grid.ts";
import type { Group } from "../web/groups.ts";
import { type NodeKey, nodeKey } from "../web/layout.ts";
import { noteSizeFor, topZ } from "../web/notes.ts";
import { arrange, near, nearestFree, seedsOf } from "../web/placement.ts";
import { type AnnotationStore, maxAnnotations } from "./annotations.ts";
import type { Audit } from "./audit.ts";
import type { Answer, SessionAsker } from "./exit.ts";

export const reportPrompt =
	"The kanban board wants a status report on this session. Do not do any more work. " +
	"In a few short markdown bullet points, say what you are working on, what is done, what is left, " +
	"and anything blocked or waiting on a person. Answer with the bullet points only.";

const reportGap = gridSize * 2;

type Rect = { x: number; y: number; w: number; h: number };

const clipped = (text: string): string =>
	text.length > maxNoteText ? `${text.slice(0, maxNoteText - 1)}…` : text;

const heading = (at: Date): string =>
	`**Status · ${at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}**`;

export const reportText = (answer: string, at: Date): string =>
	clipped(`${heading(at)}\n\n${answer.trim()}`);

export type Reply = { name: string; answer: Answer };

export const regionReportText = (replies: Reply[], at: Date): string =>
	clipped(
		[
			heading(at),
			...replies.map(
				({ name, answer }) =>
					`**${name}**\n\n${answer.ok ? answer.answer.trim() : `_No answer: ${answer.error}_`}`,
			),
		].join("\n\n"),
	);

type Owner = Pick<Note, "session" | "region">;

const previousReport = (
	annotations: Annotations,
	owner: Owner,
): Note | undefined =>
	Object.values(annotations).find(
		(a): a is Note =>
			a.kind === "note" &&
			a.session === owner.session &&
			a.region === owner.region,
	);

const spotBeside = (
	card: Rect,
	size: { w: number; h: number },
	taken: Rect[],
): Point => {
	const start = { x: snap(card.x + card.w + reportGap), y: snap(card.y) };
	const fits = (at: Point) =>
		!taken.some((rect) => near({ ...at, ...size }, rect, gridSize));
	return nearestFree(start, fits) ?? start;
};

const ownedNote = (
	owner: Owner,
	beside: Rect | undefined,
	text: string,
	annotations: Annotations,
	cards: ReadonlyMap<NodeKey, Rect>,
	newId: () => string,
): Note => {
	const size = noteSizeFor(text);
	const previous = previousReport(annotations, owner);
	if (previous) return { ...previous, ...size, text };
	const spot = beside
		? spotBeside(beside, size, [
				...cards.values(),
				...Object.values(annotations),
			])
		: { x: 0, y: 0 };
	return {
		id: newId(),
		kind: "note",
		...spot,
		...size,
		z: topZ(annotations) + 1,
		text,
		color: "blue",
		...owner,
	};
};

export const reportNote = (
	session: Session,
	text: string,
	annotations: Annotations,
	cards: ReadonlyMap<NodeKey, Rect>,
	newId: () => string,
): Note =>
	ownedNote(
		{ session: session.id },
		cards.get(nodeKey({ kind: "session", id: session.id })),
		text,
		annotations,
		cards,
		newId,
	);

export const regionReportNote = (
	region: Region,
	frame: Rect,
	text: string,
	annotations: Annotations,
	cards: ReadonlyMap<NodeKey, Rect>,
	newId: () => string,
): Note =>
	ownedNote({ region: region.id }, frame, text, annotations, cards, newId);

export const cardsOf = (
	board: Board,
	layout: Layout,
): ReadonlyMap<NodeKey, Rect> =>
	arrange(board, layout, seedsOf(board), new Map()).nodes;

export type RegionMembers = { frame: Rect; sessions: Session[] };

export const regionMembersOf = (
	board: Board,
	projects: readonly Group[],
	regionId: string,
): RegionMembers | null => {
	const group = projects.find((g) => g.region?.id === regionId);
	if (!group) return null;
	const members = new Set(group.members);
	return {
		frame: group.frame,
		sessions: board.sessions.filter((s) =>
			members.has(nodeKey({ kind: "session", id: s.id })),
		),
	};
};

const fullError = `The board holds at most ${maxAnnotations} notes and stickers`;

const boardFull = (annotations: Annotations, owner: Owner): boolean =>
	!previousReport(annotations, owner) &&
	Object.keys(annotations).length >= maxAnnotations;

const oneAtATime = <T>(
	idOf: (subject: T) => string,
	report: (subject: T) => Promise<ReportResult>,
	finish: (subject: T, identity: string | null, result: ReportResult) => void,
) => {
	const reporting = new Set<string>();
	return (
		subject: T,
		identity: string | null,
	): Promise<ReportResult> | null => {
		const id = idOf(subject);
		if (reporting.has(id)) return null;
		reporting.add(id);
		return report(subject)
			.catch(
				(error: unknown): ReportResult => ({
					ok: false,
					error: `Status report failed: ${(error as Error).message}`,
				}),
			)
			.finally(() => reporting.delete(id))
			.then((result) => {
				finish(subject, identity, result);
				return result;
			});
	};
};

const audited = (result: ReportResult): string =>
	result.ok ? "noted" : `error: ${result.error}`;

export type ReportRunner = (
	session: Session,
	identity: string | null,
) => Promise<ReportResult> | null;

export const createReportRunner = (deps: {
	ask: SessionAsker;
	annotations: AnnotationStore;
	cards: () => ReadonlyMap<NodeKey, Rect>;
	audit: Audit;
	announce: (sessionId: string, result: ReportResult) => void;
	now?: () => Date;
	newId?: () => string;
}): ReportRunner =>
	oneAtATime(
		(session: Session) => session.id,
		async (session) => {
			const owner = { session: session.id };
			if (boardFull(deps.annotations.current(), owner))
				return { ok: false, error: fullError };
			const answer = await deps.ask(session, reportPrompt);
			if (!answer.ok) return answer;
			const annotations = deps.annotations.current();
			const cards = deps.cards();
			const onBoard = cards.has(nodeKey({ kind: "session", id: session.id }));
			if (!onBoard && !previousReport(annotations, owner)) {
				return {
					ok: false,
					error: "The session left the board before its status report arrived",
				};
			}
			const note = reportNote(
				session,
				reportText(answer.answer, deps.now?.() ?? new Date()),
				annotations,
				cards,
				deps.newId ?? randomUUID,
			);
			const stored = deps.annotations.put(note);
			return "error" in stored ? { ok: false, error: stored.error } : stored;
		},
		(session, identity, result) => {
			deps.audit({
				action: "session-report",
				sessionId: session.id,
				short: session.short,
				identity,
				result: audited(result),
			});
			deps.announce(session.id, result);
		},
	);

export type RegionReportRunner = (
	region: Region,
	identity: string | null,
) => Promise<ReportResult> | null;

export const createRegionReportRunner = (deps: {
	ask: SessionAsker;
	annotations: AnnotationStore;
	members: (regionId: string) => RegionMembers | null;
	cards: () => ReadonlyMap<NodeKey, Rect>;
	audit: Audit;
	announce: (regionId: string, result: ReportResult) => void;
	now?: () => Date;
	newId?: () => string;
}): RegionReportRunner =>
	oneAtATime(
		(region: Region) => region.id,
		async (region) => {
			if (boardFull(deps.annotations.current(), { region: region.id }))
				return { ok: false, error: fullError };
			const asked = deps.members(region.id)?.sessions ?? [];
			if (asked.length === 0)
				return { ok: false, error: "There are no sessions in this project" };
			const replies = await Promise.all(
				asked.map(
					async (session): Promise<Reply> => ({
						name: session.name,
						answer: await deps.ask(session, reportPrompt),
					}),
				),
			);
			const failed = replies.flatMap(({ answer }) =>
				answer.ok ? [] : [answer.error],
			);
			if (failed.length === replies.length)
				return { ok: false, error: [...new Set(failed)].join("; ") };
			const placed = deps.members(region.id);
			if (!placed) {
				return {
					ok: false,
					error:
						"The project region was deleted before its status report arrived",
				};
			}
			const annotations = deps.annotations.current();
			const note = regionReportNote(
				region,
				placed.frame,
				regionReportText(replies, deps.now?.() ?? new Date()),
				annotations,
				deps.cards(),
				deps.newId ?? randomUUID,
			);
			const stored = deps.annotations.put(note);
			return "error" in stored ? { ok: false, error: stored.error } : stored;
		},
		(region, identity, result) => {
			deps.audit({
				action: "region-report",
				regionId: region.id,
				cwd: region.cwd,
				identity,
				result: audited(result),
			});
			deps.announce(region.id, result);
		},
	);
