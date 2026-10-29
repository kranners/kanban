import type { AskAnswer, AskQuestion } from "../shared/conversation.ts";
import type { MirrorKey } from "../shared/types.ts";
import type { CmuxResult } from "./cmux.ts";
import {
	type AskScreen,
	type ChoiceScreen,
	cursorRow,
	isSubmitRow,
	moves,
	normalise,
	readDialog,
	type ScreenDialog,
	sameLabel,
	sameText,
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

const isMulti = (screen: AskScreen): boolean =>
	screen.rows.some((row) => row.checked !== null);

const shownAt = (screen: AskScreen, questions: AskQuestion[]): number => {
	if (screen.review) return questions.length;
	const exact = questions.findIndex((question) =>
		sameText(screen.question, question.question),
	);
	if (exact !== -1) return exact;
	const close = questions
		.map((question, at) => ({ question, at }))
		.filter(({ question }) => sameLabel(screen.question, question.question))
		.sort((a, b) => b.question.question.length - a.question.question.length);
	return close[0]?.at ?? -1;
};

const showing = async (
	drive: Driver,
	questions: AskQuestion[],
): Promise<AskScreen> =>
	askScreen(
		await drive.until((dialog) =>
			isAsk(dialog, (ask) => shownAt(ask, questions) !== -1),
		),
	);

const goTo = async (
	drive: Driver,
	questions: AskQuestion[],
	target: number,
): Promise<AskScreen> => {
	let screen = await showing(drive, questions);
	for (let step = 0; step <= questions.length; step++) {
		const at = shownAt(screen, questions);
		if (at === -1) throw new Refusal(notShowing);
		if (at === target) return screen;
		const cursor = cursorRow(screen.rows);
		if (!screen.review && cursor === questions[at]?.options.length) {
			screen = await moveTo(drive, screen, cursor - 1);
		}
		const next = at < target ? at + 1 : at - 1;
		await drive.press([at < target ? "Tab" : "Shift+Tab"]);
		screen = askScreen(
			await drive.until((dialog) =>
				isAsk(dialog, (ask) => shownAt(ask, questions) === next),
			),
		);
	}
	throw new Refusal(notShowing);
};

const typedAlready = (label: string): string | null => {
	const shown = label.replace(/\s*✔$/, "");
	return shown.trim() === "" || normalise(shown).startsWith("type something")
		? null
		: shown;
};

const holdsTyped = (typed: string, text: string): boolean =>
	/…\s*$/.test(typed)
		? normalise(text).startsWith(normalise(typed))
		: sameText(typed, text);

const otherTyped =
	"The prompt already holds a different typed answer, so it was left open. Open the terminal to check it.";

const typeOther = async (
	drive: Driver,
	screen: AskScreen,
	row: number,
	text: string,
): Promise<AskScreen> => {
	const typed = typedAlready(screen.rows[row]?.label ?? "");
	const moved = await moveTo(drive, screen, row);
	if (typed !== null) {
		if (holdsTyped(typed, text)) return moved;
		throw new Refusal(otherTyped);
	}
	await drive.paste(text);
	const shown = await drive.until((dialog) =>
		isAsk(dialog, (ask) => sameLabel(ask.rows[row]?.label ?? "", text)),
	);
	if (!isAsk(shown, (ask) => sameLabel(ask.rows[row]?.label ?? "", text))) {
		throw new Refusal(
			"The typed answer did not appear in the prompt, so it was left open",
		);
	}
	return askScreen(shown);
};

const answerOne = async (
	drive: Driver,
	questions: AskQuestion[],
	at: number,
	answer: AskAnswer,
): Promise<{ multi: boolean }> => {
	const question = questions[at];
	if (!question) throw new Refusal(notShowing);
	let screen = await goTo(drive, questions, at);
	const count = question.options.length;
	question.options.forEach((option, at) => {
		const row = screen.rows[at];
		if (!row || !sameLabel(row.label, option.label)) {
			throw new Refusal(notShowing);
		}
	});
	const other = answer.other?.trim() ? answer.other : null;
	if (!isMulti(screen)) {
		if (answer.selected.length + (other ? 1 : 0) > 1) {
			throw new Refusal(oneAnswer(question));
		}
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
		return { multi: false };
	}
	if (!other && typedAlready(screen.rows[count]?.label ?? "") !== null) {
		throw new Refusal(otherTyped);
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
	const submit = screen.rows.findIndex(isSubmitRow);
	if (submit === -1) throw new Refusal(notShowing);
	screen = await moveTo(drive, screen, submit);
	await drive.press(["Enter"]);
	await drive.until(
		(dialog) =>
			!isAsk(dialog, (ask) => sameLabel(ask.question, question.question)),
	);
	return { multi: true };
};

export const notSubmitted =
	"The answers were filled in but the prompt did not take them, so it was left open. Open the terminal to check it.";

const isReview = (dialog: ScreenDialog | null) =>
	isAsk(dialog, (ask) => ask.review);

const submitReview = async (drive: Driver): Promise<void> => {
	const screen = await drive.until(isReview);
	if (screen?.kind !== "ask" || !screen.review) throw new Refusal(notSubmitted);
	const submit = screen.rows.findIndex(
		(row) => normalise(row.label) === "submit answers",
	);
	if (submit === -1) throw new Refusal(notSubmitted);
	await moveTo(drive, screen, submit);
	await drive.press(["Enter"]);
	if (isReview(await drive.until((dialog) => !isReview(dialog)))) {
		throw new Refusal(notSubmitted);
	}
};

const run = async <T>(task: () => Promise<T>): Promise<CmuxResult<T>> => {
	try {
		return { ok: true, value: await task() };
	} catch (error) {
		if (error instanceof Refusal) return { ok: false, error: error.message };
		throw error;
	}
};

const named = (question: AskQuestion): string =>
	question.header || question.question;

const oneAnswer = (question: AskQuestion): string =>
	`“${named(question)}” takes one answer`;

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
		if (picked === 0) return `Answer “${named(question)}”`;
		if (!question.multiSelect && picked > 1) return oneAnswer(question);
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
		let last = { multi: false };
		for (const [at, answer] of answers.entries()) {
			last = await answerOne(drive, questions, at, answer);
		}
		if (questions.length > 1 || last.multi) await submitReview(drive);
		return null;
	});
};

export type QuestionShape = { header: string; multiSelect: boolean };

export const readQuestionShapes = (
	tty: Tty,
	questions: AskQuestion[],
	timing: AnswerTiming = defaultTiming,
): Promise<CmuxResult<QuestionShape[]>> => {
	const drive = driver(tty, timing);
	return run(async () => {
		const origin = shownAt(await showing(drive, questions), questions);
		const shapes: QuestionShape[] = [];
		for (const at of questions.keys()) {
			const screen = await goTo(drive, questions, at);
			shapes.push({
				header:
					screen.tabs.length === questions.length
						? (screen.tabs[at] ?? "")
						: "",
				multiSelect: isMulti(screen),
			});
		}
		await goTo(drive, questions, origin);
		return shapes;
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
		return null;
	});
};
