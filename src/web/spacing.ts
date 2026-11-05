import { current as shownAnnotations } from "./annotations.ts";
import { arrangement } from "./arrangement.ts";
import type { NodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";

export type Moving = {
	nodes?: Iterable<NodeKey>;
	annotations?: Iterable<string>;
};

/**
 * The cards, notes, stickers and Butler cards on the board that are not
 * moving, which whatever moves keeps a grid cell from. A card's subagents
 * move with it. Comment pins float over the board and take no room.
 */
export function standing(moving: Moving = {}): Rect[] {
	const nodes = new Set(moving.nodes);
	const annotations = new Set(moving.annotations);
	const placed = arrangement.peek()?.nodes.values() ?? [];
	return [
		...[...placed].filter(
			(node) =>
				!nodes.has(node.key) &&
				(node.follows === undefined || !nodes.has(node.follows)),
		),
		...Object.values(shownAnnotations.peek()).filter(
			(annotation) => !annotations.has(annotation.id),
		),
	];
}
