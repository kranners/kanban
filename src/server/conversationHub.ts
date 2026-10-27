import { basename } from "node:path";
import {
	type AskAnswer,
	type AskQuestion,
	type ConversationClientFrame,
	type ConversationServerFrame,
	type Dialog,
	type Drive,
	maxPromptText,
	type ViewKey,
} from "../shared/conversation.ts";
import type { NodeRef, Session } from "../shared/types.ts";
import { answerQuestions, choosePermission, type Outcome } from "./answer.ts";
import type { AttachSocket } from "./attach.ts";
import type { Audit } from "./audit.ts";
import type { CmuxResult } from "./cmux.ts";
import {
	advanceLog,
	type ConversationLog,
	createLog,
	itemsBefore,
	itemsSince,
} from "./conversation.ts";
import { asObject, asString } from "./ingest/json.ts";
import {
	type ChoiceScreen,
	permissionMode,
	readDialog,
	type ScreenDialog,
} from "./screen.ts";
import type { SessionTty } from "./terminals.ts";

export type ConversationTarget =
	| { kind: "session"; session: Session; path: string | null }
	| { kind: "subagent"; id: string; path: string };

export type Since = { epoch: string; rev: number } | null;

export type ConversationDeps = {
	session(id: string): Session | null;
	tty(session: Session): SessionTty | null;
	transcriptPath(node: NodeRef): string | null;
	audit: Audit;
	pollMs?: number;
	screenMs?: number;
	windowSize?: number;
};

export type ConversationHub = {
	open(
		socket: AttachSocket,
		target: ConversationTarget,
		since: Since,
		identity: string | null,
	): void;
	attached(): string[];
	release(short: string): void;
};

const socketOpen = 1;
const viewKeys: ViewKey[] = ["Escape", "Shift+Tab"];
const controlCharacters = /(?![\n\t])\p{Cc}/u;
const frameIdPattern = /^[\w-]{1,64}$/;

export const parseSince = (raw: string | null): Since => {
	const match = /^([\w-]{1,64}):(\d{1,12})$/.exec(raw ?? "");
	return match?.[1] && match[2]
		? { epoch: match[1], rev: Number(match[2]) }
		: null;
};

export const driveOf = (session: Session): Drive => {
	if (session.kind === "background") {
		return session.attachable && session.short
			? { mode: "drive", via: "attach" }
			: { mode: "read", reason: "This background session cannot be attached" };
	}
	return session.cmux
		? { mode: "drive", via: "cmux" }
		: {
				mode: "read",
				reason:
					"Started in a terminal outside cmux, so it can only be read here.",
			};
};

export const awaitingAnswer = (
	session: Session,
	log: ConversationLog,
): boolean =>
	session.activity === "needs-you" && log.status.pendingTools.length > 0;

export const promptRefusal = (
	text: string,
	awaiting: boolean,
): string | null => {
	if (text.trim() === "") return "Type something to send";
	if (text.length > maxPromptText) {
		return `A prompt can be at most ${maxPromptText} characters`;
	}
	if (controlCharacters.test(text)) {
		return "A prompt cannot contain control characters";
	}
	if (awaiting) {
		return "The session is waiting on a question or permission prompt. Answer it first.";
	}
	return null;
};

export const screenRefusal = (
	shown: ScreenDialog | null,
	key: ViewKey | null,
	working: boolean,
): string | null => {
	if (shown?.kind === "menu") {
		return key === "Escape"
			? null
			: `The session has a menu open (${shown.title}). Close it with Esc or use the terminal.`;
	}
	if (shown) {
		return "The session is waiting on a question or permission prompt. Answer it first.";
	}
	if (key === "Escape" && !working)
		return "Claude is not working, so there is nothing to interrupt";
	return null;
};

const askQuestions = (input: Record<string, unknown>): AskQuestion[] | null => {
	if (!Array.isArray(input.questions)) return null;
	const questions = input.questions.flatMap((value) => {
		const question = asObject(value);
		const text = asString(question?.question);
		if (!question || !text || !Array.isArray(question.options)) return [];
		return [
			{
				question: text,
				header: asString(question.header) ?? "",
				multiSelect: question.multiSelect === true,
				options: question.options.flatMap((option) => {
					const label = asString(asObject(option)?.label);
					return label
						? [
								{
									label,
									description: asString(asObject(option)?.description) ?? "",
								},
							]
						: [];
				}),
			},
		];
	});
	return questions.length > 0 ? questions : null;
};

