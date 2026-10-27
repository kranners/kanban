import {
	CircleAlert,
	MessageCircleQuestion,
	ShieldQuestion,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
	AskAnswer,
	AskQuestion,
	ConversationItem,
	Dialog,
} from "../../shared/conversation.ts";
import { diffLines, type ToolItem } from "./conversation.ts";
import type { Outcome, Request } from "./useConversation.ts";

function PendingInput(props: { tool: ToolItem | undefined }) {
	const tool = props.tool;
	if (!tool) return null;
	const diff = diffLines(tool);
	if (tool.name === "Bash") {
		return (
			<pre class="av-command">
				<span class="av-prompt" aria-hidden="true">
					${" "}
				</span>
				{String(tool.input.command ?? "")}
			</pre>
		);
	}
	if (diff) {
		return (
			<pre class="av-diff">
				{diff.map((line, at) => (
					<span key={at} class={`av-diff-${line.kind}`}>
						<span class="av-diff-mark" aria-hidden="true">
							{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
						</span>
						{line.text}
						{"\n"}
					</span>
				))}
			</pre>
		);
	}
	return <pre class="av-output">{JSON.stringify(tool.input, null, 2)}</pre>;
}

function Permission(props: {
	dialog: Extract<Dialog, { kind: "permission" }>;
	tool: ToolItem | undefined;
	answerable: boolean;
	busy: boolean;
	onChoose: (choice: number, label: string) => void;
}) {
	const { dialog } = props;
	const first = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (props.answerable) first.current?.focus();
	}, [props.answerable, dialog.question]);
	return (
		<>
			<div class="av-dialog-title">
				<ShieldQuestion size={15} aria-hidden="true" />
				<span>{dialog.title}</span>
			</div>
			<PendingInput tool={props.tool} />
			<p class="av-dialog-question">{dialog.question}</p>
			{dialog.options.length > 0 && (
				<fieldset
					class="av-choices"
					aria-label={dialog.question}
					onKeyDown={(event) => {
						const choice = Number(event.key) - 1;
						const option = dialog.options[choice];
						if (!option || !props.answerable || props.busy) return;
						event.preventDefault();
						props.onChoose(choice, option);
					}}
				>
					{dialog.options.map((option, at) =>
						option === "" ? null : (
							<button
								key={option}
								ref={
									at === dialog.options.findIndex(Boolean) ? first : undefined
								}
								type="button"
								class={`focus-button av-choice${at === 0 ? " focus-button-primary" : ""}`}
								disabled={!props.answerable || props.busy}
								onClick={() => props.onChoose(at, option)}
							>
								<kbd>{at + 1}</kbd>
								<span>{option}</span>
							</button>
						),
					)}
				</fieldset>
			)}
		</>
	);
}

function Pick(props: {
	id: string;
	multi: boolean;
	name: string;
	checked: boolean;
	onPick: (checked: boolean) => void;
}) {
	const onChange = (event: Event) =>
		props.onPick((event.currentTarget as HTMLInputElement).checked);
	return props.multi ? (
		<input
			id={props.id}
			type="checkbox"
			name={props.name}
			checked={props.checked}
			onChange={onChange}
		/>
	) : (
		<input
			id={props.id}
			type="radio"
			name={props.name}
			checked={props.checked}
			onChange={onChange}
		/>
	);
}

const emptyAnswers = (questions: AskQuestion[]): AskAnswer[] =>
	questions.map(() => ({ selected: [], other: null }));

