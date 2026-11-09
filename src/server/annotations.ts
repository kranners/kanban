import {
	maxCardSubagents,
	parseCardSubagents,
} from "../shared/cardSubagents.ts";
import {
	type Annotation,
	type Annotations,
	type ArchiveOutcome,
	archiveOutcomes,
	type ButlerCardEvent,
	type ButlerCardMission,
	type ButlerCardState,
	type ButlerCardThread,
	type ButlerThreadKind,
	butlerCardStates,
	butlerThreadKinds,
	discordIdPattern,
	machinePattern,
	maxButlerHistory,
	maxButlerLink,
	maxButlerSummary,
	maxButlerTitle,
	maxCardMachines,
	maxMissionCovers,
	maxNoteText,
	maxReportBytes,
	missionIdPattern,
	type NoteColor,
	noteColors,
	type StatusReport,
} from "../shared/types.ts";
import { stickerIds } from "../web/stickers/manifest.ts";
import { parsePoint } from "./layout.ts";
import { createStateFile, readState } from "./stateFile.ts";

export type AnnotationStore = {
	current(): Annotations;
	put(annotation: Annotation): { ok: true } | { error: string };
	remove(id: string): boolean;
	saved(): Promise<void>;
};

export type AnnotationStoreOptions = {
	file: string;
	initial: Annotations;
	onChange: (annotations: Annotations) => void;
};

export const annotationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const maxAnnotations = 500;
export const minAnnotationSize = 24;
export const maxAnnotationSize = 2400;
const maxDepth = 1_000_000_000;

const isSize = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= minAnnotationSize &&
	value <= maxAnnotationSize;

const isDepth = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	Math.abs(value) <= maxDepth;

const isNoteColor = (value: unknown): value is NoteColor =>
	noteColors.includes(value as NoteColor);

const isRotation = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 180;

const isLink = (value: unknown): value is string | undefined =>
	value === undefined ||
	(typeof value === "string" && annotationIdPattern.test(value));

const isWebLink = (value: unknown): value is string => {
	if (typeof value !== "string" || value.length > maxButlerLink) return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
};

const deskPattern = /^[A-Za-z0-9-]{1,40}$/;
const boardThreadPattern = /^[A-Za-z0-9-]{1,64}$/;

/** A Butler thread card's Discord thread: its id, kind, link and whether it read private data. */
export const parseCardThread = (value: unknown): ButlerCardThread | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const { id, kind, link, private: hidden } = value as Record<string, unknown>;
	if (typeof id !== "string" || !discordIdPattern.test(id)) return null;
	if (!butlerThreadKinds.includes(kind as ButlerThreadKind)) return null;
	if (!isWebLink(link) || typeof hidden !== "boolean") return null;
	return { id, kind: kind as ButlerThreadKind, link, private: hidden };
};

/** A thread card's mission: its id and one line of what it covers, or null when it is not one. */
export const parseCardMission = (value: unknown): ButlerCardMission | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const { id, covers } = value as Record<string, unknown>;
	if (typeof id !== "string" || !missionIdPattern.test(id)) return null;
	if (typeof covers !== "string" || covers.length > maxMissionCovers) {
		return null;
	}
	return { id, covers };
};

/** A thread card's machines: distinct host names, at most maxCardMachines, or null when they are not. */
export const parseCardMachines = (value: unknown): string[] | null => {
	if (!Array.isArray(value) || value.length > maxCardMachines) return null;
	if (!value.every((m) => typeof m === "string" && machinePattern.test(m))) {
		return null;
	}
	return [...new Set(value as string[])];
};

const isCardHistory = (value: unknown): value is ButlerCardEvent[] =>
	Array.isArray(value) &&
	value.length <= maxButlerHistory &&
	value.every((event) => {
		if (typeof event !== "object" || event === null) return false;
		const { at, state, status, ...rest } = event as Record<string, unknown>;
		return (
			Object.keys(rest).length === 0 &&
			typeof at === "number" &&
			Number.isFinite(at) &&
			butlerCardStates.includes(state as ButlerCardState) &&
			(status === undefined ||
				(typeof status === "string" && status.length <= maxButlerTitle))
		);
	});

const shotUrl = /^\/api\/report-shots\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/;

const isReport = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) return false;
	const report = value as Record<string, unknown>;
	if (
		typeof report.at !== "number" ||
		typeof report.title !== "string" ||
		!Array.isArray(report.parts) ||
		!Array.isArray(report.lanes) ||
		!Array.isArray(report.shots)
	)
		return false;
	const shotsOk = report.shots.every(
		(shot) =>
			typeof shot === "object" &&
			shot !== null &&
			typeof (shot as { url?: unknown }).url === "string" &&
			shotUrl.test((shot as { url: string }).url),
	);
	return shotsOk && JSON.stringify(report).length <= maxReportBytes;
};

