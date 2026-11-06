import "./butler.css";
import { X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Board, ButlerEdgeMessage } from "../shared/types.ts";
import { current } from "./annotations.ts";
import { butlerPresence } from "./butler.ts";
import {
	butlerEdges,
	chipLabel,
	chipSpot,
	drawnEdges,
	edgeCurve,
	fetchEdgeMessages,
	isRelayedPair,
	type OpenEdge,
	openEdge,
	pillLabel,
} from "./butlerEdges.ts";
import { view } from "./Canvas.tsx";
import { messagePairs } from "./Edges.tsx";
import { messageArc } from "./geometry.ts";
import { nodeKey } from "./layout.ts";
import type { Arrangement } from "./placement.ts";
import { ago } from "./time.ts";

type Placed = Pick<Arrangement, "nodes" | "bounds">;

const layerPad = 400;

/** Keeps a pill legible when the board is zoomed out. */
const pillScale = () => Math.min(3, Math.max(1, 0.85 / view.value.k));

/** Stops a click on a pill from panning the board or reaching the card under it. */
const held = (event: Event) => event.stopPropagation();

/** The DM's thread id, once the presence frame names it. */
const dmThread = () => butlerPresence.value.dm?.thread;

/**
 * Butler's message edges: a thin dotted link from each thread card to
 * the cards and sessions it messaged, a pill with how many and when at
 * its middle, a chip on a card for messages to or from the DM, and the
 * click target on each session message arc's count, all opening the
 * edge view.
 */
export function ButlerEdges(props: {
	layout: Placed;
	board: Board;
	now: number;
}): JSX.Element {
	const box = (id: string) =>
		props.layout.nodes.get(nodeKey({ kind: "session", id }));
	const { lines, chips } = drawnEdges(
		butlerEdges.value,
		current.value,
		props.board.sessions,
		box,
		dmThread(),
	);
	const curves = lines.flatMap((line) => {
		const curve = edgeCurve(line.fromBox, line.toBox);
		return curve ? [{ line, curve }] : [];
	});
	const pairs = messagePairs(props.board).flatMap((pair) => {
		const from = props.layout.nodes.get(pair.from);
		const to = props.layout.nodes.get(pair.to);
		if (!from || !to || from === to || pair.messages.length < 2) return [];
		const names = [from, to].map((node) =>
			node.ref.kind === "session"
				? (props.board.sessions.find((s) => s.id === node.ref.id)?.name ??
					"Session")
				: "Subagent",
		);
		return [
			{
				pair,
				mid: messageArc(from, to).mid,
				title: `${names[0]} → ${names[1]}`,
			},
		];
	});
	const scale = pillScale();
	const { bounds } = props.layout;
	const left = bounds.x - layerPad;
	const top = bounds.y - layerPad;
	const width = bounds.width + layerPad * 2;
	const height = bounds.height + layerPad * 2;
	const toggle = (next: OpenEdge) => {
		const open = openEdge.value;
		const same =
			open &&
			open.kind === next.kind &&
			open.title === next.title &&
			open.at.x === next.at.x &&
			open.at.y === next.at.y;
		openEdge.value = same ? null : next;
	};
	return (
		<>
			<svg
				class="edges butler-edges"
				width={width}
				height={height}
				viewBox={`${left} ${top} ${width} ${height}`}
				style={{ transform: `translate(${left}px, ${top}px)` }}
				aria-hidden="true"
			>
				{curves.map(({ line, curve }) => (
					<path key={line.key} class="butler-edge" d={curve.path} />
				))}
			</svg>
			{curves.map(({ line, curve }) => (
				<button
					key={`pill-${line.key}`}
					type="button"
					class="butler-edge-pill"
					data-no-pan
					title={`${line.title}: ${line.vias.join(", ")}`}
					aria-label={`${line.count} message${line.count === 1 ? "" : "s"}, ${line.title}`}
					style={{
						transform: `translate(${curve.mid.x}px, ${curve.mid.y}px) scale(${scale}) translate(-50%, -50%)`,
					}}
					onPointerDown={held}
					onClick={(event) => {
						held(event);
						toggle({
							kind: "butler",
							from: line.from,
							to: line.to,
							title: line.title,
							at: curve.mid,
						});
					}}
				>
					{pillLabel(line.count, line.lastAt, props.now)}
				</button>
			))}
			{chips.map((chip) => {
				const spot = chipSpot(chip);
				return (
					<button
						key={`chip-${chip.key}`}
						type="button"
						class="butler-edge-pill butler-edge-chip"
						data-no-pan
						title={chip.title}
						style={{
							transform: `translate(${spot.x}px, ${spot.y}px) scale(${scale}) translate(-100%, -100%)`,
						}}
						onPointerDown={held}
						onClick={(event) => {
							held(event);
							toggle({
								kind: "butler",
								from: chip.from,
								to: chip.to,
								title: chip.title,
								at: spot,
							});
						}}
					>
						{chipLabel(chip, props.now)}
					</button>
				);
			})}
			{pairs.map(({ pair, mid, title }) => (
				<button
					key={`arc-${pair.key}`}
					type="button"
					class={`arc-count-target${isRelayedPair(pair.messages) ? " relayed" : ""}`}
					data-no-pan
					aria-label={`${pair.messages.length} messages, ${title}`}
					title={title}
					style={{
						transform: `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`,
					}}
					onPointerDown={held}
					onClick={(event) => {
						held(event);
						toggle({
							kind: "pair",
							key: pair.key,
							title,
							at: mid,
							messages: pair.messages.map(({ at, summary, kind }) => ({
								at,
								summary,
								...(kind ? { kind } : {}),
							})),
						});
					}}
				/>
			))}
			<EdgeView now={props.now} scale={scale} />
		</>
	);
}

