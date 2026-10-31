import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
	type AskAnswer,
	type AskQuestion,
	type ConversationClientFrame,
	type ConversationServerFrame,
	type Dialog,
	type Drive,
	maxPromptText,
	type PromptReply,
	type ViewKey,
} from "../shared/conversation.ts";
import type { NodeRef, Session } from "../shared/types.ts";
import {
	answerQuestions,
	choosePermission,
	type Outcome,
	type QuestionShape,
	readQuestionShapes,
	validAnswers,
} from "./answer.ts";
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
	normalise,
	permissionMode,
	readDialog,
	type ScreenDialog,
} from "./screen.ts";
import type { RemotePrompt, RemotePrompts, SessionTty } from "./terminals.ts";

export type ConversationTarget =
	| { kind: "session"; session: Session; path: string | null }
	| { kind: "subagent"; id: string; path: string };

export type Since = { epoch: string; rev: number } | null;

export type ConversationDeps = {
	session(id: string): Session | null;
	tty(session: Session): SessionTty | null;
	transcriptPath(node: NodeRef): string | null;
	block(sessionId: string): Record<string, unknown> | null;
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
	respond(
		session: Session,
		reply: PromptReply | null,
	): Promise<CmuxResult<string>>;
	attached(): string[];
	release(short: string): void;
};

const socketOpen = 1;

const shapeTries = 3;
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
	if (session.cloud) return { mode: "drive", via: "cloud" };
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
	block: Record<string, unknown> | null = null,
): boolean =>
	session.activity === "needs-you" &&
	(log.status.pendingTools.length > 0 || blockedQuestion(block) !== null);

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

type PendingQuestion = { toolUseId: string; questions: AskQuestion[] };

const withShapes = (
	block: Record<string, unknown>,
	shapes: QuestionShape[],
): Record<string, unknown> => ({
	...block,
	questions: (Array.isArray(block.questions) ? block.questions : []).map(
		(question: unknown, at) => ({ ...asObject(question), ...shapes[at] }),
	),
});

const blockedQuestion = (
	block: Record<string, unknown> | null,
): PendingQuestion | null => {
	const questions = block ? askQuestions(block) : null;
	if (!questions) return null;
	const digest = createHash("sha256")
		.update(
			JSON.stringify(
				questions.map(({ question, options }) => ({ question, options })),
			),
		)
		.digest("hex")
		.slice(0, 16);
	return { toolUseId: `block-${digest}`, questions };
};

