import { Plus } from "lucide-preact";
import type { Board, Session } from "../shared/types.ts";
import { withoutSessions } from "./actions.ts";
import { arrangement, arrangeNode, groups } from "./arrangement.ts";
import { Canvas } from "./Canvas.tsx";
import { SessionCard, SubagentCard } from "./Card.tsx";
import { Arcs, Links, messagePairs } from "./Edges.tsx";
import {
	CloseButton,
	ExitDialog,
	ExitNotice,
	exitStateClass,
} from "./ExitControls.tsx";
import type { ExitState } from "./exitState.ts";
import { departed, exits } from "./exitState.ts";
import { Focus } from "./focus/Focus.tsx";
import { NewSession } from "./focus/NewSession.tsx";
import { GroupFrames } from "./Groups.tsx";
import type { NodeKey, PlacedNode } from "./layout.ts";
import { nodeKey } from "./layout.ts";
import type { Arrangement } from "./placement.ts";
import { Rail } from "./Rail.tsx";
import { BoardMenu, SpawnLayer, useBoardGestures } from "./Spawning.tsx";
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
	subagentsById,
	workingSubagentsOnly,
} from "./state.ts";
import { sessionsWithWorkingSubagents } from "./subagentCounts.ts";
import { TopBar } from "./TopBar.tsx";

function visibility(): (key: NodeKey) => boolean {
	const sessions = sessionsById.value;
	const agents = subagentsById.value;
	const working = workingSubagentsOnly.value
		? sessionsWithWorkingSubagents([...agents.values()])
		: null;
	return (key) => {
		const [kind, id] = [
			key.slice(0, key.indexOf(":")),
			key.slice(key.indexOf(":") + 1),
		];
		if (working) {
			const highlighted =
				kind === "subagent" ? agents.get(id)?.live : working.has(id);
			if (!highlighted) return false;
		}
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

function sessionCards(
	current: Board,
	placed: Arrangement,
): { session: Session; node: PlacedNode }[] {
	const listed = current.sessions.flatMap((session) => {
		const node = placed.nodes.get(nodeKey({ kind: "session", id: session.id }));
		return node ? [{ session, node }] : [];
	});
	const ids = new Set(current.sessions.map((s) => s.id));
	const held = [...exits.value.values()].flatMap((state) =>
		(state.phase === "checking" || state.phase === "leaving") &&
		state.node &&
		!ids.has(state.session.id)
			? [{ session: state.session, node: state.node }]
			: [],
	);
	return [...listed, ...held];
}

function World(props: { board: Board; layout: Arrangement }) {
	const visible = visibility();
	const lit = litNodes(props.board);
	const sessionPreviews = previews.value;
	const t = now.value;
	const frames = groups.value;
	const grouped = new Set(frames.flatMap((g) => g.members));
	const exiting = exits.value;
	const card = (
		session: Session,
		node: PlacedNode,
		state: ExitState | undefined,
	) => (
		<SessionCard
			key={node.key}
			node={node}
			session={session}
			preview={sessionPreviews.get(session.id)}
			now={t}
			emphasis={{
				dimmed: !visible(node.key),
				lit: lit.nodes.has(node.key),
				grouped: grouped.has(node.key),
			}}
			onOpen={openSession}
			state={exitStateClass(state)}
			corner={<CloseButton session={session} state={state} />}
			notice={<ExitNotice session={session} state={state} />}
		/>
	);
	return (
		<>
			<GroupFrames groups={frames} />
			<Links board={props.board} layout={props.layout} visible={visible} />
			{sessionCards(props.board, props.layout).map(({ session, node }) =>
				card(session, node, exiting.get(session.id)),
			)}
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

function newestSession(current: Board, placed: Arrangement) {
	const newest = current.sessions.reduce<Board["sessions"][number] | null>(
		(top, s) => (top === null || s.startedAt > top.startedAt ? s : top),
		null,
	);
	return newest
		? placed.nodes.get(nodeKey({ kind: "session", id: newest.id }))
		: undefined;
}

function Stage() {
	const current = board.value;
	const placed = arrangement.value;
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
	const anchor = newestSession(current, placed);
	return (
		<Canvas
			content={placed.bounds}
			anchor={anchor ? { x: anchor.x, w: anchor.w } : undefined}
			fitKey="board"
			rectOf={(key) => arrangement.peek()?.nodes.get(key)}
			onArrange={arrangeNode}
		>
			<World board={withoutSessions(current, departed.value)} layout={placed} />
			<SpawnLayer />
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
	useBoardGestures();
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
			<ExitDialog />
			<BoardMenu />
		</div>
	);
}