export const parseAnnotation = (
	id: string,
	body: unknown,
): Annotation | { error: string } => {
	if (!annotationIdPattern.test(id)) {
		return {
			error:
				"id must be 1 to 64 letters, digits, - or _, starting with a letter or digit",
		};
	}
	const point = parsePoint(body);
	if (!point) return { error: "x and y must be finite board coordinates" };
	const fields = body as Record<string, unknown>;
	const { w, h, z } = fields;
	if (!isSize(w) || !isSize(h)) {
		return {
			error: `w and h must be between ${minAnnotationSize} and ${maxAnnotationSize}`,
		};
	}
	if (!isDepth(z)) return { error: "z must be a finite number" };
	const placed = { id, ...point, w, h, z };
	if (fields.kind === "note") {
		const { text, color, session, region } = fields;
		if (typeof text !== "string" || text.length > maxNoteText) {
			return { error: `text must be a string of at most ${maxNoteText}` };
		}
		if (!isNoteColor(color)) {
			return { error: `color must be one of ${noteColors.join(", ")}` };
		}
		if (!isLink(session)) return { error: "session must be a session id" };
		if (!isLink(region)) return { error: "region must be a region id" };
		const { report, author } = fields;
		if (report !== undefined && !isReport(report)) {
			return {
				error: `report must be a status report of at most ${maxReportBytes} bytes`,
			};
		}
		if (author !== undefined && author !== "butler") {
			return { error: "author must be butler when given" };
		}
		return {
			...placed,
			kind: "note",
			text,
			color,
			...(session === undefined ? {} : { session }),
			...(region === undefined ? {} : { region }),
			...(report === undefined ? {} : { report: report as StatusReport }),
			...(author === undefined ? {} : { author }),
		};
	}
	if (fields.kind === "butler-card") {
		const {
			title,
			state,
			status,
			summary,
			link,
			selfFix,
			watching,
			updatedAt,
			history,
			thread,
			parent,
			desk,
			boardThread,
			mission,
			machines,
			stale,
			pinned,
			movedAt,
			startedAt,
			finishedAt,
			outcome,
			subagents,
		} = fields;
		const cardSubagents =
			subagents === undefined ? undefined : parseCardSubagents(subagents);
		if (cardSubagents === null) {
			return {
				error: `subagents must be at most ${maxCardSubagents} subagents, each with an id, description, type, state and time`,
			};
		}
		if (pinned !== undefined && typeof pinned !== "boolean") {
			return { error: "pinned must be true or false" };
		}
		for (const [name, value] of [
			["movedAt", movedAt],
			["startedAt", startedAt],
			["finishedAt", finishedAt],
		] as const) {
			if (
				value !== undefined &&
				(typeof value !== "number" || !Number.isFinite(value) || value < 0)
			) {
				return { error: `${name} must be a time in milliseconds` };
			}
		}
		if (
			outcome !== undefined &&
			!archiveOutcomes.includes(outcome as ArchiveOutcome)
		) {
			return { error: `outcome must be one of ${archiveOutcomes.join(", ")}` };
		}
		if (
			typeof title !== "string" ||
			title.trim() === "" ||
			title.length > maxButlerTitle
		) {
			return { error: `title must be 1 to ${maxButlerTitle} characters` };
		}
		if (!butlerCardStates.includes(state as ButlerCardState)) {
			return { error: `state must be one of ${butlerCardStates.join(", ")}` };
		}
		if (
			status !== undefined &&
			(typeof status !== "string" || status.length > maxButlerTitle)
		) {
			return {
				error: `status must be a string of at most ${maxButlerTitle}`,
			};
		}
		if (
			summary !== undefined &&
			(typeof summary !== "string" || summary.length > maxButlerSummary)
		) {
			return {
				error: `summary must be a string of at most ${maxButlerSummary}`,
			};
		}
		if (link !== undefined && !isWebLink(link)) {
			return {
				error: `link must be an https URL of at most ${maxButlerLink} characters`,
			};
		}
		if (!isLink(selfFix)) return { error: "selfFix must be a change id" };
		if (watching !== undefined && typeof watching !== "boolean") {
			return { error: "watching must be true or false" };
		}
		if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
			return { error: "updatedAt must be a time in milliseconds" };
		}
		if (history !== undefined && !isCardHistory(history)) {
			return {
				error: `history must be at most ${maxButlerHistory} states with a time, a card state and a status of at most ${maxButlerTitle}`,
			};
		}
		const cardThread =
			thread === undefined ? undefined : parseCardThread(thread);
		if (cardThread === null) {
			return {
				error:
					"thread must be a Discord thread's id, kind, https link and private flag",
			};
		}
		if (!isLink(parent)) return { error: "parent must be a card id" };
		if (
			desk !== undefined &&
			(typeof desk !== "string" || !deskPattern.test(desk))
		) {
			return { error: "desk must be a desk session's id" };
		}
		if (
			boardThread !== undefined &&
			(typeof boardThread !== "string" || !boardThreadPattern.test(boardThread))
		) {
			return { error: "boardThread must be a board comment thread's id" };
		}
		const cardMission =
			mission === undefined ? undefined : parseCardMission(mission);
		if (cardMission === null) {
			return {
				error: `mission must be a mission's id and what it covers, at most ${maxMissionCovers} characters`,
			};
		}
		const cardMachines =
			machines === undefined ? undefined : parseCardMachines(machines);
		if (cardMachines === null) {
			return {
				error: `machines must be at most ${maxCardMachines} host names`,
			};
		}
		return {
			...placed,
			kind: "butler-card",
			title,
			state: state as ButlerCardState,
			updatedAt,
			...(status === undefined ? {} : { status: status as string }),
			...(summary === undefined ? {} : { summary: summary as string }),
			...(link === undefined ? {} : { link }),
			...(selfFix === undefined ? {} : { selfFix }),
			...(watching === undefined ? {} : { watching }),
			...(cardThread === undefined ? {} : { thread: cardThread }),
			...(parent === undefined ? {} : { parent }),
			...(desk === undefined ? {} : { desk: desk as string }),
			...(boardThread === undefined
				? {}
				: { boardThread: boardThread as string }),
			...(cardMission === undefined ? {} : { mission: cardMission }),
			...(cardMachines === undefined ? {} : { machines: cardMachines }),
			...(stale === true ? { stale: true } : {}),
			...(pinned === true ? { pinned: true } : {}),
			...(movedAt === undefined ? {} : { movedAt: movedAt as number }),
			...(startedAt === undefined ? {} : { startedAt: startedAt as number }),
			...(finishedAt === undefined ? {} : { finishedAt: finishedAt as number }),
			...(outcome === undefined ? {} : { outcome: outcome as ArchiveOutcome }),
			...(cardSubagents === undefined ? {} : { subagents: cardSubagents }),
			...(history === undefined
				? {}
				: {
						history: history.map(({ at, state, status }) => ({
							at,
							state,
							...(status === undefined ? {} : { status }),
						})),
					}),
		};
	}
	if (fields.kind === "sticker") {
		const { sticker, rotation } = fields;
		if (typeof sticker !== "string" || !stickerIds.has(sticker)) {
			return { error: "sticker must be one of the board's stickers" };
		}
		if (rotation === undefined) return { ...placed, kind: "sticker", sticker };
		if (!isRotation(rotation)) {
			return { error: "rotation must be between -180 and 180" };
		}
		return { ...placed, kind: "sticker", sticker, rotation };
	}
	return { error: "kind must be note, sticker or butler-card" };
};