function Questions(props: {
	dialog: Extract<Dialog, { kind: "question" }>;
	answerable: boolean;
	busy: boolean;
	onAnswer: (answers: AskAnswer[]) => void;
}) {
	const { questions } = props.dialog;
	const [answers, setAnswers] = useState(() => emptyAnswers(questions));
	const [otherOn, setOtherOn] = useState<boolean[]>(() =>
		questions.map(() => false),
	);
	useEffect(() => {
		setAnswers(emptyAnswers(questions));
		setOtherOn(questions.map(() => false));
	}, [props.dialog.toolUseId]);

	const update = (at: number, change: (answer: AskAnswer) => AskAnswer) =>
		setAnswers((current) =>
			current.map((answer, index) => (index === at ? change(answer) : answer)),
		);

	const pick = (
		at: number,
		question: AskQuestion,
		label: string,
		on: boolean,
	) => {
		if (!question.multiSelect) {
			setOtherOn((current) =>
				current.map((value, index) => (index === at ? false : value)),
			);
			update(at, () => ({ selected: [label], other: null }));
			return;
		}
		update(at, (answer) => ({
			...answer,
			selected: on
				? [...answer.selected, label]
				: answer.selected.filter((value) => value !== label),
		}));
	};

	const toggleOther = (at: number, question: AskQuestion, on: boolean) => {
		setOtherOn((current) =>
			current.map((value, index) => (index === at ? on : value)),
		);
		update(at, (answer) => ({
			selected: question.multiSelect || !on ? answer.selected : [],
			other: on ? (answer.other ?? "") : null,
		}));
	};

	const complete = answers.every(
		(answer, at) =>
			answer.selected.length > 0 ||
			(otherOn[at] && (answer.other ?? "").trim() !== ""),
	);

	return (
		<form
			class="av-questions"
			onSubmit={(event) => {
				event.preventDefault();
				if (complete) props.onAnswer(answers);
			}}
		>
			{questions.map((question, at) => {
				const answer = answers[at] ?? { selected: [], other: null };
				const name = `${props.dialog.toolUseId}-${at}`;
				return (
					<fieldset
						key={name}
						class="av-question"
						disabled={!props.answerable || props.busy}
					>
						<legend>
							{question.header && (
								<span class="av-chip">{question.header}</span>
							)}
							<span class="av-question-text">{question.question}</span>
							{question.multiSelect && (
								<span class="av-question-hint">Choose any</span>
							)}
						</legend>
						{question.options.map((option, index) => (
							<label
								key={option.label}
								class="av-option"
								htmlFor={`${name}-${index}`}
							>
								<Pick
									id={`${name}-${index}`}
									multi={question.multiSelect}
									name={name}
									checked={answer.selected.includes(option.label)}
									onPick={(checked) =>
										pick(at, question, option.label, checked)
									}
								/>
								<span class="av-option-text">
									<span class="av-option-label">{option.label}</span>
									{option.description && (
										<span class="av-option-description">
											{option.description}
										</span>
									)}
								</span>
							</label>
						))}
						<label class="av-option" htmlFor={`${name}-other`}>
							<Pick
								id={`${name}-other`}
								multi={question.multiSelect}
								name={name}
								checked={otherOn[at] ?? false}
								onPick={(checked) => toggleOther(at, question, checked)}
							/>
							<span class="av-option-text">
								<span class="av-option-label">Other</span>
								{otherOn[at] && (
									<input
										type="text"
										class="av-other"
										value={answer.other ?? ""}
										placeholder="Type your answer"
										aria-label={`Other answer to ${question.question}`}
										onInput={(event) => {
											const value = event.currentTarget.value;
											update(at, (current) => ({ ...current, other: value }));
										}}
									/>
								)}
							</span>
						</label>
					</fieldset>
				);
			})}
			<div class="av-dialog-actions">
				<button
					type="submit"
					class="focus-button focus-button-primary"
					disabled={!props.answerable || props.busy || !complete}
				>
					{props.busy ? "Answering…" : "Submit answers"}
				</button>
			</div>
		</form>
	);
}

export function DialogForm(props: {
	dialog: Dialog;
	answerable: boolean;
	readOnly: string | null;
	items: ConversationItem[];
	onRequest: (request: Request) => Promise<Outcome>;
	onTerminal: (() => void) | null;
}): JSX.Element {
	const { dialog } = props;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setError(null), [dialog]);

	const run = async (request: Request) => {
		setBusy(true);
		setError(null);
		const outcome = await props.onRequest(request);
		setBusy(false);
		if (!outcome.ok) setError(outcome.error ?? "That did not go through");
	};

	const tool =
		dialog.kind === "permission" && dialog.toolUseId
			? (props.items.find(
					(item): item is ToolItem =>
						item.kind === "tool" && item.id === dialog.toolUseId,
				) ?? undefined)
			: undefined;

	const blocked =
		props.readOnly ??
		(!props.answerable
			? "Reading the prompt from the session…"
			: dialog.kind === "permission" && !dialog.complete
				? "The session's terminal is too small to show every choice. Widen its pane or open the terminal."
				: null);

	return (
		<section class="av-dialog" aria-label="The session is waiting for you">
			{dialog.kind === "question" ? (
				<>
					<div class="av-dialog-title">
						<MessageCircleQuestion size={15} aria-hidden="true" />
						<span>
							{dialog.questions.length === 1
								? "Claude has a question"
								: "Claude has questions"}
						</span>
					</div>
					<Questions
						dialog={dialog}
						answerable={props.answerable && props.readOnly === null}
						busy={busy}
						onAnswer={(answers) =>
							void run({ type: "answer", toolUseId: dialog.toolUseId, answers })
						}
					/>
				</>
			) : (
				<Permission
					dialog={dialog}
					tool={tool}
					answerable={props.answerable && props.readOnly === null}
					busy={busy}
					onChoose={(choice, label) =>
						void run({
							type: "permission",
							toolUseId: dialog.toolUseId,
							choice,
							label,
						})
					}
				/>
			)}
			{(error || blocked) && (
				<div
					class={`av-dialog-note${error ? " av-dialog-error" : ""}`}
					role={error ? "alert" : "status"}
				>
					{error && <CircleAlert size={14} aria-hidden="true" />}
					<span>{error ?? blocked}</span>
					{props.onTerminal && (
						<button type="button" class="av-link" onClick={props.onTerminal}>
							Open the terminal
						</button>
					)}
				</div>
			)}
		</section>
	);
}
