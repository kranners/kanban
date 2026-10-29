import { randomUUID } from "node:crypto";
import type { Placed, ToolCall } from "../agent/tools.ts";
import { defaultRegionColour } from "../shared/colours.ts";
import type { PromptReply } from "../shared/conversation.ts";
import type {
	Annotation,
	Board,
	LayoutUpdate,
	Placement,
	Region,
	Session,
} from "../shared/types.ts";
import { snap } from "../web/grid.ts";
import { groupsOf } from "../web/groups.ts";
import { nodeKey } from "../web/layout.ts";
import { clearOf, matchingStickers, noteSizeFor, topZ } from "../web/notes.ts";
import {
	arrange,
	clearSpot,
	type Rect,
	seedsOf,
	sessionSize,
	subagentSize,
} from "../web/placement.ts";
import {
	clearOfProjects,
	framesBesideNew,
	regionGroups,
} from "../web/regions.ts";
import { stickerManifest } from "../web/stickers/manifest.ts";
import { summariesOf } from "../web/summaries.ts";
import { type AnnotationStore, parseAnnotation } from "./annotations.ts";
import type { Audit } from "./audit.ts";
import type { CmuxResult } from "./cmux.ts";
import type { ColourStore } from "./colours.ts";
import type { CommentStore } from "./comments.ts";
import type { ExitRunner, SessionAsker } from "./exit.ts";
import type { BoardSource } from "./http.ts";
import { truncate } from "./ingest/json.ts";
import { boardKeys, type LayoutStore } from "./layout.ts";
import type { PromptSender } from "./prompts.ts";
import {
	parseRegionDraft,
	parseRegionPatch,
	type RegionStore,
} from "./regions.ts";
import { type SessionLauncher, validateNewSession } from "./sessions.ts";

export type ToolOutcome =
	| { ok: true; text: string }
	| { ok: false; error: string };

export type BoardTools = (
	threadId: string,
	call: ToolCall,
) => Promise<ToolOutcome>;

export type BoardToolDeps = {
	source: BoardSource;
	layout: LayoutStore;
	annotations: AnnotationStore;
	colours: ColourStore;
	regions: RegionStore;
	comments: CommentStore;
	launch: SessionLauncher;
	exit: ExitRunner;
	ask: SessionAsker;
	prompt: PromptSender;
	answer: PromptAnswerer;
	audit: Audit;
	newId?: () => string;
};

export type PromptAnswerer = (
	session: Session,
	reply: PromptReply | null,
) => Promise<CmuxResult<string>>;

export const agentIdentity = "board-agent";

const readOnly = new Set<ToolCall["tool"]>([
	"board_snapshot",
	"read_transcript",
	"find_stickers",
]);
const noteTextShown = 400;
const transcriptTextShown = 600;
const transcriptBudget = 24_000;
const subagentsShown = 100;
const defaultStickerSize = 96;

const done = (text: string): ToolOutcome => ({ ok: true, text });
const refused = (error: string): ToolOutcome => ({ ok: false, error });

const plural = (count: number, one: string, many = `${one}s`) =>
	`${count} ${count === 1 ? one : many}`;

export const findSession = (board: Board, ref: string): Session | null =>
	board.sessions.find((s) => s.id === ref) ??
	board.sessions.find((s) => s.short === ref) ??
	null;

const rect = (item: { x: number; y: number; w: number; h: number }) => ({
	x: Math.round(item.x),
	y: Math.round(item.y),
	w: Math.round(item.w),
	h: Math.round(item.h),
});

const arranged = (
	board: Board,
	deps: Pick<BoardToolDeps, "layout" | "annotations" | "regions">,
) =>
	arrange(
		board,
		deps.layout.current(),
		seedsOf(board),
		new Map(),
		Object.values(deps.annotations.current()),
		deps.regions.current(),
	);

const occupied = (
	board: Board,
	deps: Pick<BoardToolDeps, "layout" | "annotations" | "regions">,
): Rect[] => [
	...arranged(board, deps).nodes.values(),
	...Object.values(deps.annotations.current()),
];