export const pendingQuestion = (
	log: ConversationLog,
	block: Record<string, unknown> | null = null,
): PendingQuestion | null => {
	for (const id of [...log.status.pendingTools].reverse()) {
		const index = log.tools.get(id);
		const item = index === undefined ? undefined : log.items[index];
		if (item?.kind !== "tool" || item.name !== "AskUserQuestion") continue;
		const questions = askQuestions(item.input);
		if (questions) return { toolUseId: id, questions };
	}
	return blockedQuestion(block);
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

const promptFor =
	(log: ConversationLog, toolUseId: string | null) =>
	(shown: ChoiceScreen): boolean => {
		const bound = shownTool(log, shown);
		return bound.bound && bound.toolUseId === toolUseId;
	};

const quoted = (label: string) => `"${label}"`;

type OpenDialog = Exclude<Dialog, { kind: "menu" }>;

const shownPrompt = (name: string, dialog: OpenDialog): string[] => {
	if (dialog.kind === "permission") {
		return [
			`${name} asks permission for ${dialog.title}:`,
			...(dialog.context ? [dialog.context] : []),
			dialog.question,
			...dialog.options.map((option) => `- ${quoted(option)}`),
		];
	}
	return [
		`${name} asks:`,
		...dialog.questions.flatMap((question, at) => [
			`${at + 1}. ${question.header ? `[${question.header}] ` : ""}${question.question} (${question.multiSelect ? "any of" : "one of"}, or a free-text answer)`,
			...question.options.map(
				(option) =>
					`   - ${quoted(option.label)}${option.description ? `: ${option.description}` : ""}`,
			),
		]),
	];
};

export const promptId = (name: string, dialog: OpenDialog): string =>
	createHash("sha256")
		.update(JSON.stringify([dialog.toolUseId, shownPrompt(name, dialog)]))
		.digest("hex")
		.slice(0, 12);

export const describeDialog = (name: string, dialog: OpenDialog): string =>
	[...shownPrompt(name, dialog), `Prompt id: ${promptId(name, dialog)}`].join(
		"\n",
	);

const answered = (answers: AskAnswer[]): string =>
	answers
		.map((answer) =>
			[...answer.selected, ...(answer.other?.trim() ? [answer.other] : [])]
				.map(quoted)
				.join(", "),
		)
		.join("; ");

const choosePermissionLabel = (
	dialog: Extract<Dialog, { kind: "permission" }>,
	answers: AskAnswer[],
	choose: (choice: number, option: string) => Promise<Outcome>,
): Promise<Outcome> => {
	const [answer] = answers;
	const label = answer?.selected[0];
	if (
		answers.length !== 1 ||
		answer?.selected.length !== 1 ||
		answer.other?.trim() ||
		label === undefined
	) {
		return Promise.resolve({
			ok: false,
			error: "A permission prompt takes exactly one of its choices",
		});
	}
	const choice = dialog.options.findIndex(
		(option) => normalise(option) === normalise(label),
	);
	const option = dialog.options[choice];
	return option === undefined
		? Promise.resolve({ ok: false, error: "That is not one of the choices" })
		: choose(choice, option);
};

const answerRemote = (
	prompts: RemotePrompts,
	requestId: string,
	questions: AskQuestion[],
	answers: AskAnswer[],
): Promise<Outcome> => {
	const invalid = validAnswers(questions, answers);
	if (invalid) return Promise.resolve({ ok: false, error: invalid });
	return prompts.answer(
		requestId,
		Object.fromEntries(
			questions.map((question, at) => {
				const answer = answers[at];
				const other = answer?.other?.trim();
				return [
					question.question,
					[...(answer?.selected ?? []), ...(other ? [other] : [])].join(", "),
				];
			}),
		),
	);
};

const remoteContextLimit = 2000;

const remoteDialog = (
	log: ConversationLog,
	remote: RemotePrompt,
): { dialog: Dialog; answerable: boolean } => {
	const questions =
		remote.toolName === "AskUserQuestion" ? askQuestions(remote.input) : null;
	if (questions && remote.toolUseId) {
		return {
			dialog: { kind: "question", toolUseId: remote.toolUseId, questions },
			answerable: true,
		};
	}
	const shown = remote.toolUseId !== null && log.tools.has(remote.toolUseId);
	return {
		dialog: {
			kind: "permission",
			toolUseId: remote.toolUseId,
			title: remote.title,
			context: shown
				? null
				: JSON.stringify(remote.input).slice(0, remoteContextLimit),
			question: "Do you want to proceed?",
			options: remote.options,
			complete: true,
		},
		answerable: true,
	};
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
	block: Record<string, unknown> | null = null,
	remote: RemotePrompt | null = null,
): { dialog: Dialog | null; answerable: boolean } => {
	if (remote) return remoteDialog(log, remote);
	const waiting = session?.activity === "needs-you";
	const shown = screen === null ? null : readDialog(screen);
	const question = pendingQuestion(log, block);
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
	respond(reply: PromptReply | null): Promise<CmuxResult<string>>;
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
		let activity: Session["activity"] | null = null;
		let dialogShown = false;
		let busy: Promise<unknown> = Promise.resolve();
		let lastUse = 0;
		let held = 0;

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

		const jobBlock = (): Record<string, unknown> | null =>
			sessionId === null ? null : deps.block(sessionId);

		let shapes: {
			key: string;
			read: QuestionShape[] | null;
			tries: number;
		} | null = null;

		const block = (): Record<string, unknown> | null => {
			const raw = jobBlock();
			return raw && shapes?.read && shapes.key === JSON.stringify(raw.questions)
				? withShapes(raw, shapes.read)
				: raw;
		};

		const learnShapes = async (tty: SessionTty, screen: string | null) => {
			const raw = jobBlock();
			const questions = raw ? askQuestions(raw) : null;
			if (!raw || !questions) return;
			const key = JSON.stringify(raw.questions);
			const earlier = shapes?.key === key ? shapes : null;
			const tries = earlier?.tries ?? 0;
			if (
				earlier?.read ||
				tries >= shapeTries ||
				pendingQuestion(log) !== null ||
				readDialog(screen ?? "")?.kind !== "ask"
			) {
				return;
			}
			const read = await readQuestionShapes(tty, questions);
			shapes = { key, read: read.ok ? read.value : null, tries: tries + 1 };
		};

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

		const publishDialog = (next: ReturnType<typeof dialogOf>) => {
			const key = JSON.stringify(next);
			if (key === dialogKey) return;
			dialogKey = key;
			dialogShown = next.dialog !== null;
			broadcast({ type: "dialog", ...next });
		};

		const syncScreen = async (current: Session | null) => {
			if (!current) return;
			if (current.activity !== activity) {
				activity = current.activity;
				screenAt = 0;
			}
			if (Date.now() - screenAt < screenMs) return;
			screenAt = Date.now();
			const drive = driveOf(current);
			const waiting = awaitingAnswer(current, log, block());
			if (waiting && !dialogShown) {
				publishDialog(dialogOf(log, current, null, block()));
			}
			const wantsScreen =
				drive.mode === "drive" &&
				(drive.via === "cmux" ||
					drive.via === "cloud" ||
					waiting ||
					ttys.has(current.id));
			let screen: string | null = null;
			let remote: RemotePrompt | null = null;
			if (wantsScreen) {
				const tty = ttyFor(current);
				const read = tty ? await tty.screen() : null;
				screen = read?.ok ? read.value : null;
				remote = tty?.prompts?.pending() ?? null;
				if (tty && waiting) await learnShapes(tty, screen);
			}
			if (drive.mode === "drive" && drive.via === "attach" && !waiting) {
				if (Date.now() - lastUse > 30_000) releaseTty(current.id);
			}
			publishDialog(dialogOf(log, current, screen, block(), remote));
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
			if (watches.get(key) === self) watches.delete(key);
			if (sessionId && held === 0 && !watches.has(key)) releaseTty(sessionId);
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
						awaitingAnswer(current, log, block()),
					);
					if (refused) return { ok: false, error: refused };
					const shown = await shownDialog();
					if (!shown.ok) return shown;
					const blocked = screenRefusal(shown.value, null, true);
					return blocked ? { ok: false, error: blocked } : tty.send(frame.text);
				}
				case "key": {
					if (awaitingAnswer(current, log, block())) {
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
					const remote = tty.prompts?.pending() ?? null;
					const fresh = dialogOf(log, current, screen.value, null, remote);
					if (
						fresh.dialog?.kind !== "permission" ||
						!fresh.answerable ||
						fresh.dialog.toolUseId !== frame.toolUseId
					) {
						return { ok: false, error: "That prompt is no longer open" };
					}
					if (remote && tty.prompts) {
						return fresh.dialog.options[frame.choice] === frame.label
							? tty.prompts.choose(remote.requestId, frame.label)
							: { ok: false, error: "That is not one of the choices" };
					}
					return choosePermission(
						tty,
						frame.choice,
						frame.label,
						promptFor(log, frame.toolUseId),
					);
				}
				case "answer": {
					const remote = tty.prompts?.pending() ?? null;
					if (remote && tty.prompts) {
						const { dialog } = remoteDialog(log, remote);
						if (
							dialog.kind !== "question" ||
							dialog.toolUseId !== frame.toolUseId
						) {
							return { ok: false, error: "That question is no longer open" };
						}
						return answerRemote(
							tty.prompts,
							remote.requestId,
							dialog.questions,
							frame.answers,
						);
					}
					const question = pendingQuestion(log, block());
					if (!question || question.toolUseId !== frame.toolUseId) {
						return { ok: false, error: "That question is no longer open" };
					}
					return answerQuestions(tty, question.questions, frame.answers);
				}
			}
		};

		const respondNow = async (
			reply: PromptReply | null,
		): Promise<CmuxResult<string>> => {
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
			const screen = await tty.screen();
			if (!screen.ok) return screen;
			await learnShapes(tty, screen.value);
			const remote = tty.prompts?.pending() ?? null;
			const { dialog, answerable } = dialogOf(
				log,
				current,
				screen.value,
				block(),
				remote,
			);
			if (!dialog || dialog.kind === "menu") {
				return {
					ok: false,
					error: `${current.name} is not waiting on a question or permission prompt`,
				};
			}
			const shown = describeDialog(current.name, dialog);
			if (!reply) return { ok: true, value: shown };
			if (reply.prompt !== promptId(current.name, dialog)) {
				return {
					ok: false,
					error: `The open prompt is not the one you read, so nothing was answered. Check it with the user before answering.\n${shown}`,
				};
			}
			const { answers } = reply;
			if (!answerable) {
				return {
					ok: false,
					error: `The prompt is not on ${current.name}'s screen, so it cannot be answered from the board yet.\n${shown}`,
				};
			}
			const { prompts } = tty;
			const outcome =
				remote && prompts
					? dialog.kind === "question"
						? await answerRemote(
								prompts,
								remote.requestId,
								dialog.questions,
								answers,
							)
						: await choosePermissionLabel(dialog, answers, (_, option) =>
								prompts.choose(remote.requestId, option),
							)
					: dialog.kind === "question"
						? await answerQuestions(tty, dialog.questions, answers)
						: await choosePermissionLabel(dialog, answers, (choice, option) =>
								choosePermission(
									tty,
									choice,
									option,
									promptFor(log, dialog.toolUseId),
								),
							);
			return outcome.ok
				? {
						ok: true,
						value: `Answered ${current.name}'s prompt with ${answered(answers)}`,
					}
				: { ok: false, error: `${outcome.error}\n${shown}` };
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
			respond(reply) {
				held += 1;
				const task = busy.then(() => respondNow(reply));
				busy = task.catch(() => null);
				return task.finally(() => {
					held -= 1;
					screenAt = 0;
					if (viewers.size === 0) stop();
				});
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

	const watchOf = (target: ConversationTarget): Watch => {
		const key = `${target.kind}:${target.kind === "session" ? target.session.id : target.id}`;
		return watches.get(key) ?? watch(key, target);
	};

	const open: ConversationHub["open"] = (socket, target, since, identity) => {
		const shared = watchOf(target);
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
		respond: (session, reply) =>
			watchOf({ kind: "session", session, path: null }).respond(reply),
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
