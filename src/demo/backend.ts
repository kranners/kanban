import type { RegionColour } from "../shared/colours.ts";
import type {
	ConversationClientFrame,
	ConversationItem,
	ConversationServerFrame,
	ConversationStatus,
	Dialog,
	Drive,
	ToolResult,
} from "../shared/conversation.ts";
import {
	outstandingStates,
	subagentCountsBySession,
} from "../shared/subagents.ts";
import type {
	AttachClientFrame,
	Board,
	BoardFeed,
	CommentThread,
	ExitResult,
	MirrorClientFrame,
	MirrorServerFrame,
	NewSessionRequest,
	NodeRef,
	Placement,
	Region,
	Session,
	Subagent,
} from "../shared/types.ts";
import {
	closing,
	dialogOf,
	itemsOf,
	type Scenario,
	type Stage,
	session as sessionOf,
	storyOf,
	subagentKey,
	subagentStory,
	type Turn,
	toolResult,
	type World,
} from "./scenario.ts";

export type Peer = { send(data: string | ArrayBuffer): void; close(): void };

export type Channel = { receive(data: string): void; close(): void };

export type Opener = (peer: Peer) => Channel;

export type Backend = {
	fetch(
		method: string,
		path: string,
		query: URLSearchParams,
		body: unknown,
	): Response;
	socket(path: string): Opener | null;
	stage: Stage;
	play(): Promise<void>;
	stop(): void;
	duration: number;
};

type Conversation = {
	node: NodeRef;
	items: ConversationItem[];
	rev: number;
	dialog: Dialog | null;
	viewers: Set<Peer>;
};

const demoReply =
	"This is the demo board, so the sessions and their replies are made up. On a real board your prompt goes straight to the session.";

const commands = [
	["bg", "Continue this conversation in the background"],
	["clear", "Clear the conversation and start fresh"],
	["compact", "Summarise the conversation to free up context"],
	["context", "Show how the context window is used"],
	["cost", "Show usage and cost"],
	["init", "Write a CLAUDE.md for this project"],
	["model", "Choose the model"],
	["review", "Review a pull request"],
	["security-review", "Review pending changes for security issues"],
	["todos", "Show the todo list"],
].map(([name, description]) => ({ name, description, source: "built-in" }));

const conversationSpan = 12 * 60_000;

const fallbackFiles = [
	"README.md",
	"package.json",
	"src/index.ts",
	"src/config.ts",
	"test/index.test.ts",
];

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});

const empty = (status: number): Response => new Response(null, { status });

const notFound = () => json(404, { error: "Not Found" });

type ToolItem = Extract<ConversationItem, { kind: "tool" }>;

const key = (ref: NodeRef) => `${ref.kind}:${ref.id}`;

const driveOf = (session: Session): Drive => {
	if (session.kind === "background")
		return session.attachable && session.short
			? { mode: "drive", via: "attach" }
			: { mode: "read", reason: "This background session cannot be attached" };
	return session.cmux
		? { mode: "drive", via: "cmux" }
		: {
				mode: "read",
				reason:
					"Started in a terminal outside cmux, so it can only be read here.",
			};
};

const branchOf = (cwd: string) =>
	cwd.includes("/worktrees/") ? (cwd.split("/").at(-1) ?? "main") : "main";

const pendingTools = (items: readonly ConversationItem[]) =>
	items.flatMap((item) =>
		item.kind === "tool" && item.result === null ? [item.id] : [],
	);

const firstLine = (text: string) => text.split("\n")[0] ?? "";

function screenOf(items: readonly ConversationItem[], newline: string): string {
	const lines = items.flatMap((item): string[] => {
		switch (item.kind) {
			case "user":
				return [`> ${item.text}`, ""];
			case "assistant":
				return [`● ${item.text}`, ""];
			case "peer":
				return [`● Message from ${item.from}: ${item.text}`, ""];
			case "tool": {
				const detail = Object.values(item.input).find(
					(value): value is string => typeof value === "string",
				);
				const outcome = item.result
					? `  ⎿  ${firstLine(item.result.text)}`
					: "  ⎿  Running…";
				return [`● ${item.name}(${firstLine(detail ?? "")})`, outcome, ""];
			}
			case "notice":
				return [`  ${item.text}`, ""];
			default:
				return [];
		}
	});
	return lines.join(newline);
}

