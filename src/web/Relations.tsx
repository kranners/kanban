import { computed } from "@preact/signals";
import { Unlink } from "lucide-preact";
import type { JSX } from "preact";
import { live, sameAccount } from "../shared/reach.ts";
import { endKey } from "../shared/relations.ts";
import type { Relation, RelationEnd, Session } from "../shared/types.ts";
import { current as shownAnnotations } from "./annotations.ts";
import { arrangement } from "./arrangement.ts";
import { detail, view } from "./Canvas.tsx";
import {
	facingSide,
	previewPath,
	type Rect,
	relationPath,
	sidePoint,
} from "./geometry.ts";
import type { NodeKey } from "./layout.ts";
import { linkDraft, linkError, rectOfEnd } from "./linking.ts";
import type { Arrangement } from "./placement.ts";
import { removeRelation, shownRelations } from "./relationState.ts";
import "./relations.css";
import { sessionsById } from "./state.ts";

const unlinkSize = 28;
const highlightPad = 6;
const highlightRadius = 10;
const errorOffset = 10;

const unzoom = computed(() =>
	detail.value === "near" ? 1 / view.value.k : Math.max(1, 1 / view.value.k),
);

function nameOf(end: RelationEnd): string {
	if (end.kind === "session") {
		return sessionsById.value.get(end.id)?.name ?? "this session";
	}
	const store = shownAnnotations.value[end.id];
	return store?.kind === "docs" ? `"${store.title}"` : "this doc store";
}

function sessionOf(end: RelationEnd): Session | null {
	return end.kind === "session"
		? (sessionsById.value.get(end.id) ?? null)
		: null;
}

function unreachableReason(relation: Relation): string | null {
	const a = sessionOf(relation.from);
	const b = sessionOf(relation.to);
	const stopped = [a, b].find((session) => session && !live(session));
	if (stopped) return `${stopped.name} isn't running`;
	if (a && b && !sameAccount(a, b)) {
		return `Can't message ${b.name}: it runs on another Claude account`;
	}
	return null;
}

function RelationLine(props: {
	relation: Relation;
	a: Rect;
	b: Rect;
	dimmed: boolean;
	buttonSize: number;
}): JSX.Element {
	const { relation, buttonSize } = props;
	const drawn = relationPath(props.a, props.b);
	const reason = unreachableReason(relation);
	const kind =
		relation.from.kind === "session" && relation.to.kind === "session"
			? "sessions"
			: "docs";
	const label = `Unlink ${nameOf(relation.from)} and ${nameOf(relation.to)}`;
	return (
		<g
			class={`relation ${kind}${reason ? " unreachable" : ""}${props.dimmed ? " dimmed" : ""}`}
		>
			<title>
				{reason ??
					`${nameOf(relation.from)} and ${nameOf(relation.to)} are linked`}
			</title>
			<path class="relation-line" d={drawn.path} />
			<path class="relation-hit" d={drawn.path} />
			<foreignObject
				x={drawn.mid.x - buttonSize / 2}
				y={drawn.mid.y - buttonSize / 2}
				width={buttonSize}
				height={buttonSize}
			>
				<button
					type="button"
					class="relation-unlink"
					data-no-pan
					aria-label={label}
					title={label}
					onClick={() => void removeRelation(relation.id)}
				>
					<Unlink size={buttonSize / 2} aria-hidden="true" />
				</button>
			</foreignObject>
		</g>
	);
}

export function RelationLayer(props: {
	layout: Pick<Arrangement, "nodes" | "bounds">;
	visible: (key: NodeKey) => boolean;
}): JSX.Element | null {
	const shown = shownRelations.value;
	if (detail.value === "far" || shown.length === 0) return null;
	const annotations = shownAnnotations.value;
	const buttonSize = unlinkSize * unzoom.value;
	const hidden = (end: RelationEnd) =>
		end.kind === "session" && !props.visible(endKey(end));
	const lines = shown.flatMap((relation) => {
		const a = rectOfEnd(relation.from, props.layout.nodes, annotations);
		const b = rectOfEnd(relation.to, props.layout.nodes, annotations);
		if (!a || !b) return [];
		return [
			<RelationLine
				key={relation.id}
				relation={relation}
				a={a}
				b={b}
				dimmed={hidden(relation.from) || hidden(relation.to)}
				buttonSize={buttonSize}
			/>,
		];
	});
	return (
		<svg class="relations" width="1" height="1">
			<title>Links between cards</title>
			{lines}
		</svg>
	);
}

export function RelationPreview(): JSX.Element | null {
	const draft = linkDraft.value;
	const error = linkError.value;
	if (!draft && !error) return null;
	const target = draft?.over
		? rectOfEnd(
				draft.over,
				arrangement.value?.nodes ?? new Map(),
				shownAnnotations.value,
			)
		: null;
	const pad = highlightPad * unzoom.value;
	const radius = highlightRadius * unzoom.value;
	const end =
		draft && target
			? sidePoint(target, facingSide(target, draft.start))
			: draft?.at;
	return (
		<>
			{draft && end && (
				<svg
					class="relations relation-preview"
					width="1"
					height="1"
					aria-hidden="true"
				>
					{target && (
						<rect
							class="relation-target"
							x={target.x - pad}
							y={target.y - pad}
							width={target.w + pad * 2}
							height={target.h + pad * 2}
							rx={radius}
						/>
					)}
					<path
						class="relation-line"
						d={previewPath(draft.start, draft.side, end)}
					/>
				</svg>
			)}
			{error && (
				<div
					class="relation-error"
					role="status"
					style={{
						transform: `translate(${error.at.x}px, ${error.at.y}px) scale(${unzoom.value}) translate(${errorOffset}px, ${errorOffset}px)`,
					}}
				>
					{error.text}
				</div>
			)}
		</>
	);
}
