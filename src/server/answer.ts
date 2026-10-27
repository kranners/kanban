import type { AskAnswer, AskQuestion } from "../shared/conversation.ts";
import type { MirrorKey } from "../shared/types.ts";
import type { CmuxResult } from "./cmux.ts";
import {
	type AskScreen,
	type ChoiceScreen,
	cursorRow,
	moves,
	normalise,
	readDialog,
	type ScreenDialog,
	sameLabel,
} from "./screen.ts";

export type Tty = {
	screen(): Promise<CmuxResult<string>>;
	keys(keys: MirrorKey[]): Promise<CmuxResult<null>>;
	paste(text: string): Promise<CmuxResult<null>>;
};

export type Outcome = CmuxResult<null>;

export type AnswerTiming = { pollMs: number; settleMs: number };

const defaultTiming: AnswerTiming = { pollMs: 120, settleMs: 1500 };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const refuse = (error: string): Outcome => ({ ok: false, error });

const ok: Outcome = { ok: true, value: null };

export const notShowing =
	"The session is not showing that prompt any more, so nothing was sent. Open the terminal to check it.";

class Refusal extends Error {}

const must = async <T>(result: Promise<CmuxResult<T>>): Promise<T> => {
	const settled = await result;
	if (!settled.ok) throw new Refusal(settled.error);
	return settled.value;
};

const driver = (tty: Tty, timing: AnswerTiming) => {
	const read = async (): Promise<ScreenDialog | null> =>
		readDialog(await must(tty.screen()));
	const until = async (
		done: (dialog: ScreenDialog | null) => boolean,
	): Promise<ScreenDialog | null> => {
		const deadline = Date.now() + timing.settleMs;
		let dialog = await read();
		while (!done(dialog) && Date.now() < deadline) {
			await wait(timing.pollMs);
			dialog = await read();
		}
		return dialog;
	};
	return {
		read,
		until,
		press: (keys: MirrorKey[]) =>
			keys.length === 0 ? Promise.resolve(null) : must(tty.keys(keys)),
		paste: (text: string) => must(tty.paste(text)),
	};
};

type Driver = ReturnType<typeof driver>;

const askScreen = (dialog: ScreenDialog | null): AskScreen => {
	if (dialog?.kind !== "ask") throw new Refusal(notShowing);
	return dialog;
};

const isAsk = (
	dialog: ScreenDialog | null,
	check: (screen: AskScreen) => boolean,
): boolean => dialog?.kind === "ask" && check(dialog);

const moveTo = async (
	drive: Driver,
	screen: AskScreen,
	target: number,
): Promise<AskScreen> => {
	await drive.press(moves(cursorRow(screen.rows), target));
	const moved = await drive.until((dialog) =>
		isAsk(dialog, (ask) => cursorRow(ask.rows) === target),
	);
	if (!isAsk(moved, (ask) => cursorRow(ask.rows) === target)) {
		throw new Refusal(
			"The prompt did not move to that answer, so it was left open",
		);
	}
	return askScreen(moved);
};

const typeOther = async (
	drive: Driver,
	screen: AskScreen,
	row: number,
	text: string,
): Promise<AskScreen> => {
	await moveTo(drive, screen, row);
	await drive.paste(text);
	const typed = await drive.until((dialog) =>
		isAsk(dialog, (ask) => sameLabel(ask.rows[row]?.label ?? "", text)),
	);
	if (!isAsk(typed, (ask) => sameLabel(ask.rows[row]?.label ?? "", text))) {
		throw new Refusal(
			"The typed answer did not appear in the prompt, so it was left open",
		);
	}
	return askScreen(typed);
};