export function createBackend(scenario: Scenario): Backend {
	let world: World = scenario.world(Date.now());
	let conversations = new Map<string, Conversation>();
	const feeds = new Set<Peer>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let boardQueued = false;
	let count = 0;

	const later = (ms: number, run: () => void) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			run();
		}, ms);
		timers.add(timer);
	};

	const next = () => {
		count += 1;
		return count;
	};

	const sendFrame = (peer: Peer, frame: BoardFeed | ConversationServerFrame) =>
		peer.send(JSON.stringify(frame));

	const broadcast = (frame: BoardFeed) => {
		for (const peer of feeds) sendFrame(peer, frame);
	};

	const sessionById = (id: string) =>
		world.sessions.find((session) => session.id === id) ?? null;

	const nameOf = (ref: NodeRef) =>
		ref.kind === "session"
			? (sessionById(ref.id)?.name ?? "a session")
			: (world.subagents.find((agent) => agent.id === ref.id)?.description ??
				"a subagent");

	const snapshot = (): Board => {
		const live = new Set(world.sessions.map((item) => item.id));
		const subagents = world.subagents.filter((item) =>
			live.has(item.sessionId),
		);
		const nodes = new Set([...live, ...subagents.map((item) => item.id)]);
		const connects = (edge: { from: NodeRef; to: NodeRef }) =>
			nodes.has(edge.from.id) && nodes.has(edge.to.id);
		return {
			sessions: [...world.sessions],
			subagents,
			subagentCounts: subagentCountsBySession(subagents),
			subagentStates: outstandingStates(subagents),
			workflowRuns: Object.fromEntries(
				world.workflows.map((run) => [run.runId, run.agents]),
			),
			workflows: world.workflows.flatMap((run) => {
				const started = subagents.filter((agent) =>
					run.agents.includes(agent.id),
				);
				const done = started.filter((agent) => agent.done).length;
				if (!live.has(run.sessionId) || done === started.length) return [];
				return [
					{
						runId: run.runId,
						sessionId: run.sessionId,
						name: run.name,
						done,
						total: started.length,
					},
				];
			}),
			links: world.links.filter(connects),
			messages: world.messages.filter(connects),
			generatedAt: Date.now(),
		};
	};

	const boardChanged = () => {
		if (boardQueued) return;
		boardQueued = true;
		queueMicrotask(() => {
			boardQueued = false;
			broadcast({ type: "board", board: snapshot() });
		});
	};

	const statusOf = (conversation: Conversation): ConversationStatus => {
		const session =
			conversation.node.kind === "session"
				? sessionById(conversation.node.id)
				: null;
		const owner =
			session ??
			sessionById(
				world.subagents.find((agent) => agent.id === conversation.node.id)
					?.sessionId ?? "",
			);
		const { items } = conversation;
		const lastPrompt = items.findLast((item) => item.kind === "user");
		return {
			model:
				conversation.node.kind === "session"
					? "claude-opus-5-5"
					: "claude-sonnet-5-5",
			cwd: owner?.cwd ?? null,
			branch: owner ? branchOf(owner.cwd) : null,
			permissionMode: "default",
			contextTokens: 18_000 + items.length * 2_400,
			outputTokens: items.length * 610,
			turnStartedAt:
				session?.activity === "working" ? (lastPrompt?.at ?? null) : null,
			pendingTools: pendingTools(items),
		};
	};

	const send = (conversation: Conversation, frame: ConversationServerFrame) => {
		for (const viewer of conversation.viewers) sendFrame(viewer, frame);
	};

	const syncDialog = (conversation: Conversation) => {
		if (conversation.node.kind !== "session") return;
		const dialog = dialogOf(
			sessionById(conversation.node.id),
			conversation.items,
		);
		if (JSON.stringify(dialog) === JSON.stringify(conversation.dialog)) return;
		conversation.dialog = dialog;
		send(conversation, { type: "dialog", dialog, answerable: dialog !== null });
	};

	const createConversation = (
		node: NodeRef,
		turns: Turn[],
		span: { startedAt: number; updatedAt: number },
	) => {
		const from = Math.max(span.startedAt, span.updatedAt - conversationSpan);
		const conversation: Conversation = {
			node,
			items: itemsOf(turns, from, span.updatedAt),
			rev: 1,
			dialog: null,
			viewers: new Set(),
		};
		conversation.dialog =
			node.kind === "session"
				? dialogOf(sessionById(node.id), conversation.items)
				: null;
		conversations.set(key(node), conversation);
		return conversation;
	};

	const filesOf = (session: Session) =>
		world.files[session.project] ?? fallbackFiles;

	const storyFor = (session: Session) =>
		world.stories[`session:${session.id}`] ??
		storyOf(
			session,
			world.subagents.filter((agent) => agent.sessionId === session.id),
			filesOf(session),
		);

	const subagentStoryFor = (agent: Subagent) =>
		world.stories[subagentKey(agent.id)] ??
		subagentStory(agent, sessionById(agent.sessionId)?.cwd ?? "/Users/me/dev");

	const load = (next: World) => {
		world = next;
		conversations = new Map();
		for (const session of world.sessions)
			createConversation(
				{ kind: "session", id: session.id },
				storyFor(session),
				session,
			);
		for (const agent of world.subagents)
			createConversation(
				{ kind: "subagent", id: agent.id },
				subagentStoryFor(agent),
				agent,
			);
	};

	const publish = (conversation: Conversation, items: ConversationItem[]) => {
		send(conversation, {
			type: "items",
			epoch: key(conversation.node),
			rev: conversation.rev,
			total: conversation.items.length,
			first: -1,
			reset: false,
			items,
		});
		send(conversation, { type: "status", status: statusOf(conversation) });
	};

	const append = (node: NodeRef, turns: Turn[]) => {
		const conversation = conversations.get(key(node));
		if (!conversation || turns.length === 0) return;
		const at = Date.now();
		conversation.rev += 1;
		const added = itemsOf(turns, at, at, conversation.items.length).map(
			(item) => ({ ...item, rev: conversation.rev }),
		);
		conversation.items.push(...added);
		publish(conversation, added);
		syncDialog(conversation);
	};

	const resolve = (
		node: NodeRef,
		picks: (item: ToolItem) => boolean,
		result: ToolResult,
	) => {
		const conversation = conversations.get(key(node));
		if (!conversation) return;
		const picked = conversation.items.filter(
			(item): item is ToolItem =>
				item.kind === "tool" && item.result === null && picks(item),
		);
		if (picked.length === 0) return;
		conversation.rev += 1;
		const resolved = picked.map((item) => ({
			...item,
			rev: conversation.rev,
			result,
		}));
		for (const item of resolved) conversation.items[item.index] = item;
		publish(conversation, resolved);
	};

	const settle = (
		node: NodeRef,
		text: string,
		extra: Partial<ToolResult> = {},
	) =>
		resolve(
			node,
			(item) => item.name !== "Task",
			toolResult(text, Date.now(), extra),
		);

	const update = (id: string, patch: Partial<Session>, narrate = true) => {
		const index = world.sessions.findIndex((item) => item.id === id);
		const current = world.sessions[index];
		if (!current) return;
		const updated = { ...current, updatedAt: Date.now(), ...patch };
		world.sessions[index] = updated;
		boardChanged();
		const node: NodeRef = { kind: "session", id };
		if (narrate && patch.activity && patch.activity !== current.activity) {
			settle(node, current.activity === "needs-you" ? "Approved" : "Done");
			append(node, closing(updated));
		}
		const conversation = conversations.get(key(node));
		if (conversation) {
			send(conversation, { type: "status", status: statusOf(conversation) });
			send(conversation, { type: "drive", drive: driveOf(updated) });
			syncDialog(conversation);
		}
	};

	const removeSession = (id: string) => {
		world.sessions = world.sessions.filter((item) => item.id !== id);
		const conversation = conversations.get(key({ kind: "session", id }));
		if (conversation)
			send(conversation, {
				type: "drive",
				drive: { mode: "read", reason: "The session has left the board" },
			});
		boardChanged();
	};

	const stage: Stage = {
		add(session, story, from) {
			world.sessions.push(session);
			if (from) world.links.push(from);
			createConversation(
				{ kind: "session", id: session.id },
				story ?? storyFor(session),
				session,
			);
			boardChanged();
		},
		update: (id, patch) => update(id, patch),
		spawn(agent) {
			world.subagents.push(agent);
			world.links.push({
				from: { kind: "session", id: agent.sessionId },
				to: { kind: "subagent", id: agent.id },
				kind: "subagent",
			});
			createConversation(
				{ kind: "subagent", id: agent.id },
				subagentStoryFor(agent),
				agent,
			);
			append({ kind: "session", id: agent.sessionId }, [
				{
					tool: "Task",
					input: {
						description: agent.description,
						subagent_type: agent.type,
						prompt: `${agent.description}. Report back with what you find.`,
					},
				},
			]);
			boardChanged();
		},
		finish(id, summary) {
			const index = world.subagents.findIndex((agent) => agent.id === id);
			const agent = world.subagents[index];
			if (!agent) return;
			world.subagents[index] = {
				...agent,
				live: false,
				done: true,
				updatedAt: Date.now(),
			};
			const node: NodeRef = { kind: "subagent", id };
			settle(node, "Done");
			append(node, [{ assistant: summary }]);
			resolve(
				{ kind: "session", id: agent.sessionId },
				(item) =>
					item.name === "Task" && item.input.description === agent.description,
				toolResult(summary, Date.now(), { agentId: id }),
			);
			boardChanged();
		},
		message(from, to, summary) {
			world.messages.push({
				id: `m${next()}`,
				from,
				to,
				at: Date.now(),
				summary,
			});
			append(from, [
				{
					tool: "SendMessage",
					input: { to: nameOf(to), summary },
					result: "Sent",
				},
			]);
			append(to, [{ peer: summary, from: nameOf(from) }]);
			boardChanged();
		},
		colour(cwd, colour) {
			world.colours = { ...world.colours, [cwd]: colour };
			broadcast({ type: "colours", colours: world.colours });
		},
		annotate(annotations) {
			world.annotations = { ...world.annotations, ...annotations };
			broadcast({ type: "annotations", annotations: world.annotations });
		},
		exit(id) {
			removeSession(id);
			later(400, () =>
				broadcast({
					type: "exit",
					sessionId: id,
					result: { ok: true, exited: true },
				}),
			);
		},
	};

	const ambient = scenario.ambient;
	let round = 0;
	const chatter = ambient
		? setInterval(() => {
				ambient.steps[round % ambient.steps.length]?.(stage);
				round += 1;
			}, ambient.every)
		: undefined;

	const notReady = (session: Session): string | null => {
		if (session.activity === "working")
			return `It is still working: ${session.doing ?? "a turn is running"}.`;
		if (session.activity === "needs-you")
			return `It is waiting on you: ${session.needs ?? "a prompt is open"}.`;
		return null;
	};

	const exitSession = (id: string, body: unknown): Response => {
		const force = (body as { force?: unknown } | null)?.force;
		if (typeof force !== "boolean")
			return json(400, { ok: false, error: "force must be a boolean" });
		const session = sessionById(id);
		if (!session) return notFound();
		later(1500, () => {
			const current = sessionById(id);
			const reason = current ? notReady(current) : null;
			const result: ExitResult = !current
				? { ok: false, error: "This session is no longer on the board" }
				: reason && !force
					? { ok: true, exited: false, reason }
					: { ok: true, exited: true };
			if (result.ok && result.exited) removeSession(id);
			later(400, () => broadcast({ type: "exit", sessionId: id, result }));
		});
		return json(202, { ok: true });
	};

	const reportSession = (id: string): Response => {
		if (!sessionById(id)) return notFound();
		later(1500, () =>
			broadcast({ type: "report", sessionId: id, result: { ok: true } }),
		);
		return json(202, { ok: true });
	};

	const createSession = (body: unknown): Response => {
		const request = body as Partial<NewSessionRequest> | null;
		const prompt = request?.prompt?.trim() ?? "";
		const cwd = request?.cwd?.trim() ?? "";
		if (!cwd.startsWith("/"))
			return json(400, { ok: false, error: "cwd must be an absolute path" });
		if (prompt === "")
			return json(400, { ok: false, error: "Type a prompt to start with" });
		const id = (0xd0c0_0000 + next()).toString(16).padEnd(12, "0");
		const created = sessionOf(Date.now(), {
			id,
			name: request?.name?.trim() || prompt.slice(0, 40),
			project: cwd.split("/").at(-1) || "acme-api",
			cwd,
			goal: prompt,
			activity: "working",
			doing: "Reading the codebase",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
		later(1200, () => {
			const at = request?.at;
			if (at) {
				world.layout = { ...world.layout, [`session:${id}`]: at };
				broadcast({ type: "layout", layout: world.layout });
			}
			stage.add(created, [
				{ user: prompt },
				{ tool: "Glob", input: { pattern: "**/*" } },
			]);
			later(4000, () => {
				update(id, { activity: "idle", doing: "Replied to the prompt" }, false);
				settle({ kind: "session", id }, "README.md\npackage.json\nsrc/");
				append({ kind: "session", id }, [{ assistant: demoReply }]);
			});
		});
		return json(201, { ok: true, short: created.short });
	};

	const updateThread = (
		id: string,
		change: (thread: CommentThread) => CommentThread,
	): CommentThread | null => {
		const index = world.comments.findIndex((thread) => thread.id === id);
		const current = world.comments[index];
		if (!current) return null;
		const updated = { ...change(current), id, updatedAt: Date.now() };
		world.comments[index] = updated;
		broadcast({ type: "comment", comment: updated });
		return updated;
	};

	const waitingSummary = () => {
		const total = world.sessions.length;
		const waiting = world.sessions.filter(
			(item) => item.activity === "needs-you",
		);
		if (waiting.length === 0)
			return `None of the ${total} sessions is waiting on you right now.`;
		const lines = waiting.map(
			(item) => `“${item.name}” asks: ${item.needs ?? item.doing}`,
		);
		return `${waiting.length} of ${total} sessions ${waiting.length === 1 ? "is" : "are"} waiting on you. ${lines.join(" ")}`;
	};

	const ask = (id: string, text: string) => {
		const action = `a${next()}`;
		updateThread(id, (thread) => ({
			...thread,
			running: true,
			resolved: false,
			events: [...thread.events, { kind: "user", at: Date.now(), text }],
		}));
		later(700, () =>
			updateThread(id, (thread) => ({
				...thread,
				events: [
					...thread.events,
					{
						kind: "action",
						at: Date.now(),
						id: action,
						text: "Reading the board",
						state: "running",
					},
				],
			})),
		);
		later(1900, () =>
			updateThread(id, (thread) => ({
				...thread,
				running: false,
				events: [
					...thread.events.map((event) =>
						event.kind === "action" && event.id === action
							? {
									...event,
									state: "done" as const,
									text: `Read ${world.sessions.length} sessions`,
								}
							: event,
					),
					{
						kind: "reply",
						at: Date.now(),
						text: waitingSummary(),
					},
				],
			})),
		);
	};

	const createComment = (body: unknown): Response => {
		const draft = body as { x?: unknown; y?: unknown; text?: unknown } | null;
		if (
			typeof draft?.x !== "number" ||
			typeof draft.y !== "number" ||
			typeof draft.text !== "string" ||
			draft.text.trim() === ""
		)
			return json(400, { ok: false, error: "x, y and text are required" });
		const at = Date.now();
		const n = next();
		const thread: CommentThread = {
			id: `c${n}`,
			x: draft.x,
			y: draft.y,
			createdAt: at,
			updatedAt: at,
			resolved: false,
			running: false,
			sessionId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
			resumable: false,
			events: [],
		};
		world.comments.push(thread);
		broadcast({ type: "comment", comment: thread });
		ask(thread.id, draft.text);
		return json(
			201,
			world.comments.find((item) => item.id === thread.id) ?? thread,
		);
	};

	const boardKeys = () =>
		new Set([
			...world.sessions.map((item) => `session:${item.id}`),
			...world.subagents.map((item) => subagentKey(item.id)),
		]);

	const routes: [
		string,
		RegExp,
		(match: string[], body: unknown, query: URLSearchParams) => Response,
	][] = [
		["POST", /^\/api\/sessions$/, (_, body) => createSession(body)],
		[
			"POST",
			/^\/api\/accounts\/default$/,
			() =>
				json(200, {
					ok: false,
					error: "The demo runs on one account",
				}),
		],
		[
			"POST",
			/^\/api\/folder-picker$/,
			() =>
				json(200, {
					ok: false,
					error: "The demo can't open a folder picker; choose a recent project",
				}),
		],
		[
			"POST",
			/^\/api\/sessions\/([^/]+)\/exit$/,
			([id = ""], body) => exitSession(id, body),
		],
		[
			"POST",
			/^\/api\/sessions\/([^/]+)\/report$/,
			([id = ""]) => reportSession(id),
		],
		[
			"GET",
			/^\/api\/sessions\/([^/]+)\/files$/,
			([id = ""], _, query) => {
				const session = sessionById(id);
				if (!session) return notFound();
				const q = (query.get("q") ?? "").toLowerCase();
				return json(200, {
					ok: true,
					files: filesOf(session)
						.filter((file) => file.toLowerCase().includes(q))
						.slice(0, 50),
				});
			},
		],
		[
			"GET",
			/^\/api\/sessions\/([^/]+)\/commands$/,
			([id = ""]) => (sessionById(id) ? json(200, commands) : notFound()),
		],
		[
			"PUT",
			/^\/api\/layout$/,
			(_, body) => {
				const update = body as { key?: unknown; placement?: Placement } | null;
				if (typeof update?.key !== "string" || !update.placement)
					return json(400, {
						ok: false,
						error: "key and placement are required",
					});
				if (!boardKeys().has(update.key)) return notFound();
				world.layout = { ...world.layout, [update.key]: update.placement };
				broadcast({ type: "layout", layout: world.layout });
				return empty(204);
			},
		],
		[
			"PUT",
			/^\/api\/annotations\/([^/]+)$/,
			([id = ""], body) => {
				world.annotations = {
					...world.annotations,
					[id]: { ...(body as object), id } as World["annotations"][string],
				};
				broadcast({ type: "annotations", annotations: world.annotations });
				return empty(204);
			},
		],
		[
			"DELETE",
			/^\/api\/annotations\/([^/]+)$/,
			([id = ""]) => {
				if (!world.annotations[id]) return notFound();
				const { [id]: _removed, ...rest } = world.annotations;
				world.annotations = rest;
				broadcast({ type: "annotations", annotations: world.annotations });
				return empty(204);
			},
		],
		[
			"PUT",
			/^\/api\/colours$/,
			(_, body) => {
				const update = body as { cwd?: unknown; colour?: RegionColour | null };
				if (typeof update?.cwd !== "string")
					return json(400, { ok: false, error: "cwd is required" });
				const { [update.cwd]: _previous, ...rest } = world.colours;
				world.colours = update.colour
					? { ...rest, [update.cwd]: update.colour }
					: rest;
				broadcast({ type: "colours", colours: world.colours });
				return empty(204);
			},
		],
		[
			"POST",
			/^\/api\/regions$/,
			(_, body) => {
				const draft = body as Omit<Region, "id" | "name"> & { name?: string };
				if (typeof draft?.cwd !== "string" || !draft.cwd.startsWith("/"))
					return json(400, {
						ok: false,
						error: "cwd must be an absolute path",
					});
				const region: Region = { id: `region-${next()}`, name: null, ...draft };
				world.regions = [...world.regions, region];
				broadcast({ type: "regions", regions: world.regions });
				return json(201, region);
			},
		],
		[
			"PATCH",
			/^\/api\/regions\/([^/]+)$/,
			([id = ""], body) => {
				const existing = world.regions.find((region) => region.id === id);
				if (!existing) return notFound();
				const updated = { ...existing, ...(body as object), id };
				world.regions = world.regions.map((region) =>
					region.id === id ? updated : region,
				);
				broadcast({ type: "regions", regions: world.regions });
				return json(200, updated);
			},
		],
		[
			"DELETE",
			/^\/api\/regions\/([^/]+)$/,
			([id = ""]) => {
				if (!world.regions.some((region) => region.id === id))
					return notFound();
				world.regions = world.regions.filter((region) => region.id !== id);
				broadcast({ type: "regions", regions: world.regions });
				return empty(204);
			},
		],
		[
			"POST",
			/^\/api\/regions\/([^/]+)\/report$/,
			([id = ""]) => {
				if (!world.regions.some((region) => region.id === id))
					return notFound();
				later(1500, () =>
					broadcast({
						type: "region-report",
						regionId: id,
						result: { ok: true },
					}),
				);
				return json(202, { ok: true });
			},
		],
		["POST", /^\/api\/comments$/, (_, body) => createComment(body)],
		[
			"POST",
			/^\/api\/comments\/([^/]+)\/messages$/,
			([id = ""], body) => {
				const text = (body as { text?: unknown } | null)?.text;
				if (typeof text !== "string" || text.trim() === "")
					return json(400, { ok: false, error: "text is required" });
				if (!world.comments.some((thread) => thread.id === id))
					return notFound();
				ask(id, text);
				return json(202, { ok: true });
			},
		],
		[
			"POST",
			/^\/api\/comments\/([^/]+)\/cancel$/,
			([id = ""]) =>
				updateThread(id, (thread) => ({ ...thread, running: false }))
					? empty(204)
					: notFound(),
		],
		[
			"PATCH",
			/^\/api\/comments\/([^/]+)$/,
			([id = ""], body) => {
				const updated = updateThread(id, (thread) => ({
					...thread,
					...(body as object),
				}));
				return updated ? json(200, updated) : notFound();
			},
		],
		[
			"DELETE",
			/^\/api\/comments\/([^/]+)$/,
			([id = ""]) => {
				if (!world.comments.some((thread) => thread.id === id))
					return notFound();
				world.comments = world.comments.filter((thread) => thread.id !== id);
				broadcast({ type: "comments", comments: world.comments });
				return empty(204);
			},
		],
	];

	const feed: Opener = (peer) => {
		feeds.add(peer);
		sendFrame(peer, { type: "layout", layout: world.layout });
		sendFrame(peer, { type: "annotations", annotations: world.annotations });
		sendFrame(peer, { type: "colours", colours: world.colours });
		sendFrame(peer, { type: "regions", regions: world.regions });
		sendFrame(peer, { type: "comments", comments: world.comments });
		sendFrame(peer, { type: "digests", digests: world.digests });
		sendFrame(peer, { type: "board", board: snapshot() });
		return { receive() {}, close: () => feeds.delete(peer) };
	};

	const reply = (peer: Peer, id: string, error: string | null) =>
		sendFrame(peer, { type: "done", id, ok: error === null, error });

	const respond = (session: Session, text: string) => {
		const node: NodeRef = { kind: "session", id: session.id };
		update(session.id, { activity: "working", doing: "Thinking" }, false);
		append(node, [{ user: text }]);
		later(1600, () => {
			settle(node, "Interrupted", { interrupted: true });
			append(node, [{ assistant: demoReply }]);
			update(
				session.id,
				{ activity: "idle", doing: "Replied to your prompt" },
				false,
			);
		});
	};

	const resume = (
		session: Session,
		approved: boolean,
		answers?: Record<string, string>,
	) => {
		const node: NodeRef = { kind: "session", id: session.id };
		if (!approved) {
			settle(node, "The user doesn't want to proceed with this tool use.", {
				isError: true,
			});
			update(
				session.id,
				{ activity: "idle", doing: "Waiting for new directions", needs: null },
				false,
			);
			append(node, [
				{
					assistant: "Understood, I won't run that. What should I do instead?",
				},
			]);
			return;
		}
		const command = session.needs?.match(/`([^`]+)`/)?.[1];
		settle(
			node,
			answers ? "User answered" : "Exit code 0",
			answers ? { answers } : {},
		);
		update(
			session.id,
			{
				activity: "working",
				doing: command ? `Running ${command}` : "Carrying on after your answer",
				needs: null,
			},
			false,
		);
		append(node, [{ assistant: "Thanks, carrying on." }]);
		later(2400, () =>
			update(session.id, {
				activity: "done",
				doing: command ? `Ran ${command}` : "Wrapped up after your answer",
			}),
		);
	};

	const handle = (
		conversation: Conversation,
		peer: Peer,
		frame: ConversationClientFrame,
	) => {
		if (frame.type === "more") {
			sendFrame(peer, { type: "older", first: 0, items: [] });
			return;
		}
		const session =
			conversation.node.kind === "session"
				? sessionById(conversation.node.id)
				: null;
		if (conversation.node.kind === "subagent")
			return reply(peer, frame.id, "Subagents can only be read");
		if (!session)
			return reply(peer, frame.id, "The session has left the board");
		const drive = driveOf(session);
		if (drive.mode === "read") return reply(peer, frame.id, drive.reason);
		const dialog = conversation.dialog;
		switch (frame.type) {
			case "prompt":
				if (frame.text.trim() === "")
					return reply(peer, frame.id, "Type something to send");
				if (dialog)
					return reply(
						peer,
						frame.id,
						"The session is waiting on a question or permission prompt. Answer it first.",
					);
				reply(peer, frame.id, null);
				return respond(session, frame.text);
			case "key":
				return reply(peer, frame.id, null);
			case "permission":
				if (
					dialog?.kind !== "permission" ||
					dialog.toolUseId !== frame.toolUseId
				)
					return reply(peer, frame.id, "That prompt is no longer open");
				reply(peer, frame.id, null);
				return resume(session, frame.choice < dialog.options.length - 1);
			case "answer": {
				if (dialog?.kind !== "question" || dialog.toolUseId !== frame.toolUseId)
					return reply(peer, frame.id, "That question is no longer open");
				reply(peer, frame.id, null);
				const answers = Object.fromEntries(
					dialog.questions.map((question, index) => {
						const answer = frame.answers[index];
						return [
							question.question,
							[
								...(answer?.selected ?? []),
								...(answer?.other ? [answer.other] : []),
							].join(", "),
						];
					}),
				);
				return resume(session, true, answers);
			}
		}
	};

	const conversationOpener =
		(conversation: Conversation): Opener =>
		(peer) => {
			conversation.viewers.add(peer);
			sendFrame(peer, {
				type: "items",
				epoch: key(conversation.node),
				rev: conversation.rev,
				total: conversation.items.length,
				first: 0,
				reset: true,
				items: conversation.items,
			});
			sendFrame(peer, { type: "status", status: statusOf(conversation) });
			const session =
				conversation.node.kind === "session"
					? sessionById(conversation.node.id)
					: null;
			if (session) sendFrame(peer, { type: "drive", drive: driveOf(session) });
			sendFrame(peer, {
				type: "dialog",
				dialog: conversation.dialog,
				answerable: conversation.dialog !== null,
			});
			sendFrame(peer, { type: "mode", mode: null });
			return {
				receive(data) {
					try {
						handle(
							conversation,
							peer,
							JSON.parse(data) as ConversationClientFrame,
						);
					} catch {
						reply(peer, "", "Unsupported input");
					}
				},
				close: () => conversation.viewers.delete(peer),
			};
		};

	const encoder = new TextEncoder();
	const bytes = (text: string) => encoder.encode(text).buffer as ArrayBuffer;

	const attachOpener =
		(session: Session): Opener =>
		(peer) => {
			const items =
				conversations.get(key({ kind: "session", id: session.id }))?.items ??
				[];
			let line = "";
			peer.send(bytes(`${screenOf(items, "\r\n")}\r\n> `));
			return {
				receive(data) {
					const frame = JSON.parse(data) as AttachClientFrame;
					if (frame.t !== "in") return;
					for (const char of frame.d) {
						if (char === "\r") {
							const reply =
								line.trim() === "" ? "" : `\r\n\r\n● ${demoReply}\r\n`;
							line = "";
							peer.send(bytes(`${reply}\r\n> `));
						} else if (char === "\x7f") {
							if (line === "") continue;
							line = line.slice(0, -1);
							peer.send(bytes("\b \b"));
						} else if (char >= " ") {
							line += char;
							peer.send(bytes(char));
						}
					}
				},
				close() {},
			};
		};

	const mirrorOpener =
		(session: Session): Opener =>
		(peer) => {
			const items =
				conversations.get(key({ kind: "session", id: session.id }))?.items ??
				[];
			let screen = `${screenOf(items, "\n")}\n> `;
			const show = () =>
				peer.send(
					JSON.stringify({ type: "screen", text: screen } as MirrorServerFrame),
				);
			show();
			return {
				receive(data) {
					const frame = JSON.parse(data) as MirrorClientFrame;
					if (frame.type !== "text" || frame.text.trim() === "") return;
					screen = `${screen}${frame.text}\n\n● ${demoReply}\n\n> `;
					show();
				},
				close() {},
			};
		};

	const socket = (path: string): Opener | null => {
		if (path === "/api/feed") return feed;
		const attach = /^\/api\/attach\/([0-9a-f]{8})$/.exec(path)?.[1];
		if (attach) {
			const session = world.sessions.find(
				(item) =>
					item.short === attach &&
					item.kind === "background" &&
					item.attachable,
			);
			return session ? attachOpener(session) : null;
		}
		const mirror = /^\/api\/mirror\/([\w-]{1,64})$/.exec(path)?.[1];
		if (mirror) {
			const session = sessionById(mirror);
			return session?.kind === "interactive" && session.cmux
				? mirrorOpener(session)
				: null;
		}
		const view =
			/^\/api\/(sessions|subagents)\/([\w-]{1,64})\/conversation$/.exec(path);
		if (view?.[2]) {
			const conversation = conversations.get(
				key({
					kind: view[1] === "sessions" ? "session" : "subagent",
					id: view[2],
				}),
			);
			return conversation ? conversationOpener(conversation) : null;
		}
		return null;
	};

	const fetch = (
		method: string,
		path: string,
		query: URLSearchParams,
		body: unknown,
	): Response => {
		for (const [verb, pattern, run] of routes) {
			const match = pattern.exec(path);
			if (match && verb === method)
				return run(match.slice(1).map(decodeURIComponent), body, query);
		}
		return routes.some(([, pattern]) => pattern.test(path))
			? json(405, { error: "Method Not Allowed" })
			: notFound();
	};

	const duration = Math.max(0, ...scenario.timeline.map((step) => step.at));

	const cancel = () => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	};

	const stop = () => {
		cancel();
		clearInterval(chatter);
	};

	const play = (): Promise<void> => {
		cancel();
		load(scenario.world(Date.now()));
		broadcast({ type: "layout", layout: world.layout });
		broadcast({ type: "annotations", annotations: world.annotations });
		broadcast({ type: "colours", colours: world.colours });
		broadcast({ type: "regions", regions: world.regions });
		broadcast({ type: "comments", comments: world.comments });
		broadcast({ type: "board", board: snapshot() });
		for (const step of scenario.timeline) later(step.at, () => step.run(stage));
		return new Promise((resolve) => later(duration + 1, resolve));
	};

	load(world);

	return { fetch, socket, stage, play, stop, duration };
}
