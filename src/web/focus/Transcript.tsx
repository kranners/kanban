import {
	AppWindow,
	Bot,
	Brain,
	CircleAlert,
	CircleCheck,
	CircleDashed,
	CircleSlash,
	FilePen,
	FileText,
	Globe,
	Image,
	Info,
	ListChecks,
	MessageCircleQuestion,
	MessageSquare,
	Minimize2,
	Plug,
	Search,
	SquareTerminal,
	TriangleAlert,
	Workflow,
	Wrench,
} from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import type { ConversationItem } from "../../shared/conversation.ts";
import { noSubagents, type SubagentState } from "../../shared/subagents.ts";
import { ActivityBadge } from "../activity.tsx";
import { renderMarkdown } from "../markdown.ts";
import { subagentHeadline } from "../subagentCounts.ts";
import {
	type DiffLine,
	diffLines,
	diffStats,
	exitCode,
	formatTokens,
	matchCount,
	mcpParts,
	type ToolItem,
	type ToolState,
	todos,
	toolDetail,
	toolState,
	toolTitle,
	workflowDescription,
} from "./conversation.ts";

export type LinkedSubagent = {
	id: string;
	label: string;
	open: (() => void) | null;
	state: SubagentState;
};

export type Links = {
	subagent(agentId: string): LinkedSubagent | null;
	run(runId: string): LinkedSubagent[];
};

const toolIcons: Record<string, typeof Wrench> = {
	Bash: SquareTerminal,
	Read: FileText,
	Edit: FilePen,
	MultiEdit: FilePen,
	Write: FilePen,
	NotebookEdit: FilePen,
	Grep: Search,
	Glob: Search,
	Agent: Bot,
	Task: Bot,
	TodoWrite: ListChecks,
	WebFetch: Globe,
	WebSearch: Globe,
	AskUserQuestion: MessageCircleQuestion,
	Workflow: Workflow,
	Artifact: AppWindow,
};

function iconFor(name: string): typeof Wrench {
	return toolIcons[name] ?? (mcpParts(name) ? Plug : Wrench);
}

function Images(props: { count: number }) {
	if (props.count === 0) return null;
	return (
		<span class="av-images">
			<Image size={13} aria-hidden="true" />
			{props.count === 1 ? "1 image" : `${props.count} images`}
		</span>
	);
}