export const pendingQuestion = (
	log: ConversationLog,
): { toolUseId: string; questions: AskQuestion[] } | null => {
	for (const id of [...log.status.pendingTools].reverse()) {
		const index = log.tools.get(id);
		const item = index === undefined ? undefined : log.items[index];
		if (item?.kind !== "tool" || item.name !== "AskUserQuestion") continue;
		const questions = askQuestions(item.input);
		if (questions) return { toolUseId: id, questions };
	}
	return null;
};

export const pendingTool = (
	log: ConversationLog,
): { id: string; name: string } | null => {
	const id = log.status.pendingTools.at(-1);
	const index = id === undefined ? undefined : log.tools.get(id);
	const item = index === undefined ? undefined : log.items[index];
	return item?.kind === "tool" && id ? { id, name: item.name } : null;
};

const compact = (text: string): string => text.replace(/\s+/g, "");

export const promptMarker = (tool: {
	name: string;
	input: Record<string, unknown>;
}): string | null => {
	if (tool.name === "Bash") {
		const command = compact(asString(tool.input.command) ?? "");
		return command === "" ? null : command.slice(0, 40);
	}
	const path =
		asString(tool.input.file_path) ?? asString(tool.input.notebook_path);
	return path ? basename(path) : null;
};

export const shownTool = (
	log: ConversationLog,
	screen: ChoiceScreen,
): { toolUseId: string | null; bound: boolean } => {
	const pending = log.status.pendingTools.flatMap((id) => {
		const index = log.tools.get(id);
		const item = index === undefined ? undefined : log.items[index];
		return item?.kind === "tool" ? [{ id, marker: promptMarker(item) }] : [];
	});
	if (pending.length === 0) return { toolUseId: null, bound: true };
	const body = compact(`${screen.body}${screen.question}`);
	const marked = pending.findLast(
		({ marker }) => marker !== null && body.includes(marker),
	);
	const unmarked = pending.findLast(({ marker }) => marker === null);
	const tool = marked ?? unmarked;
	return tool
		? { toolUseId: tool.id, bound: true }
		: { toolUseId: null, bound: false };
};

const toolName = (log: ConversationLog, id: string | null): string | null => {
	const index = id === null ? undefined : log.tools.get(id);
	const item = index === undefined ? undefined : log.items[index];
	return item?.kind === "tool" ? item.name : null;
};

export const dialogOf = (
	log: ConversationLog,
	session: Session | null,
	screen: string | null,
): { dialog: Dialog | null; answerable: boolean } => {
	const waiting = session?.activity === "needs-you";
	const shown = screen === null ? null : readDialog(screen);
	const question = pendingQuestion(log);
	if (question && (waiting || shown?.kind === "ask")) {
		return {
			dialog: { kind: "question", ...question },
			answerable: shown?.kind === "ask",
		};
	}
	const tool = pendingTool(log);
	if (shown?.kind === "choice" && (waiting || tool)) {
		const bound = shownTool(log, shown);
		return {
			dialog: {
				kind: "permission",
				toolUseId: bound.toolUseId,
				title: toolName(log, bound.toolUseId) ?? "Claude Code",
				context: bound.toolUseId === null ? shown.body : null,
				question: shown.question,
				options: shown.options,
				complete: shown.complete,
			},
			answerable: bound.bound,
		};
	}
	if (shown?.kind === "menu") {
		return { dialog: { kind: "menu", title: shown.title }, answerable: true };
	}
	if (waiting && tool) {
		return {
			dialog: {
				kind: "permission",
				toolUseId: tool.id,
				title: tool.name,
				context: null,
				question: "Waiting for permission",
				options: [],
				complete: false,
			},
			answerable: false,
		};
	}
	return { dialog: null, answerable: false };
};

const parseAnswers = (raw: unknown): AskAnswer[] | null => {
	if (!Array.isArray(raw) || raw.length > 8) return null;
	const answers = raw.map((value) => {
		const answer = asObject(value);
		const selected = answer?.selected;
		const other = answer?.other;
		if (
			!answer ||
			!Array.isArray(selected) ||
			selected.length > 16 ||
			!selected.every((label) => typeof label === "string") ||
			(other !== null && (typeof other !== "string" || other.length > 4000))
		) {
			return null;
		}
		return { selected: selected as string[], other: other as string | null };
	});
	return answers.every((answer) => answer !== null)
		? (answers as AskAnswer[])
		: null;
};

