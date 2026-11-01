import { signal } from "@preact/signals";
import { linkRefusal } from "../shared/reach.ts";
import { endKey, sameEnd, samePair } from "../shared/relations.ts";
import type {
	Point,
	RelationDraft,
	RelationEnd,
	Session,
} from "../shared/types.ts";
import type { Rect, Side } from "./geometry.ts";
import type { NodeKey, PlacedNode } from "./layout.ts";

export type LinkDraft = {
	from: RelationEnd;
	side: Side;
	start: Point;
	at: Point;
	over: RelationEnd | null;
};

export type LinkError = { at: Point; text: string };

export type Linkable = { end: RelationEnd; rect: Rect; refused: boolean };

export const linkDraft = signal<LinkDraft | null>(null);
export const linkError = signal<LinkError | null>(null);

export function linkables(
	nodes: ReadonlyMap<NodeKey, PlacedNode>,
	sessions: readonly Session[],
): Linkable[] {
	return sessions.flatMap((session): Linkable[] => {
		const end: RelationEnd = { kind: "session", id: session.id };
		const node = nodes.get(endKey(end));
		if (!node) return [];
		const { x, y, w, h } = node;
		return [
			{ end, rect: { x, y, w, h }, refused: linkRefusal(session) !== null },
		];
	});
}

export function rectOfEnd(
	end: RelationEnd,
	nodes: ReadonlyMap<NodeKey, PlacedNode>,
): Rect | null {
	return nodes.get(endKey(end)) ?? null;
}

const contains = (rect: Rect, at: Point): boolean =>
	at.x >= rect.x &&
	at.x <= rect.x + rect.w &&
	at.y >= rect.y &&
	at.y <= rect.y + rect.h;

export function linkableAt(
	at: Point,
	candidates: readonly Linkable[],
	from: RelationEnd,
	relations: readonly RelationDraft[],
): RelationEnd | null {
	const top = candidates.findLast(({ rect }) => contains(rect, at));
	if (!top || top.refused || sameEnd(top.end, from)) return null;
	const draft = { from, to: top.end };
	return relations.some((relation) => samePair(relation, draft))
		? null
		: top.end;
}