function Diff(props: { lines: DiffLine[] }) {
	return (
		<pre class="av-diff">
			{props.lines.map((line, at) => (
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

function Output(props: { text: string; error?: boolean; label?: string }) {
	if (props.text.trim() === "") return null;
	return (
		<div class="av-output-wrap">
			{props.label && <div class="av-label">{props.label}</div>}
			<pre class={`av-output${props.error ? " av-output-error" : ""}`}>
				{props.text}
			</pre>
		</div>
	);
}

function Json(props: { value: Record<string, unknown> }) {
	const entries = Object.keys(props.value);
	if (entries.length === 0) return null;
	return <Output label="Input" text={JSON.stringify(props.value, null, 2)} />;
}

function TodoList(props: { input: Record<string, unknown> }) {
	return (
		<ul class="av-todos">
			{todos(props.input).map((todo, at) => (
				<li key={at} class={`av-todo av-todo-${todo.status}`}>
					{todo.status === "completed" ? (
						<CircleCheck size={14} aria-label="Done" />
					) : todo.status === "in_progress" ? (
						<CircleDashed size={14} aria-label="In progress" />
					) : (
						<span class="av-todo-box" role="img" aria-label="To do" />
					)}
					<span>{todo.content}</span>
				</li>
			))}
		</ul>
	);
}

type Question = {
	question?: unknown;
	header?: unknown;
	options?: { label?: unknown; description?: unknown }[];
};

function Asked(props: { item: ToolItem }) {
	const questions = (
		Array.isArray(props.item.input.questions) ? props.item.input.questions : []
	) as Question[];
	const answers = props.item.result?.answers ?? {};
	return (
		<div class="av-asked">
			{questions.map((question, at) => {
				const text = String(question.question ?? "");
				return (
					<div key={at} class="av-asked-question">
						<div class="av-asked-text">{text}</div>
						<div class="av-asked-answer">
							{answers[text] ?? (props.item.result ? "No answer" : "Waiting…")}
						</div>
					</div>
				);
			})}
		</div>
	);
}

function RunAgents(props: { agents: LinkedSubagent[] }) {
	if (props.agents.length === 0) return null;
	return (
		<ul class="av-run">
			{props.agents.map((agent) => (
				<li key={agent.id}>
					<ActivityBadge activity={agent.state} />
					{agent.open ? (
						<button type="button" class="av-link" onClick={agent.open}>
							{agent.label}
						</button>
					) : (
						<span>{agent.label}</span>
					)}
				</li>
			))}
		</ul>
	);
}

function ToolBody(props: {
	item: ToolItem;
	linked: LinkedSubagent | null;
	run: LinkedSubagent[];
}) {
	const { item } = props;
	const { input, result } = item;
	const resultText = result?.text ?? "";
	const error = result?.isError ?? false;
	const diff = diffLines(item);
	switch (item.name) {
		case "Bash":
			return (
				<>
					<pre class="av-command">
						<span class="av-prompt" aria-hidden="true">
							${" "}
						</span>
						{String(input.command ?? "")}
					</pre>
					<Output text={resultText} error={error} />
				</>
			);
		case "Edit":
		case "MultiEdit":
		case "Write":
			return (
				<>
					{diff && <Diff lines={diff} />}
					{error && <Output text={resultText} error />}
				</>
			);
		case "TodoWrite":
			return <TodoList input={input} />;
		case "AskUserQuestion":
			return <Asked item={item} />;
		case "Agent":
		case "Task": {
			return (
				<>
					{props.linked?.open && (
						<button type="button" class="av-link" onClick={props.linked.open}>
							<Bot size={13} aria-hidden="true" />
							Open the subagent
						</button>
					)}
					<Output label="Prompt" text={String(input.prompt ?? "")} />
					{resultText && (
						<div class="av-markdown markdown">{renderMarkdown(resultText)}</div>
					)}
				</>
			);
		}
		case "Artifact":
			return (
				<>
					{result?.artifact && (
						<a
							class="av-link"
							href={result.artifact.url}
							target="_blank"
							rel="noopener noreferrer"
						>
							<AppWindow size={13} aria-hidden="true" />
							Open {result.artifact.title}
						</a>
					)}
					<Json value={input} />
					<Output label="Result" text={resultText} error={error} />
				</>
			);
		case "Workflow":
			return (
				<>
					<p class="av-run-summary">
						{result?.task?.summary ?? workflowDescription(input)}
						{result?.task && (
							<span class="av-chip num">task {result.task.id}</span>
						)}
					</p>
					<RunAgents agents={props.run} />
					{error && <Output text={resultText} error />}
				</>
			);
		case "Read":
		case "Grep":
		case "Glob":
		case "WebFetch":
		case "WebSearch":
			return <Output text={resultText} error={error} />;
		default:
			return (
				<>
					<Json value={input} />
					<Output label="Result" text={resultText} error={error} />
				</>
			);
	}
}

function Rejected(props: { item: ToolItem }) {
	return (
		<div class="av-quiet av-rejected">
			<CircleSlash size={13} aria-hidden="true" />
			{`Rejected ${toolTitle(props.item.name)}`}
			<span class="av-tool-detail">{toolDetail(props.item)}</span>
		</div>
	);
}

function RunCounts(props: { agents: LinkedSubagent[] }) {
	const counts = noSubagents();
	for (const agent of props.agents) counts[agent.state] += 1;
	const headline = subagentHeadline(counts, "waiting");
	return headline ? <span class="av-chip num">{headline}</span> : null;
}

function ToolSummaryExtras(props: { item: ToolItem }) {
	const { item } = props;
	const count = matchCount(item);
	const code = exitCode(item);
	const diff = item.result?.isError ? null : diffLines(item);
	const stats = diff ? diffStats(diff) : null;
	return (
		<>
			{stats && (stats.added > 0 || stats.removed > 0) && (
				<span class="av-stats num">
					<span class="av-add">+{stats.added}</span>
					<span class="av-del">−{stats.removed}</span>
				</span>
			)}
			{count !== null && (
				<span class="av-chip num">
					{count === 1 ? "1 match" : `${count} matches`}
				</span>
			)}
			{code !== null && code !== 0 && (
				<span class="av-chip av-chip-error num">exit {code}</span>
			)}
			<Images count={item.result?.images ?? 0} />
		</>
	);
}

const stateLabels: Record<ToolState, string> = {
	running: "Running",
	background: "Running in the background",
	done: "Done",
	error: "Error",
	interrupted: "Interrupted",
	rejected: "Rejected",
};

function StateMark(props: { state: ToolState }) {
	const label = stateLabels[props.state];
	switch (props.state) {
		case "running":
		case "background":
			return (
				<span class="av-running" role="img" aria-label={label} title={label} />
			);
		case "error":
			return (
				<CircleAlert size={14} class="av-state-error" aria-label={label} />
			);
		case "interrupted":
			return (
				<CircleSlash size={14} class="av-state-muted" aria-label={label} />
			);
		default:
			return null;
	}
}

function Tool(props: { item: ToolItem; links: Links }) {
	const { item } = props;
	const [open, setOpen] = useState(item.name === "TodoWrite");
	const Icon = iconFor(item.name);
	const state = toolState(item);
	const agentId = item.result?.agentId;
	const linked = agentId ? props.links.subagent(agentId) : null;
	const runId = item.result?.task?.runId;
	const run = runId ? props.links.run(runId) : [];
	if (state === "rejected") return <Rejected item={item} />;
	return (
		<details
			class={`av-tool av-tool-${state}`}
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary>
				<Icon size={14} class="av-tool-icon" aria-hidden="true" />
				<span class="av-tool-name">{toolTitle(item.name)}</span>
				<span class="av-tool-detail">{toolDetail(item)}</span>
				<ToolSummaryExtras item={item} />
				<RunCounts agents={run} />
				{linked ? (
					<ActivityBadge activity={linked.state} />
				) : (
					<StateMark state={state} />
				)}
			</summary>
			{open && (
				<div class="av-tool-body">
					<ToolBody item={item} linked={linked} run={run} />
				</div>
			)}
		</details>
	);
}

function Thinking(props: { text: string; durationMs: number | null }) {
	const seconds =
		props.durationMs === null
			? null
			: Math.max(1, Math.round(props.durationMs / 1000));
	const label = seconds === null ? "Thinking" : `Thought for ${seconds}s`;
	if (props.text === "") {
		return (
			<div class="av-quiet">
				<Brain size={13} aria-hidden="true" />
				{label}
			</div>
		);
	}
	return (
		<details class="av-thinking">
			<summary>
				<Brain size={13} aria-hidden="true" />
				{label}
			</summary>
			<div class="av-thinking-text">{props.text}</div>
		</details>
	);
}

function Notice(props: {
	level: "info" | "warning" | "error";
	children: ComponentChildren;
}) {
	const Icon =
		props.level === "error"
			? CircleAlert
			: props.level === "warning"
				? TriangleAlert
				: Info;
	return (
		<div class={`av-notice av-notice-${props.level}`}>
			<Icon size={13} aria-hidden="true" />
			<span>{props.children}</span>
		</div>
	);
}

function Compaction(props: Extract<ConversationItem, { kind: "compaction" }>) {
	const detail = [
		props.trigger === "auto"
			? "automatically"
			: props.trigger === "manual"
				? "with /compact"
				: null,
		props.preTokens === null
			? null
			: `from ${formatTokens(props.preTokens)} tokens`,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div class="av-compaction">
			<div class="av-rule">
				<Minimize2 size={13} aria-hidden="true" />
				<span>Conversation compacted{detail ? ` ${detail}` : ""}</span>
			</div>
			{props.summary && (
				<details class="av-thinking">
					<summary>Summary</summary>
					<div class="av-thinking-text">{props.summary}</div>
				</details>
			)}
		</div>
	);
}

function Item(props: {
	item: ConversationItem;
	links: Links;
}): JSX.Element | null {
	const { item } = props;
	switch (item.kind) {
		case "user":
			return (
				<div class={`av-user${item.queued ? " av-user-queued" : ""}`}>
					<div class="av-user-text">{item.text}</div>
					<Images count={item.images} />
				</div>
			);
		case "command":
			return (
				<div class="av-command-run">
					<pre class="av-command">
						<span class="av-prompt" aria-hidden="true">
							{item.name === "!" ? "! " : "❯ "}
						</span>
						{item.name === "!"
							? item.args
							: `${item.name}${item.args ? ` ${item.args}` : ""}`}
					</pre>
					<Output text={item.output} />
				</div>
			);
		case "assistant":
			return (
				<div class="av-assistant av-markdown markdown">
					{renderMarkdown(item.text)}
				</div>
			);
		case "thinking":
			return <Thinking text={item.text} durationMs={item.durationMs} />;
		case "tool":
			return <Tool item={item} links={props.links} />;
		case "notice":
			return <Notice level={item.level}>{item.text}</Notice>;
		case "compaction":
			return <Compaction {...item} />;
		case "interrupted":
			return (
				<Notice level="warning">
					{item.forTool
						? "Interrupted · the tool call was stopped"
						: "Interrupted"}
				</Notice>
			);
		case "peer":
			return (
				<div class="av-peer">
					<div class="av-label">
						<MessageSquare size={12} aria-hidden="true" />
						{item.from ? `Message from ${item.from}` : "Peer message"}
					</div>
					<div class="av-user-text">{item.text}</div>
				</div>
			);
		case "task":
			return (
				<Notice level={item.status === "failed" ? "error" : "info"}>
					{item.summary}
				</Notice>
			);
		case "rewound":
			return null;
	}
}

export const TranscriptItem = memo(
	Item,
	(before, after) => before.item === after.item && before.links === after.links,
);