export const parseConversationFrame = (
	raw: unknown,
): ConversationClientFrame | null => {
	try {
		const frame = asObject(JSON.parse(String(raw)));
		if (!frame) return null;
		if (frame.type === "more" && Number.isInteger(frame.before)) {
			return { type: "more", before: frame.before as number };
		}
		const id = asString(frame.id);
		if (!id || !frameIdPattern.test(id)) return null;
		if (frame.type === "prompt" && typeof frame.text === "string") {
			return { type: "prompt", id, text: frame.text };
		}
		if (frame.type === "key" && viewKeys.includes(frame.key as ViewKey)) {
			return { type: "key", id, key: frame.key as ViewKey };
		}
		if (
			frame.type === "permission" &&
			Number.isInteger(frame.choice) &&
			(frame.choice as number) >= 0 &&
			typeof frame.label === "string" &&
			(frame.toolUseId === null || typeof frame.toolUseId === "string")
		) {
			return {
				type: "permission",
				id,
				toolUseId: frame.toolUseId as string | null,
				choice: frame.choice as number,
				label: frame.label,
			};
		}
		const answers = parseAnswers(frame.answers);
		if (
			frame.type === "answer" &&
			typeof frame.toolUseId === "string" &&
			answers
		) {
			return { type: "answer", id, toolUseId: frame.toolUseId, answers };
		}
		return null;
	} catch {
		return null;
	}
};

type Viewer = { socket: AttachSocket; first: number };

type Watch = {
	target: ConversationTarget;
	log: ConversationLog;
	viewers: Set<Viewer>;
	join(viewer: Viewer, since: Since): void;
	leave(viewer: Viewer): void;
	request(
		viewer: Viewer,
		frame: ConversationClientFrame,
		identity: string | null,
	): void;
};

