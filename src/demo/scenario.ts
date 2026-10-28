import type { RegionColours } from "../shared/colours.ts";
import type {
	ConversationItem,
	Dialog,
	ToolResult,
} from "../shared/conversation.ts";
import type {
	Annotations,
	CommentThread,
	Layout,
	Link,
	Message,
	NodeRef,
	Region,
	Session,
	Subagent,
} from "../shared/types.ts";

export const minute = 60_000;

export type Turn =
	| { user: string }
	| { assistant: string }
	| { thinking: string }
	| { peer: string; from: string }
	| { notice: string; level?: "info" | "warning" | "error" }
	| {
			tool: string;
			input: Record<string, unknown>;
			result?: string;
			error?: boolean;
			agentId?: string;
	  };

export type DemoWorkflow = {
	runId: string;
	sessionId: string;
	name: string;
	agents: string[];
};

export type World = {
	sessions: Session[];
	subagents: Subagent[];
	workflows: DemoWorkflow[];
	links: Link[];
	messages: Message[];
	layout: Layout;
	regions: Region[];
	colours: RegionColours;
	annotations: Annotations;
	comments: CommentThread[];
	stories: Record<string, Turn[]>;
	files: Record<string, string[]>;
};

export type Stage = {
	add(session: Session, story?: Turn[], from?: Link): void;
	update(id: string, patch: Partial<Session>, turn?: Turn): void;
	spawn(subagent: Subagent): void;
	finish(id: string, result: string): void;
	message(from: NodeRef, to: NodeRef, summary: string): void;
	colour(cwd: string, colour: RegionColours[string]): void;
	annotate(annotations: Annotations): void;
	exit(id: string): void;
};

export type Step = { at: number; run(stage: Stage): void };

export type Scenario = {
	world(start: number): World;
	timeline: Step[];
	ambient?: { every: number; steps: ((stage: Stage) => void)[] };
};

export const s = (id: string): NodeRef => ({ kind: "session", id });
export const a = (id: string): NodeRef => ({ kind: "subagent", id });

export const sessionKey = (id: string) => `session:${id}`;
export const subagentKey = (id: string) => `subagent:${id}`;

export function session(
	start: number,
	partial: Partial<Session> & Pick<Session, "id" | "name" | "project">,
): Session {
	return {
		short: partial.id.slice(0, 8),
		pid: 40000 + Number.parseInt(partial.id.slice(0, 4), 16),
		cwd: `/Users/me/dev/${partial.project}`,
		kind: "background",
		activity: "idle",
		doing: null,
		needs: null,
		goal: null,
		startedAt: start - 90 * minute,
		updatedAt: start - 2 * minute,
		attachable: true,
		cmux: false,
		artifacts: [],
		...partial,
	};
}

export function subagent(
	start: number,
	partial: Partial<Subagent> & Pick<Subagent, "id" | "sessionId" | "type">,
): Subagent {
	return {
		kind: "agent",
		parentAgentId: null,
		description: "",
		live: false,
		done: false,
		startedAt: start - 30 * minute,
		updatedAt: start - 5 * minute,
		...partial,
	};
}

export const toolResult = (
	text: string,
	at: number,
	extra: Partial<ToolResult> = {},
): ToolResult => ({
	text,
	isError: false,
	images: 0,
	truncated: false,
	patch: null,
	agentId: null,
	answers: null,
	interrupted: false,
	artifact: null,
	task: null,
	at,
	...extra,
});

export function itemsOf(
	turns: readonly Turn[],
	from: number,
	to: number,
	first = 0,
): ConversationItem[] {
	const step = turns.length > 1 ? (to - from) / (turns.length - 1) : 0;
	return turns.map((turn, offset) => {
		const index = first + offset;
		const at = Math.round(from + step * offset);
		const placed = { index, rev: 1, at };
		if ("user" in turn)
			return {
				...placed,
				kind: "user",
				text: turn.user,
				images: 0,
				queued: false,
			};
		if ("assistant" in turn)
			return { ...placed, kind: "assistant", text: turn.assistant };
		if ("thinking" in turn)
			return {
				...placed,
				kind: "thinking",
				text: turn.thinking,
				durationMs: 4200,
			};
		if ("peer" in turn)
			return { ...placed, kind: "peer", from: turn.from, text: turn.peer };
		if ("notice" in turn)
			return {
				...placed,
				kind: "notice",
				level: turn.level ?? "info",
				text: turn.notice,
			};
		return {
			...placed,
			kind: "tool",
			id: `toolu_${index.toString(36).padStart(4, "0")}`,
			name: turn.tool,
			input: turn.input,
			result:
				turn.result === undefined
					? null
					: toolResult(turn.result, at, {
							isError: turn.error === true,
							agentId: turn.agentId ?? null,
						}),
		};
	});
}

