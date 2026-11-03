import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { parseToolCall, type ToolCall } from "../agent/tools.ts";
import {
	type Annotation,
	type Board,
	type BoardContext,
	type BoardRect,
	type ButlerCard,
	type ButlerCardState,
	type ButlerPresence,
	butlerCardStates,
	maxButlerQueue,
	maxButlerSummary,
	maxButlerTitle,
	maxNoteText,
	type Note,
	type NoteColor,
	noteColors,
	type Point,
} from "../shared/types.ts";
import { snap } from "../web/grid.ts";
import { nodeKey } from "../web/layout.ts";
import {
	butlerBylineHeight,
	clearOf,
	noteSizeFor,
	topZ,
} from "../web/notes.ts";
import type { Rect } from "../web/placement.ts";
import { type AnnotationStore, parseAnnotation } from "./annotations.ts";
import type { Audit } from "./audit.ts";
import {
	arranged,
	type BoardToolDeps,
	type BoardTools,
	findSession,
	occupied,
	type ToolOutcome,
} from "./boardTools.ts";
import { type ButlerInbox, createButlerInbox } from "./butlerInbox.ts";
import type { CommentStore } from "./comments.ts";
import type { BoardSource } from "./http.ts";
import { fromLoopback } from "./loopback.ts";
import { createStateFile, readState } from "./stateFile.ts";

// Butler, Aaron's assistant bot on spike, reaches the board over ssh and
// curl on the Mac's loopback. He gets the board agent's own tools under
// his own name, plus his cards, notes, presence and the sessions he
// watches. Which of those need Aaron's say-so is decided on spike, by the
// rules of the command that calls this, as for his other tools.

export const butlerIdentity = "butler";
export const maxWatching = 100;
export const maxSelfFixes = 50;
export const selfFixPattern = /^[0-9]{8}-[0-9]{6}-[0-9]+$/;

const cardSize = { w: 312, h: 216 };
const gap = 48;
const noteColor: NoteColor = "blue";

/** Tools that act through a session: never Butler's own cards or notes. */
export const sessionTools = new Set<ToolCall["tool"]>([
	"ask_session",
	"send_prompt",
	"announce",
	"answer_prompt",
	"finish_session",
	"start_session",
]);

/**
 * What Aaron, or Butler on his word, did to a self-fix's card on the
 * board: closing it archives the fix's cloud session, marking it done
 * stops spike reporting it as needing him. Spike reads these back from
 * each self_fixes sync and acts on them; moving a card is never one.
 */
export type SelfFixAction = "archive" | "dismiss";
export const selfFixActions: readonly SelfFixAction[] = ["archive", "dismiss"];

export type Butler = {
	current(): ButlerPresence;
	tool(name: string, body: unknown): Promise<ToolOutcome>;
	/** Records an action Aaron took on a self-fix's card from the board. */
	selfFixAction(fixId: string, action: SelfFixAction): ToolOutcome;
	/** Aaron's messages to Butler, when the board keeps comments. */
	inbox: ButlerInbox | null;
	saved(): Promise<void>;
};

type ButlerState = {
	watching: string[];
	selfFixActions: Record<string, SelfFixAction>;
	watchedFixes: string[];
};

export type ButlerDeps = Pick<
	BoardToolDeps,
	"layout" | "annotations" | "regions"
> & {
	source: BoardSource;
	annotations: AnnotationStore;
	tools: BoardTools;
	audit: Audit;
	file: string;
	initial: string[];
	initialActions?: Record<string, SelfFixAction>;
	initialWatchedFixes?: string[];
	onChange: (presence: ButlerPresence) => void;
	/** Where Aaron's messages to Butler are kept, in their comment threads. */
	comments?: CommentStore;
	newId?: () => string;
	now?: () => number;
};

export const parseWatching = (value: unknown): string[] => {
	const list =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as { watching?: unknown }).watching
			: null;
	if (!Array.isArray(list)) return [];
	return list
		.filter((id): id is string => typeof id === "string" && id.length <= 128)
		.slice(0, maxWatching);
};

export const loadWatching = (file: string): Promise<string[]> =>
	readState(file, parseWatching);

