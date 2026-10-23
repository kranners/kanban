import { GitBranch } from "lucide-preact";
import type { Board, Message } from "../shared/types.ts";
import { messageArc, treeMidpoint, treePath } from "./geometry.ts";
import type { BoardLayout, NodeKey } from "./layout.ts";
import { nodeKey } from "./layout.ts";

const freshMessageMs = 60_000;
const reducedMotion =
	typeof matchMedia === "function" &&
	matchMedia("(prefers-reduced-motion: reduce)").matches;

export type MessagePair = {
	key: string;
	from: NodeKey;
	to: NodeKey;
	messages: Message[];
	latest: number;
};

export function messagePairs(board: Board): MessagePair[] {
	const pairs = new Map<string, MessagePair>();
	for (const message of board.messages) {
		const from = nodeKey(message.from);
		const to = nodeKey(message.to);
		const key = `${from}>${to}`;
		const pair = pairs.get(key) ?? { key, from, to, messages: [], latest: 0 };
		pair.messages.push(message);
		pair.latest = Math.max(pair.latest, message.at);
		pairs.set(key, pair);
	}
	return [...pairs.values()];
}

function curveStyle(path: string) {
	return { d: `path("${path}")` };
}

export function Edges(props: {
	board: Board;
	layout: BoardLayout;
	now: number;
	litPair: string | null;
	visible: (key: NodeKey) => boolean;
}) {
	const { board, layout } = props;
	const pad = 400;
	const width = layout.width + pad * 2;
	const height = layout.height + pad * 2;
	const faded = (a: NodeKey, b: NodeKey) =>
		props.visible(a) && props.visible(b) ? "" : " dimmed";

	const links = board.links.flatMap((link, index) => {
		const from = layout.nodes.get(nodeKey(link.from));
		const to = layout.nodes.get(nodeKey(link.to));
		if (!from || !to) return [];
		const path = treePath(from, to);
		const mid = treeMidpoint(from, to);
		const id = `${from.key}>${to.key}>${index}`;
		return [
			<g key={id} class={`edge edge-${link.kind}${faded(from.key, to.key)}`}>
				<path
					d={path}
					style={curveStyle(path)}
					marker-end={link.kind === "spawned" ? "url(#arrow)" : undefined}
				/>
				{link.kind === "forked" && (
					<g
						class="edge-badge"
						style={{ transform: `translate(${mid.x}px, ${mid.y}px)` }}
					>
						<circle r="11" />
						<GitBranch x={-7} y={-7} size={14} strokeWidth={2} />
					</g>
				)}
			</g>,
		];
	});

	const arcs = messagePairs(board).flatMap((pair, index) => {
		const from = layout.nodes.get(pair.from);
		const to = layout.nodes.get(pair.to);
		if (!from || !to || from === to) return [];
		const arc = messageArc(from, to);
		const fresh = props.now - pair.latest < freshMessageMs;
		const lit = props.litPair === pair.key;
		return [
			<g
				key={pair.key}
				class={`arc${lit ? " lit" : ""}${faded(pair.from, pair.to)}`}
			>
				<path id={`arc-${index}`} d={arc.path} style={curveStyle(arc.path)} />
				{fresh && !reducedMotion && (
					<circle class="arc-dot" r="3.5">
						<animateMotion dur="1.8s" repeatCount="indefinite">
							<mpath href={`#arc-${index}`} />
						</animateMotion>
					</circle>
				)}
				{pair.messages.length > 1 && (
					<g
						class="arc-count"
						style={{ transform: `translate(${arc.mid.x}px, ${arc.mid.y}px)` }}
					>
						<rect x="-12" y="-9" width="24" height="18" rx="9" />
						<text text-anchor="middle" dy="4">
							{pair.messages.length}
						</text>
					</g>
				)}
			</g>,
		];
	});

	return (
		<svg
			class="edges"
			width={width}
			height={height}
			viewBox={`${-pad} ${-pad} ${width} ${height}`}
			style={{ transform: `translate(${-pad}px, ${-pad}px)` }}
			aria-hidden="true"
		>
			<defs>
				<marker
					id="arrow"
					viewBox="0 0 10 10"
					refX="8"
					refY="5"
					markerWidth="7"
					markerHeight="7"
					orient="auto-start-reverse"
				>
					<path d="M1 1 L9 5 L1 9 Z" class="arrow-head" />
				</marker>
			</defs>
			<g>{links}</g>
			<g>{arcs}</g>
		</svg>
	);
}
