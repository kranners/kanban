import type {
	Board,
	Preview,
	Session,
	TranscriptEntry,
} from "../shared/types.ts";

export const previewEntryCount = 12;
const linesPerEntry = 4;
const lineLength = 200;

const htmlEscapes: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

const escapeHtml = (text: string): string =>
	text.replace(/[&<>"']/g, (char) => htmlEscapes[char] ?? char);

const clip = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const compactLines = (text: string): string => {
	const lines = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "");
	const kept = lines
		.slice(0, linesPerEntry)
		.map((line) => clip(line, lineLength));
	if (lines.length > linesPerEntry) kept.push("…");
	return escapeHtml(kept.join("\n"));
};

const toolCall = (summary: string): string => {
	const separator = summary.indexOf(": ");
	if (separator === -1) return `<b>${escapeHtml(summary)}</b>`;
	const name = escapeHtml(summary.slice(0, separator));
	const detail = compactLines(summary.slice(separator + 2));
	return `<b>${name}</b>(${detail})`;
};

const marks: Record<TranscriptEntry["role"], string> = {
	user: "&gt;",
	assistant: "●",
	tool: "●",
	peer: "✉",
};

const renderEntry = ({ role, text }: TranscriptEntry): string => {
	const body = role === "tool" ? toolCall(text) : compactLines(text);
	return `<div class="tx tx-${role}"><span class="tx-mark">${marks[role]}</span> ${body}</div>`;
};

export const renderTranscriptPreview = (entries: TranscriptEntry[]): string =>
	entries
		.filter((entry) => entry.text.trim() !== "")
		.map(renderEntry)
		.join("");

export type TranscriptReader = (
	sessionId: string,
	limit: number,
) => Promise<TranscriptEntry[]>;

export type Previewer = {
	update(board: Board): Promise<void>;
	latest(): Preview[];
};

export type PreviewerOptions = {
	transcript: TranscriptReader;
	emit: (preview: Preview) => void;
	now?: () => number;
};

export const createPreviewer = ({
	transcript,
	emit,
	now = Date.now,
}: PreviewerOptions): Previewer => {
	const latest = new Map<string, Preview>();
	const renderedVersion = new Map<string, number>();
	let queue = Promise.resolve();

	const refresh = async (session: Session) => {
		renderedVersion.set(session.id, session.updatedAt);
		try {
			const html = renderTranscriptPreview(
				await transcript(session.id, previewEntryCount),
			);
			if (html === "" || latest.get(session.id)?.html === html) return;
			const preview = { sessionId: session.id, html, capturedAt: now() };
			latest.set(session.id, preview);
			emit(preview);
		} catch {
			return;
		}
	};

	const pass = async (board: Board) => {
		const known = new Set(board.sessions.map((session) => session.id));
		for (const id of latest.keys()) if (!known.has(id)) latest.delete(id);
		for (const id of renderedVersion.keys()) {
			if (!known.has(id)) renderedVersion.delete(id);
		}
		for (const session of board.sessions) {
			if (renderedVersion.get(session.id) !== session.updatedAt) {
				await refresh(session);
			}
		}
	};

	return {
		update(board) {
			queue = queue.then(() => pass(board));
			return queue;
		},
		latest: () => [...latest.values()],
	};
};