export const parseAnnotations = (value: unknown): Annotations => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const annotations: Annotations = {};
	for (const [id, raw] of Object.entries(value).slice(0, maxAnnotations)) {
		const parsed = parseAnnotation(id, raw);
		if (!("error" in parsed)) annotations[id] = parsed;
	}
	return annotations;
};

export const loadAnnotations = (file: string): Promise<Annotations> =>
	readState(file, parseAnnotations);

export const createAnnotationStore = ({
	file,
	initial,
	onChange,
}: AnnotationStoreOptions): AnnotationStore => {
	let annotations: Annotations = { ...initial };
	const stored = createStateFile<Annotations>(file);

	const commit = (next: Annotations) => {
		annotations = next;
		stored.write(annotations);
		onChange(annotations);
	};

	return {
		current: () => annotations,
		put(annotation) {
			const known = Object.hasOwn(annotations, annotation.id);
			const kind = annotations[annotation.id]?.kind;
			if (known && kind !== annotation.kind) {
				return {
					error: `${annotation.id} is a ${kind}: delete it to make a ${annotation.kind}`,
				};
			}
			if (!known && Object.keys(annotations).length >= maxAnnotations) {
				return {
					error: `The board holds at most ${maxAnnotations} notes and stickers`,
				};
			}
			commit({ ...annotations, [annotation.id]: annotation });
			return { ok: true };
		},
		remove(id) {
			if (!Object.hasOwn(annotations, id)) return false;
			const { [id]: _removed, ...rest } = annotations;
			commit(rest);
			return true;
		},
		saved: stored.saved,
	};
};