const parseFixIds = (value: unknown): string[] =>
	Array.isArray(value)
		? value
				.filter(
					(id): id is string =>
						typeof id === "string" && selfFixPattern.test(id),
				)
				.slice(0, maxSelfFixes)
		: [];

export const parseSelfFixActions = (
	value: unknown,
): Record<string, SelfFixAction> => {
	const raw =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as { selfFixActions?: unknown }).selfFixActions
			: null;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const actions: Record<string, SelfFixAction> = {};
	for (const [id, action] of Object.entries(raw).slice(0, maxSelfFixes)) {
		if (
			selfFixPattern.test(id) &&
			selfFixActions.includes(action as SelfFixAction)
		) {
			actions[id] = action as SelfFixAction;
		}
	}
	return actions;
};

/** Everything butler.json keeps, for createButler's initial state. */
export const loadButlerState = (file: string) =>
	readState(file, (value) => ({
		initial: parseWatching(value),
		initialActions: parseSelfFixActions(value),
		initialWatchedFixes: parseFixIds(
			typeof value === "object" && value !== null
				? (value as { watchedFixes?: unknown }).watchedFixes
				: null,
		),
	}));

/** Butler's calls come only from a process on this Mac, never a page. */
export const butlerAllowed = (req: IncomingMessage): boolean =>
	fromLoopback(req) && req.headers.origin === undefined;

const done = (text: string): ToolOutcome => ({ ok: true, text });
const refused = (error: string): Refusal => ({ ok: false, error });

type Fields = Record<string, unknown>;

const text = (
	fields: Fields,
	key: string,
	max: number,
	required = false,
): string | undefined | Refusal => {
	const value = fields[key];
	if (value === undefined || value === null) {
		return required ? refused(`${key} is required`) : undefined;
	}
	if (typeof value !== "string" || value.length > max) {
		return refused(`${key} must be a string of at most ${max} characters`);
	}
	return value;
};

type Refusal = { ok: false; error: string };

const isOutcome = (value: unknown): value is Refusal =>
	typeof value === "object" && value !== null && "ok" in value;

const only = (fields: Fields, allowed: string[]): ToolOutcome | null => {
	const unknown = Object.keys(fields).find((key) => !allowed.includes(key));
	return unknown ? refused(`Unknown argument ${unknown}`) : null;
};