export const projectsOf = (
	board: Board,
	deps: Pick<BoardToolDeps, "layout" | "annotations" | "regions">,
	placed = arranged(board, deps),
) =>
	regionGroups(
		deps.regions.current(),
		groupsOf(board.sessions, placed.nodes),
		board.sessions,
		placed.nodes,
	);

export const summariesOfBoard = (
	board: Board,
	deps: Pick<BoardToolDeps, "layout" | "annotations" | "regions">,
) => {
	const placed = arranged(board, deps);
	return summariesOf(
		projectsOf(board, deps, placed),
		board.sessions,
		placed.nodes,
	);
};

export const snapshot = (
	board: Board,
	deps: Pick<BoardToolDeps, "layout" | "annotations" | "colours" | "regions">,
	anchor: { x: number; y: number } | null,
) => {
	const saved = deps.layout.current();
	const placed = arranged(board, deps);
	const groups = projectsOf(board, deps, placed);
	const regionOf = new Map<string, string>();
	for (const group of groups) {
		if (!group.region) continue;
		for (const key of group.members) regionOf.set(key, group.region.id);
	}
	const colours = deps.colours.current();
	const annotations = Object.values(deps.annotations.current());
	return {
		gridSize: 24,
		cardSizes: { session: sessionSize, subagent: subagentSize },
		thisComment: anchor,
		sessions: board.sessions.map((session) => {
			const key = nodeKey({ kind: "session", id: session.id });
			const node = placed.nodes.get(key);
			return {
				id: session.id,
				short: session.short,
				name: session.name,
				cwd: session.cwd,
				kind: session.kind,
				inCmux: session.cmux,
				activity: session.activity,
				doing: session.doing,
				needs: session.needs,
				startedAt: new Date(session.startedAt).toISOString(),
				updatedAt: new Date(session.updatedAt).toISOString(),
				card: node ? rect(node) : null,
				pinned: saved[key]?.pinned === true,
				region: regionOf.get(key) ?? null,
				subagents: board.subagentCounts[session.id] ?? null,
			};
		}),
		subagents: board.subagents.slice(0, subagentsShown).map((agent) => {
			const node = placed.nodes.get(
				nodeKey({ kind: "subagent", id: agent.id }),
			);
			return {
				id: agent.id,
				session: agent.sessionId,
				type: agent.type,
				description: agent.description,
				state: agent.live ? "working" : agent.done ? "done" : "idle",
				card: node ? rect(node) : null,
			};
		}),
		regions: groups.flatMap((group) =>
			group.region
				? [
						{
							id: group.region.id,
							name: group.region.name,
							cwd: group.region.cwd,
							colour:
								colours[group.region.cwd] ??
								defaultRegionColour(group.region.cwd),
							drawn: rect(group.region),
							frame: rect(group.frame),
						},
					]
				: [],
		),
		notes: annotations.flatMap((a) =>
			a.kind === "note"
				? [
						{
							id: a.id,
							...rect(a),
							color: a.color,
							session: a.session,
							text: truncate(a.text, noteTextShown),
						},
					]
				: [],
		),
		stickers: annotations.flatMap((a) =>
			a.kind === "sticker"
				? [{ id: a.id, sticker: a.sticker, ...rect(a) }]
				: [],
		),
		bounds: {
			x: Math.round(placed.bounds.x),
			y: Math.round(placed.bounds.y),
			w: Math.round(placed.bounds.width),
			h: Math.round(placed.bounds.height),
		},
	};
};

const cardKey = (board: Board, id: string): string | null => {
	const session = findSession(board, id);
	if (session) return nodeKey({ kind: "session", id: session.id });
	return board.subagents.some((agent) => agent.id === id)
		? nodeKey({ kind: "subagent", id })
		: null;
};