const viaLabel: Record<string, string> = {
	send: "message",
	cloud: "remote session",
	prompt: "prompt",
	say: "say",
};

/** The open edge's messages, newest last, beside the pill that opened it. */
function EdgeView(props: { now: number; scale: number }): JSX.Element | null {
	const open = openEdge.value;
	const [shown, setShown] = useState<
		| { state: "loading" }
		| { state: "error"; error: string }
		| { state: "ready"; messages: ButlerEdgeMessage[] }
	>({ state: "loading" });
	const from = open?.kind === "butler" ? open.from : null;
	const to = open?.kind === "butler" ? open.to : null;
	const fromKey = from ? `${from.kind}:${from.id}` : null;
	const toKey = to ? `${to.kind}:${to.id}` : null;
	useEffect(() => {
		if (!from || !to) return;
		let live = true;
		setShown({ state: "loading" });
		void fetchEdgeMessages(from, to).then((got) => {
			if (!live) return;
			setShown(
				got.ok
					? { state: "ready", messages: got.value.messages }
					: { state: "error", error: got.error },
			);
		});
		return () => {
			live = false;
		};
	}, [fromKey, toKey]);
	useEffect(() => {
		if (!open) return;
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape") openEdge.value = null;
		};
		addEventListener("keydown", close);
		return () => removeEventListener("keydown", close);
	}, [open]);
	if (!open) return null;
	const rows =
		open.kind === "pair"
			? open.messages.map((m) => ({
					at: m.at,
					via: viaLabel[m.kind ?? "send"] ?? "message",
					text: m.summary,
				}))
			: shown.state === "ready"
				? shown.messages
				: [];
	return (
		<section
			class="butler-edge-view"
			data-no-pan
			data-scrollable
			aria-label={`Messages, ${open.title}`}
			style={{
				transform: `translate(${open.at.x}px, ${open.at.y}px) scale(${props.scale}) translate(-50%, 16px)`,
			}}
			onPointerDown={held}
			onWheel={held}
		>
			<header>
				<span>{open.title}</span>
				<button
					type="button"
					class="icon-button"
					aria-label="Close"
					onClick={() => {
						openEdge.value = null;
					}}
				>
					<X size={14} />
				</button>
			</header>
			{open.kind === "butler" && shown.state === "loading" && (
				<p class="butler-edge-empty">Reading…</p>
			)}
			{open.kind === "butler" && shown.state === "error" && (
				<p class="butler-edge-empty">{shown.error}</p>
			)}
			{rows.length === 0 &&
				(open.kind === "pair" || shown.state === "ready") && (
					<p class="butler-edge-empty">No words kept for these messages</p>
				)}
			<ol>
				{rows.map((row) => (
					<li key={`${row.at}-${row.text.slice(0, 20)}`}>
						<div class="butler-edge-meta">
							<span>{row.via}</span>
							<time class="num">{ago(row.at, props.now)}</time>
						</div>
						<p>{row.text}</p>
					</li>
				))}
			</ol>
		</section>
	);
}
