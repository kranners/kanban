import { GitBranch } from "lucide-preact";
import type { ComponentChildren } from "preact";
import type { Annotation, Board, Message, Point } from "../shared/types.ts";
import {
	drawnLinks,
	messageArc,
	regionTetherLine,
	tetherLine,
	treeMidpoint,
	treePath,
} from "./geometry.ts";
import type { NodeKey } from "./layout.ts";
import { nodeKey } from "./layout.ts";
import type { Arrangement, Rect } from "./placement.ts";

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

type Placed = Pick<Arrangement, "nodes" | "bounds">;

type EdgeProps = {
	board: Board;
	layout: Placed;
	visible: (key: NodeKey) => boolean;
};

const layerPad = 400;

function faded(props: EdgeProps, a: NodeKey, b: NodeKey): string {
	return props.visible(a) && props.visible(b) ? "" : " dimmed";
}

function EdgeLayer(props: {
	layout: Placed;
	class: string;
	children: ComponentChildren;
}) {
	const { bounds } = props.layout;
	const left = bounds.x - layerPad;
	const top = bounds.y - layerPad;
	const width = bounds.width + layerPad * 2;
	const height = bounds.height + layerPad * 2;
	return (
		<svg
			class={props.class}
			width={width}
			height={height}
			viewBox={`${left} ${top} ${width} ${height}`}
			style={{ transform: `translate(${left}px, ${top}px)` }}
			aria-hidden="true"
		>
			{props.children}
		</svg>
	);
}

export function Links(props: EdgeProps) {
	const { board, layout } = props;
	const links = drawnLinks(board.links, layout.nodes).map(
		({ link, from, to, index }) => {
			const path = treePath(from, to);
			const mid = treeMidpoint(from, to);
			const id = `${from.key}>${to.key}>${index}`;
			return (
				<g
					key={id}
					class={`edge edge-${link.kind}${faded(props, from.key, to.key)}`}
				>
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
				</g>
			);
		},
	);
	return (
		<EdgeLayer layout={layout} class="edges">
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
			{links}
		</EdgeLayer>
	);
}

export function Tethers(
	props: Omit<EdgeProps, "board"> & {
		notes: readonly Annotation[];
		regions: ReadonlyMap<string, Rect>;
	},
) {
	const line = (key: string, from: Point, to: Point, dimmed: boolean) => (
		<g key={key} class={`tether${dimmed ? " dimmed" : ""}`}>
			<line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
			<circle cx={from.x} cy={from.y} r="3" />
			<circle cx={to.x} cy={to.y} r="3" />
		</g>
	);
	const tethers = props.notes.flatMap((note) => {
		if (note.kind !== "note") return [];
		if (note.region) {
			const frame = props.regions.get(note.region);
			const tether = frame && regionTetherLine(note, frame);
			return tether ? [line(note.id, tether.from, tether.to, false)] : [];
		}
		if (!note.session) return [];
		const key = nodeKey({ kind: "session", id: note.session });
		const card = props.layout.nodes.get(key);
		const tether = card && tetherLine(note, card);
		return tether
			? [line(note.id, tether.from, tether.to, !props.visible(key))]
			: [];
	});
	return (
		<EdgeLayer layout={props.layout} class="edges tethers">
			{tethers}
		</EdgeLayer>
	);
}

export function Arcs(
	props: EdgeProps & { now: number; litPair: string | null },
) {
	const { board, layout } = props;
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
				class={`arc${lit ? " lit" : ""}${faded(props, pair.from, pair.to)}`}
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
		<EdgeLayer layout={layout} class="edges arcs">
			{arcs}
		</EdgeLayer>
	);
}
