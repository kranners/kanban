import { Plus } from "lucide-preact";
import type { Board } from "../shared/types.ts";
import { Canvas } from "./Canvas.tsx";
import { SessionCard, SubagentCard } from "./Card.tsx";
import { Arcs, Links, messagePairs } from "./Edges.tsx";
import { Focus } from "./focus/Focus.tsx";
import { NewSession } from "./focus/NewSession.tsx";
import type { BoardLayout, NodeKey } from "./layout.ts";
import { newestRoot, nodeKey } from "./layout.ts";
import { Rail } from "./Rail.tsx";
import {
	awaitingShort,
	board,
	focusedSession,
	focusedSessionId,
	focusOrigin,
	knownCwds,
	litMessage,
	newSessionOpen,
	now,
	openSession,
	previews,
	sessionMatches,
	sessionsById,
	stageLayout,
	subagentsById,
} from "./state.ts";
import { TopBar } from "./TopBar.tsx";

function visibility(): (key: NodeKey) => boolean {
	const sessions = sessionsById.value;
	const agents = subagentsById.value;
	return (key) => {
		const [kind, id] = [
			key.slice(0, key.indexOf(":")),
			key.slice(key.indexOf(":") + 1),
		];
		const sessionId = kind === "session" ? id : agents.get(id)?.sessionId;
		const session = sessionId ? sessions.get(sessionId) : undefined;
		return session ? sessionMatches(session) : true;
	};
}

function litNodes(current: Board): {
	pair: string | null;
	nodes: Set<NodeKey>;
} {
	const message = current.messages.find((m) => m.id === litMessage.value);
	if (!message) return { pair: null, nodes: new Set() };
	const from = nodeKey(message.from);
	const to = nodeKey(message.to);
	const pair = messagePairs(current).find(
		(p) => p.from === from && p.to === to,
	);
	return { pair: pair?.key ?? null, nodes: new Set([from, to]) };
}

function World(props: { board: Board; layout: BoardLayout }) {
	const visible = visibility();
	const lit = litNodes(props.board);
	const sessionPreviews = previews.value;
	const t = now.value;
	return (
		<>
			<Links board={props.board} layout={props.layout} visible={visible} />
			{props.board.sessions.map((session) => {
				const node = props.layout.nodes.get(
					nodeKey({ kind: "session", id: session.id }),
				);
				if (!node) return null;
				return (
					<SessionCard
						key={node.key}
						node={node}
						session={session}
						preview={sessionPreviews.get(session.id)}
						now={t}
						emphasis={{
							dimmed: !visible(node.key),
							lit: lit.nodes.has(node.key),
						}}
						onOpen={openSession}
					/>
				);
			})}
			{props.board.subagents.map((subagent) => {
				const node = props.layout.nodes.get(
					nodeKey({ kind: "subagent", id: subagent.id }),
				);
				if (!node) return null;
				return (
					<SubagentCard
						key={node.key}
						node={node}
						subagent={subagent}
						now={t}
						emphasis={{
							dimmed: !visible(node.key),
							lit: lit.nodes.has(node.key),
						}}
					/>
				);
			})}
			<Arcs
				board={props.board}
				layout={props.layout}
				now={t}
				litPair={lit.pair}
				visible={visible}
			/>
		</>
	);
}

function NewSessionButton() {
	return (
		<button
			type="button"
			class="primary"
			onClick={() => {
				newSessionOpen.value = true;
			}}
		>
			<Plus size={16} strokeWidth={2.25} />
			New session
		</button>
	);
}

function Placeholder(props: { title: string; body: string; action?: boolean }) {
	return (
		<div class="placeholder-state">
			<h1>{props.title}</h1>
			<p>{props.body}</p>
			{props.action && <NewSessionButton />}
		</div>
	);
}

function Stage() {
	const current = board.value;
	const placed = stageLayout.value;
	if (!current || !placed) {
		return (
			<Placeholder
				title="Connecting…"
				body="Waiting for the board from this Mac."
			/>
		);
	}
	if (current.sessions.length === 0) {
		return (
			<Placeholder
				title="No sessions yet"
				body="Sessions running on this Mac appear here as they start. Start a background session to drive it from the board."
				action
			/>
		);
	}
	const root = newestRoot(placed);
	return (
		<Canvas
			content={{ width: placed.width, height: placed.height }}
			anchor={root ? { x: root.x, w: root.w } : undefined}
			fitKey="board"
		>
			<World board={current} layout={placed} />
		</Canvas>
	);
}

function created(short: string): void {
	newSessionOpen.value = false;
	const existing = board.value?.sessions.find((s) => s.short === short);
	if (existing) openSession(existing.id);
	else awaitingShort.value = short;
}

export function App() {
	const session = focusedSession.value;
	return (
		<div class="app">
			<TopBar />
			<main class="main">
				<Stage />
				<Rail />
			</main>
			{session && (
				<Focus
					session={session}
					origin={focusOrigin.value}
					onClose={() => {
						focusedSessionId.value = null;
					}}
				/>
			)}
			{newSessionOpen.value && (
				<NewSession
					cwds={knownCwds.value}
					onCreated={created}
					onClose={() => {
						newSessionOpen.value = false;
					}}
				/>
			)}
		</div>
	);
}
