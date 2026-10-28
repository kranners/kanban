import type {
	ConversationItem,
	ConversationServerFrame,
	PatchHunk,
} from "../../shared/conversation.ts";

export type ToolItem = Extract<ConversationItem, { kind: "tool" }>;

export type Window = { first: number; items: ConversationItem[] };

export type DiffLine = {
	kind: "add" | "del" | "ctx" | "hunk";
	text: string;
};

export type Todo = { content: string; status: string };

export type Token = { kind: "slash" | "mention"; query: string; start: number };

export type ToolState =
	| "running"
	| "background"
	| "done"
	| "error"
	| "interrupted"
	| "rejected";

const rejectedPattern = /^The user doesn't want to proceed with this tool use/;

const text = (value: unknown): string =>
	typeof value === "string" ? value : "";

const firstLine = (value: string): string =>
	value
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "") ?? "";

export function emptyWindow(): Window {
	return { first: 0, items: [] };
}

export function upsert(window: Window, items: ConversationItem[]): Window {
	if (items.length === 0) return window;
	const next = [...window.items];
	for (const item of items) {
		const at = item.index - window.first;
		if (at < 0) continue;
		next[at] = item;
	}
	return { first: window.first, items: next };
}

export function prepend(
	window: Window,
	first: number,
	items: ConversationItem[],
): Window {
	if (first >= window.first) return window;
	const older = items.filter((item) => item.index < window.first);
	return { first, items: [...older, ...window.items] };
}

export function applyItems(
	window: Window,
	frame: Extract<ConversationServerFrame, { type: "items" }>,
): Window {
	if (frame.reset) return { first: frame.first, items: [...frame.items] };
	return upsert(window, frame.items);
}

export function mcpParts(
	name: string,
): { server: string; tool: string } | null {
	const match = /^mcp__(.+?)__(.+)$/.exec(name);
	return match?.[1] && match[2] ? { server: match[1], tool: match[2] } : null;
}

export function toolTitle(name: string): string {
	const mcp = mcpParts(name);
	return mcp ? `${mcp.server.replace(/_/g, " ")} · ${mcp.tool}` : name;
}

function readRange(input: Record<string, unknown>): string {
	const offset = typeof input.offset === "number" ? input.offset : null;
	const limit = typeof input.limit === "number" ? input.limit : null;
	if (offset === null && limit === null) return "";
	const start = offset ?? 1;
	return limit === null
		? ` · from line ${start}`
		: ` · lines ${start}–${start + limit - 1}`;
}

export function toolDetail(item: ToolItem): string {
	const { input } = item;
	switch (item.name) {
		case "Bash":
			return (
				firstLine(text(input.description)) || firstLine(text(input.command))
			);
		case "Read":
			return `${text(input.file_path)}${readRange(input)}`;
		case "Edit":
		case "MultiEdit":
		case "Write":
		case "NotebookEdit":
			return text(input.file_path) || text(input.notebook_path);
		case "Grep":
			return [text(input.pattern), text(input.path) || text(input.glob)]
				.filter((part) => part !== "")
				.join(" in ");
		case "Glob":
			return text(input.pattern);
		case "Agent":
		case "Task":
			return text(input.description);
		case "Workflow":
			return item.result?.task?.summary ?? workflowDescription(input);
		case "TodoWrite": {
			const list = todos(input);
			const done = list.filter((todo) => todo.status === "completed").length;
			return `${done}/${list.length} done`;
		}
		case "WebFetch":
			return text(input.url);
		case "WebSearch":
			return text(input.query);
		case "AskUserQuestion": {
			const questions = Array.isArray(input.questions) ? input.questions : [];
			const first = questions[0] as Record<string, unknown> | undefined;
			return text(first?.question);
		}
		case "Skill":
			return text(input.skill) || text(input.command);
		case "SendMessage":
			return text(input.summary) || text(input.to);
		case "Artifact":
			return (
				item.result?.artifact?.title ??
				(text(input.title) || text(input.action) || "publish")
			);
		default: {
			const value = Object.values(input).find(
				(entry): entry is string => typeof entry === "string" && entry !== "",
			);
			return firstLine(value ?? "");
		}
	}
}