const number = (fields: Fields, key: string): number | undefined => {
	const value = fields[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
};

/** Folds a self-fix's free-text state, from `self-fix list`, into a card state. */
export const selfFixState = (state: string): ButlerCardState => {
	const s = state.toLowerCase();
	if (s.startsWith("waiting on input")) return "needs-you";
	if (s.startsWith("finished with an error") || s.startsWith("failed"))
		return "failed";
	if (
		s.startsWith("finished") ||
		s.startsWith("archive") ||
		s.startsWith("dismissed")
	)
		return "done";
	if (s === "running" || s.startsWith("still starting")) return "working";
	return "idle";
};

export const selfFixCardId = (id: string) => `self-fix-${id}`;

/** A self-fix id stands for its card wherever a tool takes a card id. */
const cardRef = (ref: string) =>
	selfFixPattern.test(ref) ? selfFixCardId(ref) : ref;

const dismissedStatus = (status: string): string =>
	status.startsWith("dismissed")
		? status
		: `dismissed on the board; ${status}`.slice(0, maxButlerTitle);

const sameCard = (a: ButlerCard, b: ButlerCard): boolean =>
	a.title === b.title &&
	a.state === b.state &&
	a.status === b.status &&
	a.summary === b.summary &&
	a.link === b.link &&
	a.watching === b.watching;

export const createButler = (deps: ButlerDeps): Butler => {
	const newId = deps.newId ?? randomUUID;
	const now = deps.now ?? Date.now;
	const file = createStateFile<ButlerState>(deps.file);
	let watching = [...deps.initial];
	let actions: Record<string, SelfFixAction> = {
		...(deps.initialActions ?? {}),
	};
	let watchedFixes = new Set(deps.initialWatchedFixes ?? []);
	const persist = () =>
		file.write({
			watching,
			selfFixActions: actions,
			watchedFixes: [...watchedFixes],
		});
	let presence: ButlerPresence["presence"] = null;

	let inbox: ButlerInbox | null = null;
	const current = (): ButlerPresence => {
		const relay = inbox?.relay();
		return { presence, watching, ...(relay ? { relay } : {}) };
	};
	const changed = () => deps.onChange(current());

	const board = (): Board => deps.source.board();
	const taken = () => occupied(board(), deps);
	const annotation = (id: string) =>
		deps.annotations.current()[id] ?? deps.annotations.current()[cardRef(id)];

	/** A session's id or short id, or the id of a card or note. */
	const resolve = (
		ref: string,
	): { id: string; rect: Rect; label: string } | null => {
		const session = findSession(board(), ref);
		if (session) {
			const node = arranged(board(), deps).nodes.get(
				nodeKey({ kind: "session", id: session.id }),
			);
			return node ? { id: session.id, rect: node, label: session.name } : null;
		}
		const found = annotation(ref);
		if (!found) return null;
		const label =
			found.kind === "butler-card"
				? found.title
				: found.kind === "note"
					? "a note"
					: "a sticker";
		return { id: found.id, rect: found, label };
	};

	const lookAt = (id: string, label = "Butler") => {
		presence = { target: id, label, at: now() };
		changed();
	};

	const put = (next: Annotation): ToolOutcome | null => {
		const parsed = parseAnnotation(next.id, next);
		if ("error" in parsed) return refused(parsed.error);
		const stored = deps.annotations.put(parsed);
		return "error" in stored ? refused(stored.error) : null;
	};

	/** Somewhere clear, right of everything on the board, for a new card. */
	const freshSpot = () => {
		const bounds = arranged(board(), deps).bounds;
		const empty = !Number.isFinite(bounds.width) || bounds.width <= 0;
		return {
			x: snap(empty ? 0 : bounds.x + bounds.width + gap),
			y: snap(empty ? 0 : bounds.y),
		};
	};

	const placeCard = (card: ButlerCard, fresh: boolean): ButlerCard =>
		fresh ? clearOf(card, taken()) : card;

	/**
	 * A change's id, once called a self-fix, given as `change` or, its old
	 * name, `selfFix`, which spike and Butler still send.
	 */
	const changeRef = (fields: Fields): string | undefined | Refusal =>
		text(fields, fields.change !== undefined ? "change" : "selfFix", 64);

	const putCard = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, [
			"id",
			"change",
			"selfFix",
			"title",
			"state",
			"status",
			"summary",
			"link",
			"watching",
			"x",
			"y",
			"w",
			"h",
		]);
		if (unknown) return unknown;
		const fixRef = changeRef(fields);
		if (isOutcome(fixRef)) return fixRef;
		if (fixRef !== undefined && !selfFixPattern.test(fixRef)) {
			return refused("change must be a change id");
		}
		const given = text(fields, "id", 64);
		if (isOutcome(given)) return given;
		const id =
			fixRef !== undefined
				? selfFixCardId(fixRef)
				: given === undefined
					? undefined
					: cardRef(given);
		const title = text(fields, "title", maxButlerTitle);
		const status = text(fields, "status", maxButlerTitle);
		const summary = text(fields, "summary", maxButlerSummary);
		const link = text(fields, "link", 500);
		for (const value of [id, title, status, summary, link]) {
			if (isOutcome(value)) return value;
		}
		const state = fields.state;
		if (
			state !== undefined &&
			!butlerCardStates.includes(state as ButlerCardState)
		) {
			return refused(`state must be one of ${butlerCardStates.join(", ")}`);
		}
		const existing = id ? annotation(id as string) : undefined;
		if (id && existing && existing.kind !== "butler-card") {
			return refused(`${id} is not one of Butler's cards`);
		}
		if (id && !existing && findSession(board(), id as string)) {
			return refused(
				`${id} is a session: move it with arrange and close it with finish_session`,
			);
		}
		if (existing?.kind === "butler-card" && existing.selfFix) {
			const synced = [
				"title",
				"state",
				"status",
				"summary",
				"link",
				"watching",
			];
			const kept = synced.find((key) => fields[key] !== undefined);
			if (kept) {
				return refused(
					`Spike keeps a change card's ${synced.join(", ")} in step; move it here, note it with note, watch it with watch, or close it with close_card, which archives the change`,
				);
			}
		} else if (id?.startsWith("self-fix-")) {
			return refused(
				`No card for change ${id.slice("self-fix-".length)} yet; spike adds every change's card within a few minutes, so never make one`,
			);
		}
		if (!existing && !title) return refused("A new card needs a title");
		const spot = freshSpot();
		const base: ButlerCard = (existing as ButlerCard | undefined) ?? {
			id: (id as string | undefined) ?? `butler-${newId()}`,
			kind: "butler-card",
			title: "",
			state: "idle",
			...spot,
			...cardSize,
			z: topZ(deps.annotations.current()) + 1,
			updatedAt: now(),
		};
		const x = number(fields, "x");
		const y = number(fields, "y");
		const w = number(fields, "w");
		const h = number(fields, "h");
		const card: ButlerCard = {
			...base,
			...(title === undefined ? {} : { title: title as string }),
			...(state === undefined ? {} : { state: state as ButlerCardState }),
			...(status === undefined ? {} : { status: status as string }),
			...(summary === undefined ? {} : { summary: summary as string }),
			...(link === undefined ? {} : { link: link as string }),
			...(typeof fields.watching === "boolean"
				? { watching: fields.watching }
				: {}),
			...(x === undefined ? {} : { x: snap(x) }),
			...(y === undefined ? {} : { y: snap(y) }),
			...(w === undefined ? {} : { w: snap(w) }),
			...(h === undefined ? {} : { h: snap(h) }),
			updatedAt: now(),
		};
		const placed = placeCard(card, !existing && x === undefined);
		const failed = put(placed);
		if (failed) return failed;
		lookAt(placed.id);
		return done(
			`${existing ? "Updated" : "Created"} card '${placed.title}' (id ${placed.id}) at ${placed.x},${placed.y}`,
		);
	};

	const closeCard = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["id", "change", "selfFix"]);
		if (unknown) return unknown;
		const fixRef = changeRef(fields);
		if (isOutcome(fixRef)) return fixRef;
		const id = fixRef === undefined ? text(fields, "id", 64, true) : fixRef;
		if (isOutcome(id)) return id;
		const card = annotation(id as string);
		if (card?.kind !== "butler-card") {
			return findSession(board(), id as string)
				? refused(`${id} is a session: close it with finish_session`)
				: refused(`No card ${id} of Butler's on the board`);
		}
		deps.annotations.remove(card.id);
		const notes = Object.values(deps.annotations.current()).filter(
			(a) =>
				a.kind === "note" && a.author === "butler" && a.session === card.id,
		);
		for (const note of notes) deps.annotations.remove(note.id);
		if (presence?.target === card.id) {
			presence = null;
			changed();
		}
		const archiving = card.selfFix ? record(card.selfFix, "archive") : "";
		return done(
			`Closed card '${card.title}'${notes.length ? ` and its ${notes.length} note${notes.length === 1 ? "" : "s"}` : ""}${archiving}`,
		);
	};

	const note = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["id", "target", "text", "color"]);
		if (unknown) return unknown;
		const id = text(fields, "id", 64);
		const target = text(fields, "target", 128);
		const body = text(fields, "text", maxNoteText, true);
		for (const value of [id, target, body]) {
			if (isOutcome(value)) return value;
		}
		const color = fields.color ?? noteColor;
		if (!noteColors.includes(color as NoteColor)) {
			return refused(`color must be one of ${noteColors.join(", ")}`);
		}
		const existing = id ? annotation(id as string) : undefined;
		if (id && (existing?.kind !== "note" || existing.author !== "butler")) {
			return refused(`No note ${id} of Butler's`);
		}
		const at = target ? resolve(target as string) : null;
		if (target && !at) return refused(`No card or session ${target}`);
		const fitted = noteSizeFor(body as string);
		const size = { w: fitted.w, h: fitted.h + butlerBylineHeight };
		const beside = at
			? { x: snap(at.rect.x + at.rect.w + 24), y: snap(at.rect.y) }
			: freshSpot();
		const draft: Note = {
			...(existing ?? {
				id: `butler-note-${newId()}`,
				...beside,
				...size,
				z: topZ(deps.annotations.current()) + 1,
			}),
			kind: "note",
			text: body as string,
			color: color as NoteColor,
			author: "butler",
			...(at ? { session: at.id } : {}),
		} as Note;
		const placed = existing ? draft : clearOf(draft, taken());
		const failed = put(placed);
		if (failed) return failed;
		if (at) lookAt(at.id);
		return done(
			`${existing ? "Updated" : "Added"} note (id ${placed.id})${at ? ` on ${at.label}` : ""} at ${placed.x},${placed.y}`,
		);
	};

	const watch = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["target", "watching"]);
		if (unknown) return unknown;
		const target = text(fields, "target", 128, true);
		if (isOutcome(target)) return target;
		const on = fields.watching !== false;
		const card = annotation(target as string);
		if (card?.kind === "butler-card") {
			if (card.selfFix) {
				if (on) watchedFixes.add(card.selfFix);
				else watchedFixes.delete(card.selfFix);
				persist();
			}
			const failed = put({ ...card, watching: on, updatedAt: now() });
			return (
				failed ??
				done(`${on ? "Watching" : "Stopped watching"} '${card.title}'`)
			);
		}
		const session = findSession(board(), target as string);
		if (!session) return refused(`No card or session ${target}`);
		const others = watching.filter((id) => id !== session.id);
		if (on && others.length >= maxWatching) {
			return refused(`Butler already watches ${maxWatching} sessions`);
		}
		watching = on ? [...others, session.id] : others;
		persist();
		changed();
		return done(`${on ? "Watching" : "Stopped watching"} ${session.name}`);
	};

	const look = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["target", "label"]);
		if (unknown) return unknown;
		const target = text(fields, "target", 128);
		const label = text(fields, "label", 40);
		for (const value of [target, label]) if (isOutcome(value)) return value;
		if (!target) {
			presence = null;
			changed();
			return done("Butler stepped away from the board");
		}
		const at = resolve(target as string);
		if (!at) return refused(`No card or session ${target}`);
		lookAt(at.id, (label as string | undefined) || "Butler");
		return done(`Butler is at ${at.label}`);
	};

	/** Keeps a board action for spike to read back; the latest one wins. */
	const record = (fixId: string, action: SelfFixAction): string => {
		actions = { ...actions, [fixId]: action };
		persist();
		deps.audit({
			action: "butler",
			tool: "self_fix_action",
			result: `${action} ${fixId}`,
		});
		return action === "archive"
			? "; spike archives the change's cloud session within a few minutes"
			: "; spike stops reporting it as needing Aaron within a few minutes";
	};

	const selfFixAction = (fixId: string, action: SelfFixAction): ToolOutcome => {
		if (!selfFixPattern.test(fixId)) return refused("Not a change id");
		if (!selfFixActions.includes(action)) {
			return refused(`action must be one of ${selfFixActions.join(", ")}`);
		}
		const card = annotation(selfFixCardId(fixId));
		if (card?.kind !== "butler-card" || card.selfFix !== fixId) {
			return refused(`No card for change ${fixId}`);
		}
		if (action === "archive") return closeCard({ selfFix: fixId });
		const failed = put({
			...card,
			state: "done",
			status: dismissedStatus(card.status ?? ""),
			watching: false,
			updatedAt: now(),
		});
		if (failed) return failed;
		watchedFixes.delete(fixId);
		return done(`Marked '${card.title}' done${record(fixId, "dismiss")}`);
	};

	/** Mirrors `self-fix list`: one card each, kept where it was put. */
	const selfFixes = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["fixes"]);
		if (unknown) return unknown;
		const fixes = fields.fixes;
		if (!Array.isArray(fixes) || fixes.length > maxSelfFixes) {
			return refused(`fixes must be a list of at most ${maxSelfFixes}`);
		}
		const seen = new Set<string>();
		const fixIds = new Set<string>();
		let changedCards = 0;
		for (const raw of fixes) {
			if (typeof raw !== "object" || raw === null) {
				return refused("each change must be an object");
			}
			const fix = raw as Fields;
			const fixId = fix.id;
			if (typeof fixId !== "string" || !selfFixPattern.test(fixId)) {
				return refused("each change needs its change id");
			}
			const status = text(fix, "state", maxButlerTitle, true);
			const title = text(fix, "title", maxButlerTitle);
			const summary = text(fix, "summary", maxButlerSummary);
			const link = text(fix, "link", 500);
			for (const value of [status, title, summary, link]) {
				if (isOutcome(value)) return refused(`${fixId}: ${value.error}`);
			}
			const id = selfFixCardId(fixId);
			fixIds.add(fixId);
			// A card Aaron closed stays closed while spike archives its fix.
			if (actions[fixId] === "archive") continue;
			const dismissed = actions[fixId] === "dismiss";
			seen.add(id);
			const existing = annotation(id);
			const base: ButlerCard =
				existing?.kind === "butler-card"
					? existing
					: {
							id,
							kind: "butler-card",
							title: "",
							state: "idle",
							...freshSpot(),
							...cardSize,
							z: topZ(deps.annotations.current()) + 1,
							updatedAt: now(),
						};
			const card: ButlerCard = {
				id: base.id,
				kind: "butler-card",
				x: base.x,
				y: base.y,
				w: base.w,
				h: base.h,
				z: base.z,
				updatedAt: base.updatedAt,
				title: (title as string | undefined)?.trim() || `Self-fix ${fixId}`,
				state: dismissed ? "done" : selfFixState(status as string),
				status: dismissed
					? dismissedStatus(status as string)
					: (status as string),
				selfFix: fixId,
				...(summary ? { summary: summary as string } : {}),
				...(link ? { link: link as string } : {}),
				...(!dismissed && (fix.watching === true || watchedFixes.has(fixId))
					? { watching: true }
					: {}),
			};
			if (existing?.kind === "butler-card" && sameCard(existing, card)) {
				continue;
			}
			const placed = placeCard(
				{ ...card, updatedAt: now() },
				existing === undefined,
			);
			const failed = put(placed);
			if (failed && !failed.ok) return refused(`${fixId}: ${failed.error}`);
			changedCards += 1;
		}
		const gone = Object.values(deps.annotations.current()).filter(
			(a) => a.kind === "butler-card" && a.selfFix && !seen.has(a.id),
		);
		for (const card of gone) deps.annotations.remove(card.id);
		// Forget what was done to fixes spike no longer lists, a week on.
		const keptActions = Object.fromEntries(
			Object.entries(actions).filter(([id]) => fixIds.has(id)),
		);
		const keptWatches = new Set(
			[...watchedFixes].filter((id) => fixIds.has(id)),
		);
		if (
			Object.keys(keptActions).length !== Object.keys(actions).length ||
			keptWatches.size !== watchedFixes.size
		) {
			actions = keptActions;
			watchedFixes = keptWatches;
			persist();
		}
		const requested = (action: SelfFixAction) =>
			Object.entries(actions)
				.filter(([, a]) => a === action)
				.map(([id]) => id)
				.sort();
		return done(
			`${fixes.length} change card${fixes.length === 1 ? "" : "s"}: ${changedCards} updated, ${gone.length} removed\nBoard actions: ${JSON.stringify({ archive: requested("archive"), dismiss: requested("dismiss") })}`,
		);
	};

	/** What sits under a point on the board, for a message sent from there. */
	const contextAt = (point: Point, viewport?: BoardRect): BoardContext => {
		const context: BoardContext = viewport ? { viewport } : {};
		const inside = (r: Rect) =>
			point.x >= r.x &&
			point.x <= r.x + r.w &&
			point.y >= r.y &&
			point.y <= r.y + r.h;
		const shown = board();
		const nodes = arranged(shown, deps).nodes;
		const session = shown.sessions.find((s) => {
			const node = nodes.get(nodeKey({ kind: "session", id: s.id }));
			return node ? inside(node) : false;
		});
		if (session) {
			context.card = {
				id: session.id,
				kind: "session",
				name: session.name,
				short: session.id.slice(0, 8),
				state: session.activity,
				cwd: session.cwd,
			};
		} else {
			const card = Object.values(deps.annotations.current())
				.filter((a): a is ButlerCard => a.kind === "butler-card")
				.sort((a, b) => b.z - a.z)
				.find(inside);
			if (card) {
				context.card = {
					id: card.selfFix ?? card.id,
					kind: "butler-card",
					name: card.title,
					state: card.state,
				};
			}
		}
		const region = deps.regions
			.current()
			.find((r) => inside(r) || (session && session.cwd === r.cwd));
		if (region) {
			context.region = {
				id: region.id,
				name: region.name ?? region.cwd.split("/").pop() ?? region.cwd,
				cwd: region.cwd,
			};
		}
		return context;
	};

	if (deps.comments) {
		inbox = createButlerInbox({
			store: deps.comments,
			contextAt,
			onRelay: changed,
			newId: deps.newId,
			now,
		});
	}

	const boardInbox = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, []);
		if (unknown) return unknown;
		if (!inbox) return refused("This board keeps no messages");
		return done(JSON.stringify({ messages: inbox.take() }));
	};

	const boardAck = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["ids"]);
		if (unknown) return unknown;
		if (!inbox) return refused("This board keeps no messages");
		const ids = fields.ids;
		if (
			!Array.isArray(ids) ||
			ids.length > maxButlerQueue ||
			!ids.every((id) => typeof id === "string" && id.length <= 64)
		) {
			return refused(`ids must be a list of at most ${maxButlerQueue} ids`);
		}
		return done(`Took ${inbox.ack(ids as string[])}`);
	};

	const boardReply = (fields: Fields): ToolOutcome => {
		const unknown = only(fields, ["thread", "message", "text", "ok"]);
		if (unknown) return unknown;
		if (!inbox || !deps.comments) {
			return refused("This board keeps no messages");
		}
		const threadId = text(fields, "thread", 64, true);
		const messageId = text(fields, "message", 64, true);
		const body = text(fields, "text", maxNoteText, true);
		for (const value of [threadId, messageId, body]) {
			if (isOutcome(value)) return value;
		}
		const ok = fields.ok !== false;
		const thread = inbox.reply(
			threadId as string,
			messageId as string,
			body as string,
			ok,
		);
		// A thread Aaron deleted on the board has nothing to answer; that's fine.
		if (!thread) return done("No such thread on the board any more");
		const card = thread.context?.card;
		if (!ok || !card) return done("Shown on the board");
		const kept = thread.replyNote
			? deps.annotations.current()[thread.replyNote]
			: undefined;
		const pinned = note({
			...(kept?.kind === "note" ? { id: kept.id } : {}),
			target: card.id,
			text: body as string,
		});
		const id = pinned.ok ? pinned.text.match(/\(id ([^)]+)\)/)?.[1] : null;
		if (id && id !== thread.replyNote) {
			deps.comments.update(thread.id, (t) => ({ ...t, replyNote: id }));
		}
		return done(
			pinned.ok
				? `Shown on the board and noted on ${card.name}`
				: `Shown on the board; could not note it on the card: ${pinned.error}`,
		);
	};

	const own: Record<string, (fields: Fields) => ToolOutcome> = {
		board_inbox: boardInbox,
		board_ack: boardAck,
		board_reply: boardReply,
		put_card: putCard,
		close_card: closeCard,
		note,
		watch,
		look,
		// The changes' sync, by its new name and its old one, which spike still sends.
		changes: selfFixes,
		self_fixes: selfFixes,
	};

	const tool = async (name: string, body: unknown): Promise<ToolOutcome> => {
		const fields = body ?? {};
		if (typeof fields !== "object" || Array.isArray(fields)) {
			return refused("Arguments must be an object");
		}
		const handler = own[name];
		if (handler) {
			const outcome = handler(fields as Fields);
			if (name !== "look" && name !== "board_inbox") {
				deps.audit({
					action: "butler",
					tool: name,
					result: outcome.ok
						? (outcome.text.split("\n")[0] ?? "")
						: `error: ${outcome.error}`,
				});
			}
			return outcome;
		}
		if (name === "put_note") {
			return refused("Butler's notes go through note, which signs them");
		}
		const call = parseToolCall(name, fields);
		if ("error" in call) return refused(call.error);
		if ("session" in call) {
			const session = findSession(board(), call.session);
			if (session) lookAt(session.id);
		}
		const outcome = await deps.tools(butlerIdentity, call);
		if (call.tool !== "board_snapshot") return outcome;
		if (!outcome.ok) return outcome;
		return done(`${outcome.text}\nButler watches: ${JSON.stringify(watching)}`);
	};

	return {
		current,
		tool,
		selfFixAction,
		inbox,
		saved: () => file.saved(),
	};
};
