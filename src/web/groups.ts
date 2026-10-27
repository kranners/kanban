import type { Point, Region, Session } from "../shared/types.ts";
import type { NodeKey, PlacedNode } from "./layout.ts";
import { nodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";
import { boundsOf, framedArea, groupReach, within } from "./placement.ts";

export type Group = {
	key: string;
	project: string;
	cwd: string;
	members: NodeKey[];
	frame: Rect;
	region?: Region;
};

function mostCommon(values: string[]): string {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	let best = values[0] ?? "";
	for (const [v, n] of counts) if (n > (counts.get(best) ?? 0)) best = v;
	return best;
}

export function groupsOf(
	sessions: readonly Session[],
	nodes: ReadonlyMap<NodeKey, PlacedNode>,
): Group[] {
	const areas = new Map<NodeKey, Rect>();
	const followers = new Map<NodeKey, PlacedNode[]>();
	for (const node of nodes.values()) {
		if (!node.follows) continue;
		followers.set(node.follows, [...(followers.get(node.follows) ?? []), node]);
	}
	const members = sessions.flatMap((session) => {
		const key = nodeKey({ kind: "session", id: session.id });
		const node = nodes.get(key);
		if (!node) return [];
		const area = boundsOf([node, ...(followers.get(key) ?? [])]);
		areas.set(key, { x: area.x, y: area.y, w: area.width, h: area.height });
		return [{ key, session }];
	});

	const parent = new Map(members.map((m) => [m.key, m.key]));
	const find = (k: NodeKey): NodeKey => {
		let root = k;
		while (parent.get(root) !== root) root = parent.get(root) ?? root;
		parent.set(k, root);
		return root;
	};
	for (const [i, a] of members.entries()) {
		for (const b of members.slice(i + 1)) {
			if (a.session.project !== b.session.project) continue;
			const ra = areas.get(a.key);
			const rb = areas.get(b.key);
			if (ra && rb && within(ra, rb, groupReach))
				parent.set(find(a.key), find(b.key));
		}
	}

	const clusters = new Map<NodeKey, typeof members>();
	for (const m of members) {
		const root = find(m.key);
		clusters.set(root, [...(clusters.get(root) ?? []), m]);
	}
	return [...clusters.values()]
		.filter((cluster) => cluster.length > 1)
		.map((cluster) => {
			const ordered = [...cluster].sort(
				(a, b) =>
					b.session.updatedAt - a.session.updatedAt ||
					a.key.localeCompare(b.key),
			);
			const area = boundsOf(
				ordered.flatMap((m) => {
					const r = areas.get(m.key);
					return r ? [r] : [];
				}),
			);
			const keys = ordered.map((m) => m.key);
			return {
				key: [...keys].sort()[0] ?? "",
				project: ordered[0]?.session.project ?? "",
				cwd: mostCommon(ordered.map((m) => m.session.cwd)),
				members: keys,
				frame: framedArea({
					x: area.x,
					y: area.y,
					w: area.width,
					h: area.height,
				}),
			};
		});
}

function contains(rect: Rect, point: Point): boolean {
	return (
		point.x >= rect.x &&
		point.x <= rect.x + rect.w &&
		point.y >= rect.y &&
		point.y <= rect.y + rect.h
	);
}

export function groupAt(groups: readonly Group[], point: Point): Group | null {
	return groups
		.filter((g) => contains(g.frame, point))
		.reduce<Group | null>(
			(best, g) =>
				best === null || g.frame.w * g.frame.h < best.frame.w * best.frame.h
					? g
					: best,
			null,
		);
}