const permissionOptions = [
	"Yes",
	"Yes, and don't ask again for this command",
	"No, and tell Claude what to do differently",
];

export function dialogOf(
	session: Session | null,
	items: readonly ConversationItem[],
): Dialog | null {
	if (session?.activity !== "needs-you") return null;
	const pending = items.findLast(
		(item): item is Extract<ConversationItem, { kind: "tool" }> =>
			item.kind === "tool" && item.result === null,
	);
	if (!pending) return null;
	if (pending.name === "AskUserQuestion") {
		const questions = pending.input.questions;
		return Array.isArray(questions)
			? {
					kind: "question",
					toolUseId: pending.id,
					questions: questions as Extract<
						Dialog,
						{ kind: "question" }
					>["questions"],
				}
			: null;
	}
	return {
		kind: "permission",
		toolUseId: pending.id,
		title: pending.name,
		context: null,
		question: session.needs ?? "Do you want to proceed?",
		options: permissionOptions,
		complete: true,
	};
}

const bash = (command: string, description: string, output?: string): Turn =>
	output === undefined
		? { tool: "Bash", input: { command, description } }
		: { tool: "Bash", input: { command, description }, result: output };

const read = (file: string, lines: number): Turn => ({
	tool: "Read",
	input: { file_path: file },
	result: `${lines} lines`,
});

export function closing(session: Session): Turn[] {
	const doing = session.doing ?? "Working";
	switch (session.activity) {
		case "working": {
			const command = /^Running (.+)/.exec(doing)?.[1];
			const file = /^Editing (\S+)/.exec(doing)?.[1];
			const next: Turn[] = command
				? [bash(command, doing)]
				: file
					? [{ tool: "Edit", input: { file_path: `${session.cwd}/${file}` } }]
					: [];
			return [{ assistant: `${doing}.` }, ...next];
		}
		case "needs-you":
			return [
				{
					assistant:
						"Everything is ready. This next step needs your go-ahead first.",
				},
				bash(
					session.needs?.match(/`([^`]+)`/)?.[1] ?? "npm run deploy",
					session.needs ?? "Run the next step",
				),
			];
		case "failed":
			return [
				{
					tool: "Bash",
					input: { command: "npm test", description: "Run the test suite" },
					result: `Exit code 1\n${doing}`,
					error: true,
				},
				{ assistant: `${doing}. Stopping here so you can take a look.` },
			];
		case "stopped":
			return [{ notice: "Interrupted by the user", level: "warning" }];
		case "done":
			return [{ assistant: `Done. ${doing}.` }];
		case "watching":
			return [{ assistant: `${doing}. I will check back once it finishes.` }];
		case "idle":
			return [{ assistant: `${doing}. What would you like next?` }];
	}
}

export function storyOf(
	session: Session,
	subagents: readonly Subagent[],
	files: readonly string[],
): Turn[] {
	const goal = session.goal ?? session.name;
	const [first = "README.md", second = "package.json"] = files;
	return [
		{ user: goal },
		{
			thinking: `The goal is "${goal}". Start by reading the code that owns it, then make the change and verify it.`,
		},
		{ assistant: `I'll start by reading \`${first}\` and its tests.` },
		read(`${session.cwd}/${first}`, 184),
		{
			tool: "Grep",
			input: { pattern: goal.split(" ").at(-1) ?? "TODO", path: "src" },
			result: `Found 4 files\nsrc/${first}\nsrc/${second}`,
		},
		...subagents.map(
			(agent): Turn => ({
				tool: "Task",
				input: {
					description: agent.description,
					subagent_type: agent.type,
					prompt: `${agent.description}. Report back with what you find.`,
				},
				...(agent.live
					? {}
					: {
							result: `${agent.description}: ${agent.done ? "finished" : "paused"}.`,
							agentId: agent.id,
						}),
			}),
		),
		{
			tool: "Edit",
			input: {
				file_path: `${session.cwd}/${second}`,
				old_string: "export const enabled = false;",
				new_string: "export const enabled = true;",
			},
			result: "The file has been updated.",
		},
		...closing(session),
	];
}

export function subagentStory(agent: Subagent, cwd: string): Turn[] {
	const description = agent.description || agent.type;
	const steps: Turn[] = [
		{ user: `${description}. Report back with what you find.` },
		{
			tool: "Glob",
			input: { pattern: "src/**/*.ts" },
			result: "src/index.ts\nsrc/routes.ts\nsrc/store.ts",
		},
		read(`${cwd}/src/routes.ts`, 96),
	];
	if (agent.live)
		return [
			...steps,
			{
				tool: "Grep",
				input: { pattern: "export function", path: "src" },
			},
		];
	return [
		...steps,
		{
			assistant: agent.done
				? `${description}: done. Three call sites need the change; the details are in the summary above.`
				: `${description}: paused, waiting for the parent session.`,
		},
	];
}