export function workflowDescription(input: Record<string, unknown>): string {
	const script = text(input.script);
	const meta = /\bmeta\s*=\s*\{([\s\S]*?)\n\}/.exec(script)?.[1] ?? "";
	const field = (name: string) =>
		new RegExp(`\\b${name}:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(
			meta,
		)?.[2] ?? "";
	return (field("description") || field("name") || "workflow").replace(
		/\\(.)/g,
		"$1",
	);
}

export function toolState(item: ToolItem): ToolState {
	const result = item.result;
	if (!result) return "running";
	if (result.interrupted) return "interrupted";
	if (result.isError && rejectedPattern.test(result.text)) return "rejected";
	if (result.isError || result.task?.status === "failed") return "error";
	return result.task && result.task.status === null ? "background" : "done";
}

export function backgroundTools(items: ConversationItem[]): ToolItem[] {
	return items.filter(
		(item): item is ToolItem =>
			item.kind === "tool" && toolState(item) === "background",
	);
}

export function matchCount(item: ToolItem): number | null {
	if (!item.result || item.result.isError) return null;
	if (item.name !== "Grep" && item.name !== "Glob") return null;
	const found = /^Found (\d+)/.exec(item.result.text)?.[1];
	if (found) return Number(found);
	if (/^No (files|matches) found/.test(item.result.text)) return 0;
	return item.result.text.split("\n").filter((line) => line.trim() !== "")
		.length;
}

export function exitCode(item: ToolItem): number | null {
	if (item.name !== "Bash" || !item.result) return null;
	const code = /^Exit code (\d+)/.exec(item.result.text)?.[1];
	if (code) return Number(code);
	return item.result.isError ? null : 0;
}

export function todos(input: Record<string, unknown>): Todo[] {
	if (!Array.isArray(input.todos)) return [];
	return input.todos.flatMap((value) => {
		const todo = value as Record<string, unknown> | null;
		const content = text(todo?.content);
		return content
			? [{ content, status: text(todo?.status) || "pending" }]
			: [];
	});
}

const lineLimit = 400;

function hunkLines(hunks: PatchHunk[]): DiffLine[] {
	return hunks.flatMap((hunk) => [
		{
			kind: "hunk" as const,
			text: `@@ -${hunk.oldStart} +${hunk.newStart} @@`,
		},
		...hunk.lines.map((line): DiffLine => {
			const marker = line[0];
			const body = line.slice(1);
			if (marker === "+") return { kind: "add", text: body };
			if (marker === "-") return { kind: "del", text: body };
			return { kind: "ctx", text: body };
		}),
	]);
}

export function replacementLines(before: string, after: string): DiffLine[] {
	const old = before.split("\n");
	const next = after.split("\n");
	let head = 0;
	while (head < old.length && head < next.length && old[head] === next[head]) {
		head += 1;
	}
	let tail = 0;
	while (
		tail < old.length - head &&
		tail < next.length - head &&
		old[old.length - 1 - tail] === next[next.length - 1 - tail]
	) {
		tail += 1;
	}
	return [
		...old
			.slice(0, head)
			.map((line): DiffLine => ({ kind: "ctx", text: line })),
		...old
			.slice(head, old.length - tail)
			.map((line): DiffLine => ({ kind: "del", text: line })),
		...next
			.slice(head, next.length - tail)
			.map((line): DiffLine => ({ kind: "add", text: line })),
		...old
			.slice(old.length - tail)
			.map((line): DiffLine => ({ kind: "ctx", text: line })),
	];
}

export function diffLines(item: ToolItem): DiffLine[] | null {
	const { input } = item;
	const lines = (() => {
		if (item.result?.patch) return hunkLines(item.result.patch);
		switch (item.name) {
			case "Edit":
				return replacementLines(text(input.old_string), text(input.new_string));
			case "MultiEdit": {
				const edits = Array.isArray(input.edits) ? input.edits : [];
				return edits.flatMap((edit, at) => {
					const change = edit as Record<string, unknown>;
					return [
						{ kind: "hunk" as const, text: `edit ${at + 1}` },
						...replacementLines(
							text(change.old_string),
							text(change.new_string),
						),
					];
				});
			}
			case "Write":
				return text(input.content)
					.split("\n")
					.map((line): DiffLine => ({ kind: "add", text: line }));
			default:
				return null;
		}
	})();
	return lines ? lines.slice(0, lineLimit) : null;
}

export function diffStats(lines: DiffLine[]): {
	added: number;
	removed: number;
} {
	return {
		added: lines.filter((line) => line.kind === "add").length,
		removed: lines.filter((line) => line.kind === "del").length,
	};
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000)
		return `${Math.round(count / 100) / 10}k`.replace(".0k", "k");
	return `${Math.round(count / 100_000) / 10}M`.replace(".0M", "M");
}

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const modeNames: Record<string, string> = {
	default: "Manual",
	manual: "Manual",
	acceptedits: "Accept edits",
	"accept edits": "Accept edits",
	plan: "Plan",
	bypasspermissions: "Bypass permissions",
	"bypass permissions": "Bypass permissions",
	auto: "Auto",
	dontask: "Don't ask",
};

export function modeLabel(mode: string | null): string | null {
	if (!mode) return null;
	return modeNames[mode.toLowerCase()] ?? mode;
}

export type Queued = { id: string; text: string; sentAt: number };

const comparable = (value: string): string => value.replace(/\s+/g, " ").trim();

export type Outgoing = Queued & {
	state: "queued" | "sending" | "sent" | "echoed";
};

const isCommand = (text: string): boolean => /^[/!]/.test(text.trimStart());

export function nextBatch(outbox: Outgoing[], maxText: number): Outgoing[] {
	if (outbox.some((entry) => entry.state !== "queued")) return [];
	const [head, ...rest] = outbox;
	if (!head) return [];
	const batch = [head];
	if (isCommand(head.text)) return batch;
	let length = head.text.length;
	for (const entry of rest) {
		length += entry.text.length + 1;
		if (isCommand(entry.text) || length > maxText) break;
		batch.push(entry);
	}
	return batch;
}

export function stillQueued<Entry extends Queued>(
	queue: Entry[],
	items: ConversationItem[],
): Entry[] {
	const seen = items.flatMap((item) =>
		item.kind === "user" || item.kind === "command"
			? [
					{
						at: item.at,
						text: comparable(
							item.kind === "user"
								? item.text
								: item.name === "!"
									? `!${item.args}`
									: `${item.name} ${item.args}`,
						),
					},
				]
			: [],
	);
	return queue.filter(
		(entry) =>
			!seen.some(
				(item) =>
					item.at >= entry.sentAt - 5000 &&
					item.text === comparable(entry.text),
			),
	);
}

export function promptHistory(items: ConversationItem[]): string[] {
	const history: string[] = [];
	for (const item of items) {
		const text =
			item.kind === "user"
				? item.text
				: item.kind === "command"
					? item.name === "!"
						? `!${item.args}`
						: `${item.name}${item.args ? ` ${item.args}` : ""}`
					: "";
		if (text.trim() === "") continue;
		if (history.at(-1) !== text) history.push(text);
	}
	return history;
}

export function activeToken(value: string, caret: number): Token | null {
	const before = value.slice(0, caret);
	const slash = /^\/([\w:.-]*)$/.exec(before);
	if (slash) return { kind: "slash", query: slash[1] ?? "", start: 0 };
	const mention = /(^|\s)@([^\s@]*)$/.exec(before);
	if (mention) {
		const query = mention[2] ?? "";
		return { kind: "mention", query, start: caret - query.length - 1 };
	}
	return null;
}

export function complete(
	value: string,
	caret: number,
	token: Token,
	replacement: string,
): { value: string; caret: number } {
	const prefix = token.kind === "slash" ? "/" : "@";
	const spacer =
		replacement.endsWith("/") || /^\s/.test(value.slice(caret)) ? "" : " ";
	const inserted = `${prefix}${replacement}${spacer}`;
	return {
		value: value.slice(0, token.start) + inserted + value.slice(caret),
		caret: token.start + inserted.length,
	};
}

export function sinceParam(epoch: string | null, rev: number): string | null {
	return epoch ? `${epoch}:${rev}` : null;
}