export const createConversationHub = (
	deps: ConversationDeps,
): ConversationHub => {
	const pollMs = deps.pollMs ?? 400;
	const screenMs = deps.screenMs ?? 1200;
	const windowSize = deps.windowSize ?? 150;
	const watches = new Map<string, Watch>();
	const ttys = new Map<string, { tty: SessionTty; short: string | null }>();

	const sendTo = (socket: AttachSocket, frame: ConversationServerFrame) => {
		if (socket.readyState === socketOpen) socket.send(JSON.stringify(frame));
	};

	const ttyFor = (session: Session): SessionTty | null => {
		const existing = ttys.get(session.id);
		if (existing) return existing.tty;
		const tty = deps.tty(session);
		if (tty) ttys.set(session.id, { tty, short: session.short });
		return tty;
	};

	const releaseTty = (sessionId: string) => {
		ttys.get(sessionId)?.tty.close();
		ttys.delete(sessionId);
	};

	const watch = (key: string, target: ConversationTarget): Watch => {
		const log = createLog(target.path ?? "");
		const viewers = new Set<Viewer>();
		const sessionId = target.kind === "session" ? target.session.id : null;
		let stopped = false;
		let broadcastRev = 0;
		let statusKey = "";
		let dialogKey = "";
		let modeKey: string | null = null;
		let driveKey = "";
		let timer: NodeJS.Timeout | undefined;
		let screenAt = 0;
		let busy: Promise<unknown> = Promise.resolve();
		let lastUse = 0;

		const advance = () => {
			if (log.path === "" && sessionId) {
				log.path =
					deps.transcriptPath({ kind: "session", id: sessionId }) ?? "";
			}
			advanceLog(log);
		};

		const broadcast = (frame: ConversationServerFrame) => {
			for (const viewer of viewers) sendTo(viewer.socket, frame);
		};

		const itemsFrame = (
			since: Since,
			viewer: Viewer,
		): ConversationServerFrame => {
			const resume = since?.epoch === log.epoch && since.rev <= log.rev;
			const items = resume
				? itemsSince(log, since.rev)
				: itemsBefore(log, log.items.length, windowSize);
			viewer.first = resume
				? viewer.first
				: (items[0]?.index ?? log.items.length);
			return {
				type: "items",
				epoch: log.epoch,
				rev: log.rev,
				total: log.items.length,
				first: viewer.first,
				reset: !resume,
				items,
			};
		};

		const session = (): Session | null =>
			sessionId === null ? null : deps.session(sessionId);

		const syncStatus = () => {
			const key = JSON.stringify(log.status);
			if (key === statusKey) return;
			statusKey = key;
			broadcast({ type: "status", status: log.status });
		};

		const syncDrive = (current: Session | null) => {
			if (target.kind === "subagent") return;
			const drive: Drive = current
				? driveOf(current)
				: { mode: "read", reason: "The session has left the board" };
			const key = JSON.stringify(drive);
			if (key === driveKey) return;
			driveKey = key;
			broadcast({ type: "drive", drive });
		};

		const syncScreen = async (current: Session | null) => {
			if (!current || Date.now() - screenAt < screenMs) return;
			screenAt = Date.now();
			const drive = driveOf(current);
			const waiting = awaitingAnswer(current, log);
			const wantsScreen =
				drive.mode === "drive" &&
				(drive.via === "cmux" || waiting || ttys.has(current.id));
			let screen: string | null = null;
			if (wantsScreen) {
				const tty = ttyFor(current);
				const read = tty ? await tty.screen() : null;
				screen = read?.ok ? read.value : null;
			}
			if (drive.mode === "drive" && drive.via === "attach" && !waiting) {
				if (Date.now() - lastUse > 30_000) releaseTty(current.id);
			}
			const next = dialogOf(log, current, screen);
			const key = JSON.stringify(next);
			if (key !== dialogKey) {
				dialogKey = key;
				broadcast({ type: "dialog", ...next });
			}
			const mode =
				screen === null || readDialog(screen) !== null
					? modeKey
					: permissionMode(screen);
			if (mode !== modeKey) {
				modeKey = mode;
				broadcast({ type: "mode", mode });
			}
		};

		const tick = async () => {
			if (stopped) return;
			advance();
			if (log.rev !== broadcastRev) {
				const items = itemsSince(log, broadcastRev);
				broadcastRev = log.rev;
				if (items.length > 0) {
					broadcast({
						type: "items",
						epoch: log.epoch,
						rev: log.rev,
						total: log.items.length,
						first: -1,
						reset: false,
						items,
					});
				}
				syncStatus();
			}
			const current = session();
			syncDrive(current);
			await syncScreen(current);
		};

		const loop = () => {
			busy = busy
				.then(tick)
				.catch((error: unknown) =>
					console.error("conversation poll failed", error),
				)
				.finally(() => {
					if (viewers.size > 0) timer = setTimeout(loop, pollMs);
				});
		};

		const stop = () => {
			stopped = true;
			clearTimeout(timer);
			if (sessionId) releaseTty(sessionId);
			if (watches.get(key) === self) watches.delete(key);
		};

		const reply = (viewer: Viewer, id: string, outcome: Outcome) =>
			sendTo(viewer.socket, {
				type: "done",
				id,
				ok: outcome.ok,
				error: outcome.ok ? null : outcome.error,
			});

		const perform = async (
			frame: Exclude<ConversationClientFrame, { type: "more" }>,
		): Promise<Outcome> => {
			if (stopped) return { ok: false, error: "Nobody is viewing the session" };
			const current = session();
			if (!current)
				return { ok: false, error: "The session has left the board" };
			const drive = driveOf(current);
			if (drive.mode === "read") return { ok: false, error: drive.reason };
			const tty = ttyFor(current);
			if (!tty)
				return { ok: false, error: "The session cannot be driven from here" };
			lastUse = Date.now();
			advance();
			const shownDialog = async (): Promise<
				CmuxResult<ScreenDialog | null>
			> => {
				const screen = await tty.screen();
				return screen.ok
					? { ok: true, value: readDialog(screen.value) }
					: screen;
			};
			switch (frame.type) {
				case "prompt": {
					const refused = promptRefusal(
						frame.text,
						awaitingAnswer(current, log),
					);
					if (refused) return { ok: false, error: refused };
					const shown = await shownDialog();
					if (!shown.ok) return shown;
					const blocked = screenRefusal(shown.value, null, true);
					return blocked ? { ok: false, error: blocked } : tty.send(frame.text);
				}
				case "key": {
					if (awaitingAnswer(current, log)) {
						return {
							ok: false,
							error: "The session is waiting on a prompt. Answer it first.",
						};
					}
					const shown = await shownDialog();
					if (!shown.ok) return shown;
					const working =
						current.activity === "working" ||
						log.status.pendingTools.length > 0;
					const blocked = screenRefusal(shown.value, frame.key, working);
					if (blocked) return { ok: false, error: blocked };
					const sent = await tty.keys([frame.key]);
					screenAt = 0;
					return sent;
				}
				case "permission": {
					const screen = await tty.screen();
					if (!screen.ok) return screen;
					const fresh = dialogOf(log, current, screen.value);
					if (
						fresh.dialog?.kind !== "permission" ||
						!fresh.answerable ||
						fresh.dialog.toolUseId !== frame.toolUseId
					) {
						return { ok: false, error: "That prompt is no longer open" };
					}
					return choosePermission(tty, frame.choice, frame.label, (shown) => {
						const bound = shownTool(log, shown);
						return bound.bound && bound.toolUseId === frame.toolUseId;
					});
				}
				case "answer": {
					const question = pendingQuestion(log);
					if (!question || question.toolUseId !== frame.toolUseId) {
						return { ok: false, error: "That question is no longer open" };
					}
					return answerQuestions(tty, question.questions, frame.answers);
				}
			}
		};

		const self: Watch = {
			target,
			log,
			viewers,
			join(viewer, since) {
				advance();
				viewers.add(viewer);
				sendTo(viewer.socket, itemsFrame(since, viewer));
				sendTo(viewer.socket, { type: "status", status: log.status });
				if (viewers.size === 1) {
					broadcastRev = log.rev;
					statusKey = JSON.stringify(log.status);
					loop();
				} else {
					if (driveKey)
						sendTo(viewer.socket, {
							type: "drive",
							drive: JSON.parse(driveKey),
						});
					if (dialogKey)
						sendTo(viewer.socket, { type: "dialog", ...JSON.parse(dialogKey) });
					sendTo(viewer.socket, { type: "mode", mode: modeKey });
				}
			},
			leave(viewer) {
				viewers.delete(viewer);
				if (viewers.size === 0) stop();
			},
			request(viewer, frame, identity) {
				if (frame.type === "more") {
					const items = itemsBefore(log, frame.before, windowSize);
					sendTo(viewer.socket, {
						type: "older",
						first: items[0]?.index ?? 0,
						items,
					});
					return;
				}
				if (target.kind !== "session") {
					reply(viewer, frame.id, {
						ok: false,
						error: "Subagents can only be read",
					});
					return;
				}
				busy = busy
					.then(() => perform(frame))
					.catch((error: unknown) => {
						console.error("conversation input failed", error);
						return { ok: false, error: "Sending failed" } as Outcome;
					})
					.then((outcome) => {
						deps.audit({
							action: "view-send",
							sessionId: target.session.id,
							kind: frame.type,
							key: frame.type === "key" ? frame.key : null,
							chars: frame.type === "prompt" ? frame.text.length : null,
							identity,
							result: outcome.ok ? "sent" : `error: ${outcome.error}`,
						});
						reply(viewer, frame.id, outcome);
						screenAt = 0;
					});
			},
		};
		watches.set(key, self);
		return self;
	};

	const open: ConversationHub["open"] = (socket, target, since, identity) => {
		const key = `${target.kind}:${target.kind === "session" ? target.session.id : target.id}`;
		const shared = watches.get(key) ?? watch(key, target);
		const viewer: Viewer = { socket, first: 0 };
		if (target.kind === "session") {
			deps.audit({
				action: "view-open",
				sessionId: target.session.id,
				identity,
			});
		}
		socket.on("message", (raw) => {
			const frame = parseConversationFrame(raw);
			if (!frame) {
				sendTo(socket, {
					type: "done",
					id: "",
					ok: false,
					error: "Unsupported input",
				});
				return;
			}
			shared.request(viewer, frame, identity);
		});
		socket.on("close", () => shared.leave(viewer));
		shared.join(viewer, since);
	};

	const viewed = (): string[] =>
		[...watches.values()].flatMap(({ target, viewers }) => {
			if (target.kind !== "session" || viewers.size === 0) return [];
			const short =
				deps.session(target.session.id)?.short ?? target.session.short;
			return short ? [short] : [];
		});

	return {
		open,
		attached: () => [
			...new Set([
				...viewed(),
				...[...ttys.values()].flatMap(({ tty, short }) =>
					short && tty.isOpen() ? [short] : [],
				),
			]),
		],
		release(short) {
			for (const [sessionId, entry] of ttys) {
				if (entry.short === short) releaseTty(sessionId);
			}
		},
	};
};
