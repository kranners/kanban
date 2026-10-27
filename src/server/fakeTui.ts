import type { AskQuestion } from "../shared/conversation.ts";
import type { MirrorKey } from "../shared/types.ts";
import type { Tty } from "./answer.ts";

const rule = "─".repeat(60);

type Permission = {
	kind: "permission";
	options: string[];
	cursor: number;
};

type Ask = {
	kind: "ask";
	questions: AskQuestion[];
	tab: number;
	cursor: number;
	picked: string[][];
	typed: (string | null)[];
	review: boolean;
};

export type FakeTui = Tty & {
	state: Permission | Ask | null;
	chosen: string | null;
	submitted: Record<string, string> | null;
	keys: Tty["keys"];
	sent: string[];
	render(): string;
};

const wrap = (value: number, count: number) => (value + count) % count;

const quoteWidth = 60;

const shownQuestion = (question: string): string[] => {
	const plain = question.replace(/`/g, "");
	if (plain.length <= quoteWidth) return [plain];
	const quoted: string[] = [];
	let line = "";
	for (const word of plain.split(" ")) {
		if (line && line.length + word.length + 1 > quoteWidth) {
			quoted.push(`│ ${line}`);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	return [...quoted, `│ ${line}`];
};

const panelColumn = 160;

const besidePanel = (screen: string, panel: string[] | undefined): string =>
	panel
		? screen
				.split("\n")
				.map(
					(line, at) =>
						`${line.padEnd(panelColumn).slice(0, panelColumn)}│${panel[at % panel.length]}`,
				)
				.join("\n")
		: screen;

export function fakeTui(opts: {
	permission?: string[];
	questions?: AskQuestion[];
	lagReads?: number;
	sidePanel?: string[];
}): FakeTui {
	let lag = 0;
	const tui: FakeTui = {
		state: opts.permission
			? { kind: "permission", options: opts.permission, cursor: 0 }
			: opts.questions
				? {
						kind: "ask",
						questions: opts.questions,
						tab: 0,
						cursor: 0,
						picked: opts.questions.map(() => []),
						typed: opts.questions.map(() => null),
						review: false,
					}
				: null,
		chosen: null,
		submitted: null,
		sent: [],
		render() {
			const head = ["❯ do the thing", "", "  Working on it", ""];
			const state = tui.state;
			if (!state)
				return [...head, rule, "❯ ", rule, "  ⏸ manual mode on"].join("\n");
			if (state.kind === "permission") {
				return [
					...head,
					rule,
					" Bash command",
					" echo hi > out.txt",
					" Do you want to proceed?",
					...state.options.map(
						(option, at) =>
							` ${at === state.cursor ? "❯" : " "} ${at + 1}. ${option}`,
					),
					"",
					" Esc to cancel · Tab to amend",
				].join("\n");
			}
			const tabs = state.questions.map(
				(question, at) =>
					`${state.picked[at]?.length || state.typed[at] ? "☒" : "☐"} ${question.header}`,
			);
			const bar =
				state.questions.length > 1
					? `←  ${tabs.join("  ")}  ✔ Submit  →`
					: ` ${tabs[0]} `;
			if (state.review) {
				return [
					...head,
					rule,
					bar,
					"Review your answers",
					...state.questions.map(
						(question, at) =>
							` ● ${question.question}\n   → ${[...(state.picked[at] ?? []), ...(state.typed[at] ? [state.typed[at]] : [])].join(", ")}`,
					),
					"Ready to submit your answers?",
					`${state.cursor === 0 ? "❯" : " "} 1. Submit answers`,
					`${state.cursor === 1 ? "❯" : " "} 2. Cancel`,
				].join("\n");
			}
			const question = state.questions[state.tab];
			if (!question) return "";
			const multi = question.multiSelect;
			const typed = state.typed[state.tab];
			const picked = state.picked[state.tab] ?? [];
			const mark = (row: number) => (state.cursor === row ? "❯" : " ");
			const box = (on: boolean) => (multi ? `[${on ? "✔" : " "}] ` : "");
			const count = question.options.length;
			const last = state.tab === state.questions.length - 1;
			return [
				...head,
				rule,
				bar,
				...shownQuestion(question.question),
				...question.options.flatMap((option, at) => [
					`${mark(at)} ${at + 1}. ${box(picked.includes(option.label))}${option.label}`,
					`     ${option.description}`,
				]),
				`${mark(count)} ${count + 1}. ${box(typed !== null)}${typed ?? (multi ? "Type something" : "Type something.")}`,
				...(multi ? [`${mark(count + 1)}    ${last ? "Submit" : "Next"}`] : []),
				rule,
				`${mark(count + (multi ? 2 : 1))} ${count + 2}. Chat about this`,
				"Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
			].join("\n");
		},
		async screen() {
			if (lag > 0) {
				lag -= 1;
				return { ok: true, value: "" };
			}
			return { ok: true, value: besidePanel(tui.render(), opts.sidePanel) };
		},
		async keys(keys: MirrorKey[]) {
			for (const key of keys) press(key);
			lag = opts.lagReads ?? 0;
			return { ok: true, value: null };
		},
		async paste(text) {
			tui.sent.push(text);
			const state = tui.state;
			if (state?.kind !== "ask" || state.review)
				return { ok: true, value: null };
			const question = state.questions[state.tab];
			if (question && state.cursor === question.options.length) {
				state.typed[state.tab] = text;
			}
			return { ok: true, value: null };
		},
	};

	const advance = (state: Ask) => {
		state.cursor = 0;
		if (state.tab + 1 < state.questions.length) {
			state.tab += 1;
			return;
		}
		if (state.questions.length > 1) {
			state.review = true;
			return;
		}
		submit(state);
	};

	const submit = (state: Ask) => {
		tui.submitted = Object.fromEntries(
			state.questions.map((question, at) => [
				question.question,
				[
					...(state.picked[at] ?? []),
					...(state.typed[at] ? [state.typed[at]] : []),
				].join(", "),
			]),
		);
		tui.state = null;
	};

	const press = (key: MirrorKey) => {
		const state = tui.state;
		if (!state) return;
		if (state.kind === "permission") {
			if (key === "Up" || key === "Down") {
				state.cursor = wrap(
					state.cursor + (key === "Down" ? 1 : -1),
					state.options.length,
				);
			}
			if (key === "Enter") {
				tui.chosen = state.options[state.cursor] ?? null;
				tui.state = null;
			}
			return;
		}
		if (state.review) {
			if (key === "Up" || key === "Down")
				state.cursor = wrap(state.cursor + 1, 2);
			if (key === "Enter") {
				if (state.cursor === 0) submit(state);
				else tui.state = null;
			}
			return;
		}
		const question = state.questions[state.tab];
		if (!question) return;
		const count = question.options.length;
		const rows = count + (question.multiSelect ? 3 : 2);
		if (key === "Up" || key === "Down") {
			state.cursor = wrap(state.cursor + (key === "Down" ? 1 : -1), rows);
			return;
		}
		if (key !== "Enter") return;
		const picked = state.picked[state.tab] ?? [];
		if (!question.multiSelect) {
			if (state.cursor < count) {
				state.picked[state.tab] = [question.options[state.cursor]?.label ?? ""];
				state.typed[state.tab] = null;
				advance(state);
			} else if (state.cursor === count && state.typed[state.tab]) {
				state.picked[state.tab] = [];
				advance(state);
			}
			return;
		}
		if (state.cursor < count) {
			const label = question.options[state.cursor]?.label ?? "";
			state.picked[state.tab] = picked.includes(label)
				? picked.filter((value) => value !== label)
				: [...picked, label];
		} else if (state.cursor === count) {
			state.typed[state.tab] = null;
		} else if (state.cursor === count + 1) {
			advance(state);
		}
	};

	return tui;
}
