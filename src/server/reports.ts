import { randomUUID } from "node:crypto";
import type {
	Annotations,
	Board,
	Layout,
	Note,
	Point,
	ReportResult,
	Session,
} from "../shared/types.ts";
import { maxNoteText } from "../shared/types.ts";
import { gridSize, snap } from "../web/grid.ts";
import { type NodeKey, nodeKey } from "../web/layout.ts";
import { noteSizeFor, topZ } from "../web/notes.ts";
import { arrange, near, nearestFree, seedsOf } from "../web/placement.ts";
import type { AnnotationStore } from "./annotations.ts";
import type { Audit } from "./audit.ts";
import type { SessionAsker } from "./exit.ts";

export const reportPrompt =
	"The kanban board wants a status report on this session. Do not do any more work. " +
	"In a few short markdown bullet points, say what you are working on, what is done, what is left, " +
	"and anything blocked or waiting on a person. Answer with the bullet points only.";

const reportGap = gridSize * 2;

type Rect = { x: number; y: number; w: number; h: number };

export const reportText = (answer: string, at: Date): string => {
	const time = at.toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
	});
	const text = `**Status · ${time}**\n\n${answer.trim()}`;
	return text.length > maxNoteText
		? `${text.slice(0, maxNoteText - 1)}…`
		: text;
};

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

export const reportNote = (
	session: Session,
	text: string,
	annotations: Annotations,
	cards: ReadonlyMap<NodeKey, Rect>,
	newId: () => string,
): Note => {
	const size = noteSizeFor(text);
	const previous = Object.values(annotations).find(
		(a): a is Note => a.kind === "note" && a.session === session.id,
	);
	if (previous) return { ...previous, ...size, text };
	const card = cards.get(nodeKey({ kind: "session", id: session.id }));
	const spot = card
		? spotBeside(card, size, [...cards.values(), ...Object.values(annotations)])
		: { x: 0, y: 0 };
	return {
		id: newId(),
		kind: "note",
		...spot,
		...size,
		z: topZ(annotations) + 1,
		text,
		color: "blue",
		session: session.id,
	};
};

export const cardsOf = (
	board: Board,
	layout: Layout,
): ReadonlyMap<NodeKey, Rect> =>
	arrange(board, layout, seedsOf(board), new Map()).nodes;

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
}): ReportRunner => {
	const reporting = new Set<string>();
	const report = async (session: Session): Promise<ReportResult> => {
		const answer = await deps.ask(session, reportPrompt);
		if (!answer.ok) return answer;
		const note = reportNote(
			session,
			reportText(answer.answer, deps.now?.() ?? new Date()),
			deps.annotations.current(),
			deps.cards(),
			deps.newId ?? randomUUID,
		);
		const stored = deps.annotations.put(note);
		return "error" in stored ? { ok: false, error: stored.error } : stored;
	};
	return (session, identity) => {
		if (reporting.has(session.id)) return null;
		reporting.add(session.id);
		return report(session)
			.catch(
				(error: unknown): ReportResult => ({
					ok: false,
					error: `Status report failed: ${(error as Error).message}`,
				}),
			)
			.finally(() => reporting.delete(session.id))
			.then((result) => {
				deps.audit({
					action: "session-report",
					sessionId: session.id,
					short: session.short,
					identity,
					result: result.ok ? "noted" : `error: ${result.error}`,
				});
				deps.announce(session.id, result);
				return result;
			});
	};
};