const cardPlacement = (
	key: string,
	item: Placed,
	saved: Placement | undefined,
): Placement => {
	const point = { x: snap(item.x), y: snap(item.y), pinned: true as const };
	if (!key.startsWith("session:")) return point;
	const w = item.w ?? saved?.w;
	const h = item.h ?? saved?.h;
	if (w === undefined && h === undefined) return point;
	return {
		...point,
		w: snap(w ?? sessionSize.w),
		h: snap(h ?? sessionSize.h),
	};
};

export const createBoardTools = (deps: BoardToolDeps): BoardTools => {
	const newId = deps.newId ?? randomUUID;

	const sessionFor = (ref: string): Session | ToolOutcome =>
		findSession(deps.source.board(), ref) ??
		refused(`No session ${ref} on the board; use board_snapshot for ids`);

	const store = (
		annotation: unknown,
		id: string,
		isNew: boolean,
	): ToolOutcome | Annotation => {
		const parsed = parseAnnotation(id, annotation);
		if ("error" in parsed) return refused(parsed.error);
		const placed = isNew
			? clearOf(parsed, occupied(deps.source.board(), deps))
			: parsed;
		const put = deps.annotations.put(placed);
		return "error" in put ? refused(put.error) : placed;
	};

	const handlers: {
		[K in ToolCall["tool"]]: (
			call: Extract<ToolCall, { tool: K }>,
			threadId: string,
		) => Promise<ToolOutcome> | ToolOutcome;
	} = {
		board_snapshot: (_call, threadId) => {
			const thread = deps.comments.get(threadId);
			const board = deps.source.board();
			const view = snapshot(
				board,
				deps,
				thread ? { x: thread.x, y: thread.y } : null,
			);
			return done(
				`Board: ${plural(view.sessions.length, "session")}, ${plural(view.regions.length, "region")}, ${plural(view.notes.length, "note")}, ${plural(view.stickers.length, "sticker")}\n${JSON.stringify(view)}`,
			);
		},
		read_transcript: async ({ session: ref, limit }) => {
			const session = sessionFor(ref);
			if ("ok" in session) return session;
			const entries = await deps.source.transcript(session.id, limit);
			let budget = transcriptBudget;
			const lines = entries
				.toReversed()
				.flatMap((entry) => {
					const line = `[${new Date(entry.at).toISOString()}] ${entry.role}: ${truncate(entry.text, transcriptTextShown)}`;
					budget -= line.length;
					return budget < 0 ? [] : [line];
				})
				.toReversed();
			return done(
				`Read ${plural(lines.length, "entry", "entries")} from ${session.name}\n${lines.join("\n")}`,
			);
		},
		ask_session: async ({ session: ref, question }) => {
			const session = sessionFor(ref);
			if ("ok" in session) return session;
			const answer = await deps.ask(session, question);
			return answer.ok
				? done(`Asked ${session.name}\n${answer.answer}`)
				: refused(answer.error);
		},
		send_prompt: async ({ session: ref, text }) => {
			const session = sessionFor(ref);
			if ("ok" in session) return session;
			const sent = await deps.prompt(session, text);
			return sent.ok
				? done(`Sent a prompt to ${session.name} through ${sent.via}`)
				: refused(sent.error);
		},
		answer_prompt: async ({ session: ref, reply }) => {
			const session = sessionFor(ref);
			if ("ok" in session) return session;
			const result = await deps.answer(session, reply);
			return result.ok ? done(result.value) : refused(result.error);
		},
		finish_session: async ({ session: ref }) => {
			const session = sessionFor(ref);
			if ("ok" in session) return session;
			const exiting = deps.exit(session, false, agentIdentity);
			if (!exiting) return refused(`${session.name} is already exiting`);
			const result = await exiting;
			if (!result.ok) return refused(result.error);
			return result.exited
				? done(`Finished ${session.name}`)
				: done(`${session.name} is not ready to finish: ${result.reason}`);
		},
		start_session: async ({ cwd, prompt, name, x, y }) => {
			const request = await validateNewSession({
				cwd,
				prompt,
				name,
				...(x !== undefined && y !== undefined
					? { at: { x: snap(x), y: snap(y) } }
					: {}),
			});
			if ("error" in request) return refused(request.error);
			const settle =
				request.at &&
				deps.layout.expect(
					request.cwd,
					clearSpot(
						{ ...request.at, ...sessionSize },
						occupied(deps.source.board(), deps),
					),
				);
			const result = await deps.launch(request);
			deps.audit({
				action: "session-create",
				cwd: request.cwd,
				name: request.name ?? null,
				account: request.account ?? null,
				identity: agentIdentity,
				result: result.ok ? result.short : result.error,
			});
			if (settle) {
				settle(result.ok ? result.short : null);
				deps.layout.observe(deps.source.board());
			}
			if (!result.ok) return refused(result.error);
			return done(
				`Started a session in ${request.cwd} (short id ${result.short})`,
			);
		},
		put_note: ({ id, ...fields }) => {
			const existing = id ? deps.annotations.current()[id] : undefined;
			if (id && existing?.kind !== "note") return refused(`No note ${id}`);
			const note = existing ?? {
				kind: "note",
				...noteSizeFor(fields.text ?? ""),
				z: topZ(deps.annotations.current()) + 1,
				color: "yellow",
				text: "",
			};
			const noteId = id ?? newId();
			const stored = store(
				{ ...note, ...fields, id: noteId },
				noteId,
				!existing,
			);
			if ("ok" in stored) return stored;
			const label = truncate(
				stored.kind === "note" ? (stored.text.split("\n")[0] ?? "") : "",
				60,
			);
			return done(
				`${existing ? "Updated" : "Created"} note '${label}' (id ${noteId}) at ${stored.x},${stored.y}`,
			);
		},
		put_sticker: ({ id, size, ...fields }) => {
			const existing = id ? deps.annotations.current()[id] : undefined;
			if (id && existing?.kind !== "sticker")
				return refused(`No sticker ${id}`);
			const sticker = existing ?? {
				kind: "sticker",
				w: defaultStickerSize,
				h: defaultStickerSize,
				z: topZ(deps.annotations.current()) + 1,
			};
			const stickerId = id ?? newId();
			const stored = store(
				{
					...sticker,
					...fields,
					...(size === undefined ? {} : { w: size, h: size }),
					id: stickerId,
				},
				stickerId,
				!existing,
			);
			if ("ok" in stored) return stored;
			const name = stored.kind === "sticker" ? stored.sticker : "";
			return done(
				`${existing ? "Updated" : "Placed"} sticker ${name} (id ${stickerId}) at ${stored.x},${stored.y}`,
			);
		},
		delete_annotations: ({ ids }) => {
			const removed = ids.filter((id) => deps.annotations.remove(id));
			const missing = ids.length - removed.length;
			return done(
				`Deleted ${plural(removed.length, "note or sticker", "notes and stickers")}${missing ? `; ${missing} not found` : ""}`,
			);
		},
		find_stickers: ({ query }) => {
			const found = matchingStickers(stickerManifest, query);
			return done(
				`Found ${plural(found.length, "sticker")}\n${found.map((s) => `${s.id}: ${s.name}`).join("\n")}`,
			);
		},
		arrange: ({ cards, regions, annotations }) => {
			const board = deps.source.board();
			const live = boardKeys(board);
			const saved = deps.layout.current();
			const updates: LayoutUpdate[] = [];
			for (const item of cards) {
				const key = cardKey(board, item.id);
				if (!key || !live.has(key))
					return refused(`No card ${item.id} on the board`);
				updates.push({ key, placement: cardPlacement(key, item, saved[key]) });
			}
			const known = new Set(deps.regions.current().map((region) => region.id));
			const missingRegion = regions.find((region) => !known.has(region.id));
			if (missingRegion) return refused(`No region ${missingRegion.id}`);
			const current = deps.annotations.current();
			const moved: Annotation[] = [];
			for (const item of annotations) {
				const existing = current[item.id];
				if (!existing) return refused(`No note or sticker ${item.id}`);
				const parsed = parseAnnotation(item.id, { ...existing, ...item });
				if ("error" in parsed) return refused(`${item.id}: ${parsed.error}`);
				moved.push(parsed);
			}
			if (updates.length > 0) deps.layout.setMany(updates);
			for (const { id, ...bounds } of regions) {
				deps.regions.update(id, {
					x: snap(bounds.x),
					y: snap(bounds.y),
					w: snap(bounds.w),
					h: snap(bounds.h),
				});
			}
			for (const annotation of moved) deps.annotations.put(annotation);
			const parts = [
				cards.length ? plural(cards.length, "card") : "",
				regions.length ? plural(regions.length, "region") : "",
				annotations.length
					? plural(annotations.length, "note or sticker", "notes and stickers")
					: "",
			].filter(Boolean);
			return done(`Moved ${parts.join(", ")}`);
		},
		create_region: async ({ colour, ...fields }) => {
			const draft = await parseRegionDraft({
				...fields,
				x: snap(fields.x),
				y: snap(fields.y),
				w: snap(fields.w),
				h: snap(fields.h),
			});
			if ("error" in draft) return refused(draft.error);
			const frames = framesBesideNew(
				draft.cwd,
				projectsOf(deps.source.board(), deps),
			);
			const region = deps.regions.create(clearOfProjects(draft, frames));
			if (!region) return refused("The board is full of regions");
			if (colour) deps.colours.set({ cwd: region.cwd, colour });
			return done(
				`Created region '${regionLabel(region)}' (id ${region.id}) at ${region.x},${region.y}`,
			);
		},
		update_region: ({ id, colour, ...fields }) => {
			const region = deps.regions.current().find((r) => r.id === id);
			if (!region) return refused(`No region ${id}`);
			const changes = Object.keys(fields).length > 0;
			const patch = changes ? parseRegionPatch(fields) : {};
			if ("error" in patch) return refused(patch.error);
			const updated = changes
				? (deps.regions.update(id, patch) ?? region)
				: region;
			if (
				colour !== undefined &&
				!deps.colours.set({ cwd: region.cwd, colour })
			) {
				return refused("The board holds no more project colours");
			}
			return done(`Updated region '${regionLabel(updated)}'`);
		},
		delete_region: ({ id }) => {
			const region = deps.regions.current().find((r) => r.id === id);
			if (!region || !deps.regions.remove(id))
				return refused(`No region ${id}`);
			return done(`Deleted region '${regionLabel(region)}'`);
		},
	};

	return async (threadId, call) => {
		const handler = handlers[call.tool] as (
			call: ToolCall,
			threadId: string,
		) => Promise<ToolOutcome> | ToolOutcome;
		const outcome = await Promise.resolve(handler(call, threadId)).catch(
			(error: unknown) =>
				refused(`The board failed: ${(error as Error).message}`),
		);
		if (!readOnly.has(call.tool)) {
			deps.audit({
				action: "board-agent",
				thread: threadId,
				tool: call.tool,
				target: targetOf(call),
				input: inputOf(call),
				result: outcome.ok
					? (outcome.text.split("\n")[0] ?? "")
					: `error: ${outcome.error}`,
			});
		}
		return outcome;
	};
};

const regionLabel = (region: Region) => region.name ?? region.cwd;

const targetOf = (call: ToolCall): string | null => {
	if ("session" in call) return call.session;
	if ("cwd" in call) return call.cwd;
	if ("id" in call) return call.id ?? null;
	return null;
};

const inputOf = (call: ToolCall): string | null => {
	if (call.tool === "send_prompt") return call.text;
	if (call.tool === "ask_session") return call.question;
	if (call.tool === "answer_prompt") return JSON.stringify(call.reply);
	if (call.tool === "start_session") return call.prompt;
	return null;
};