const answerOne = async (
	drive: Driver,
	question: AskQuestion,
	answer: AskAnswer,
): Promise<void> => {
	let screen = askScreen(
		await drive.until((dialog) =>
			isAsk(
				dialog,
				(ask) => !ask.review && sameLabel(ask.question, question.question),
			),
		),
	);
	if (screen.review || !sameLabel(screen.question, question.question)) {
		throw new Refusal(notShowing);
	}
	const count = question.options.length;
	question.options.forEach((option, at) => {
		const row = screen.rows[at];
		if (!row || !sameLabel(row.label, option.label)) {
			throw new Refusal(notShowing);
		}
	});
	const other = answer.other?.trim() ? answer.other : null;
	if (!question.multiSelect) {
		if (other) screen = await typeOther(drive, screen, count, other);
		else {
			const target = question.options.findIndex(
				(option) => option.label === answer.selected[0],
			);
			if (target === -1) throw new Refusal("Pick one of the answers");
			screen = await moveTo(drive, screen, target);
		}
		await drive.press(["Enter"]);
		await drive.until(
			(dialog) =>
				!isAsk(dialog, (ask) => sameLabel(ask.question, question.question)),
		);
		return;
	}
	for (const [at, option] of question.options.entries()) {
		const wanted = answer.selected.includes(option.label);
		if ((screen.rows[at]?.checked ?? false) === wanted) continue;
		screen = await moveTo(drive, screen, at);
		await drive.press(["Enter"]);
		const toggled = await drive.until((dialog) =>
			isAsk(dialog, (ask) => (ask.rows[at]?.checked ?? false) === wanted),
		);
		if (!isAsk(toggled, (ask) => (ask.rows[at]?.checked ?? false) === wanted)) {
			throw new Refusal(
				"An answer did not toggle, so the prompt was left open",
			);
		}
		screen = askScreen(toggled);
	}
	if (other) screen = await typeOther(drive, screen, count, other);
	const submit = screen.rows.findIndex(
		(row) => normalise(row.label) === "submit",
	);
	if (submit === -1) throw new Refusal(notShowing);
	screen = await moveTo(drive, screen, submit);
	await drive.press(["Enter"]);
	await drive.until(
		(dialog) =>
			!isAsk(dialog, (ask) => sameLabel(ask.question, question.question)),
	);
};

const submitReview = async (drive: Driver): Promise<void> => {
	const screen = await drive.read();
	if (screen?.kind !== "ask" || !screen.review) return;
	const submit = screen.rows.findIndex(
		(row) => normalise(row.label) === "submit answers",
	);
	if (submit === -1) throw new Refusal(notShowing);
	await moveTo(drive, screen, submit);
	await drive.press(["Enter"]);
};

const run = async (task: () => Promise<void>): Promise<Outcome> => {
	try {
		await task();
		return ok;
	} catch (error) {
		if (error instanceof Refusal) return refuse(error.message);
		throw error;
	}
};

export const validAnswers = (
	questions: AskQuestion[],
	answers: AskAnswer[],
): string | null => {
	if (answers.length !== questions.length) return "Answer every question";
	for (const [at, question] of questions.entries()) {
		const answer = answers[at];
		if (!answer) return "Answer every question";
		const labels = question.options.map((option) => option.label);
		if (answer.selected.some((label) => !labels.includes(label))) {
			return "An answer is not one of the choices";
		}
		const other = answer.other?.trim() ?? "";
		if (/\p{Cc}/u.test(answer.other ?? "")) {
			return "An answer cannot contain control characters";
		}
		const picked = answer.selected.length + (other ? 1 : 0);
		if (picked === 0) return `Answer “${question.header || question.question}”`;
		if (!question.multiSelect && picked > 1) {
			return `“${question.header || question.question}” takes one answer`;
		}
	}
	return null;
};

export const answerQuestions = (
	tty: Tty,
	questions: AskQuestion[],
	answers: AskAnswer[],
	timing: AnswerTiming = defaultTiming,
): Promise<Outcome> => {
	const invalid = validAnswers(questions, answers);
	if (invalid) return Promise.resolve(refuse(invalid));
	const drive = driver(tty, timing);
	return run(async () => {
		for (const [at, question] of questions.entries()) {
			const answer = answers[at];
			if (answer) await answerOne(drive, question, answer);
		}
		await submitReview(drive);
	});
};

export const choosePermission = (
	tty: Tty,
	choice: number,
	label: string,
	isPrompt: (dialog: ChoiceScreen) => boolean = () => true,
	timing: AnswerTiming = defaultTiming,
): Promise<Outcome> => {
	const drive = driver(tty, timing);
	const showing = (dialog: ScreenDialog | null, cursor: number | null) =>
		dialog?.kind === "choice" &&
		isPrompt(dialog) &&
		sameLabel(dialog.options[choice] ?? "", label) &&
		(cursor === null || dialog.cursor === cursor);
	return run(async () => {
		const screen = await drive.read();
		if (screen?.kind !== "choice" || !showing(screen, null)) {
			throw new Refusal(notShowing);
		}
		await drive.press(moves(screen.cursor, choice));
		const moved = await drive.until((dialog) => showing(dialog, choice));
		if (!showing(moved, choice)) {
			throw new Refusal(
				"The prompt did not move to that choice, so it was left open",
			);
		}
		await drive.press(["Enter"]);
	});
};
