import type { Board, LinkKind, NodeRef } from "../shared/types.ts";

export type NodeKey = string;

export type PlacedNode = {
	key: NodeKey;
	ref: NodeRef;
	family: number;
	x: number;
	y: number;
	w: number;
	h: number;
};

export type BoardLayout = {
	nodes: Map<NodeKey, PlacedNode>;
	families: NodeKey[][];
	width: number;
	height: number;
};

export type LayoutOptions = {
	maxWidth: number;
	session: { w: number; h: number };
	subagent: { w: number; h: number };
	siblingGap: number;
	levelGap: number;
	familyGap: number;
	rowGap: number;
};

export const sessionLabelHeight = 44;

export const defaultLayoutOptions: LayoutOptions = {
	maxWidth: 2400,
	session: { w: 300, h: 190 + sessionLabelHeight },
	subagent: { w: 220, h: 64 },
	siblingGap: 32,
	levelGap: 56,
	familyGap: 96,
	rowGap: 120,
};

const treeLinkKinds: ReadonlySet<LinkKind> = new Set([
	"subagent",
	"spawned",
	"forked",
]);

export function nodeKey(ref: NodeRef): NodeKey {
	return `${ref.kind}:${ref.id}`;
}

type GraphNode = {
	key: NodeKey;
	ref: NodeRef;
	startedAt: number;
	updatedAt: number;
};

function collectNodes(board: Board): Map<NodeKey, GraphNode> {
	const nodes = new Map<NodeKey, GraphNode>();
	for (const s of board.sessions) {
		const ref: NodeRef = { kind: "session", id: s.id };
		nodes.set(nodeKey(ref), {
			key: nodeKey(ref),
			ref,
			startedAt: s.startedAt,
			updatedAt: s.updatedAt,
		});
	}
	for (const a of board.subagents) {
		const ref: NodeRef = { kind: "subagent", id: a.id };
		nodes.set(nodeKey(ref), {
			key: nodeKey(ref),
			ref,
			startedAt: a.startedAt,
			updatedAt: a.updatedAt,
		});
	}
	return nodes;
}

function treeEdges(
	board: Board,
	nodes: Map<NodeKey, GraphNode>,
): [NodeKey, NodeKey][] {
	const edges: [NodeKey, NodeKey][] = [];
	for (const link of board.links) {
		if (!treeLinkKinds.has(link.kind)) continue;
		const from = nodeKey(link.from);
		const to = nodeKey(link.to);
		if (from !== to && nodes.has(from) && nodes.has(to)) edges.push([from, to]);
	}
	for (const a of board.subagents) {
		const owner = a.parentAgentId
			? nodeKey({ kind: "subagent", id: a.parentAgentId })
			: nodeKey({ kind: "session", id: a.sessionId });
		const self = nodeKey({ kind: "subagent", id: a.id });
		if (nodes.has(owner)) edges.push([owner, self]);
	}
	return edges;
}

export function familiesOf(board: Board): NodeKey[][] {
	const nodes = collectNodes(board);
	const parent = new Map<NodeKey, NodeKey>();
	const find = (k: NodeKey): NodeKey => {
		let root = k;
		while (parent.get(root) !== root) root = parent.get(root) ?? root;
		parent.set(k, root);
		return root;
	};
	for (const k of nodes.keys()) parent.set(k, k);
	for (const [a, b] of treeEdges(board, nodes)) parent.set(find(a), find(b));

	const groups = new Map<NodeKey, NodeKey[]>();
	for (const k of nodes.keys()) {
		const root = find(k);
		const group = groups.get(root) ?? [];
		group.push(k);
		groups.set(root, group);
	}
	const recency = (group: NodeKey[]) =>
		Math.max(...group.map((k) => nodes.get(k)?.updatedAt ?? 0));
	return [...groups.values()].sort((a, b) => recency(b) - recency(a));
}

type Tree = { key: NodeKey; children: Tree[]; width: number };

export function layoutBoard(
	board: Board,
	options: LayoutOptions = defaultLayoutOptions,
): BoardLayout {
	const nodes = collectNodes(board);
	const edges = treeEdges(board, nodes);
	const parentOf = new Map<NodeKey, NodeKey>();
	for (const [from, to] of edges) if (!parentOf.has(to)) parentOf.set(to, from);
	const childrenOf = new Map<NodeKey, NodeKey[]>();
	for (const [child, parent] of parentOf) {
		const list = childrenOf.get(parent) ?? [];
		list.push(child);
		childrenOf.set(parent, list);
	}

	const size = (k: NodeKey) =>
		nodes.get(k)?.ref.kind === "subagent" ? options.subagent : options.session;
	const childOrder = (a: NodeKey, b: NodeKey) => {
		const na = nodes.get(a);
		const nb = nodes.get(b);
		const kindRank = (n?: GraphNode) => (n?.ref.kind === "subagent" ? 0 : 1);
		return (
			kindRank(na) - kindRank(nb) ||
			(na?.startedAt ?? 0) - (nb?.startedAt ?? 0) ||
			a.localeCompare(b)
		);
	};

	const visited = new Set<NodeKey>();
	const build = (key: NodeKey): Tree => {
		visited.add(key);
		const children = (childrenOf.get(key) ?? [])
			.filter((c) => !visited.has(c))
			.sort(childOrder)
			.map(build);
		const childrenWidth =
			children.reduce((sum, c) => sum + c.width, 0) +
			Math.max(0, children.length - 1) * options.siblingGap;
		return { key, children, width: Math.max(size(key).w, childrenWidth) };
	};

	const placed = new Map<NodeKey, PlacedNode>();
	const place = (
		tree: Tree,
		left: number,
		top: number,
		family: number,
	): number => {
		const { w, h } = size(tree.key);
		const node = nodes.get(tree.key);
		if (!node) return top;
		placed.set(tree.key, {
			key: tree.key,
			ref: node.ref,
			family,
			x: left + (tree.width - w) / 2,
			y: top,
			w,
			h,
		});
		const childrenWidth =
			tree.children.reduce((sum, c) => sum + c.width, 0) +
			Math.max(0, tree.children.length - 1) * options.siblingGap;
		let cursor = left + (tree.width - childrenWidth) / 2;
		let bottom = top + h;
		for (const child of tree.children) {
			bottom = Math.max(
				bottom,
				place(child, cursor, top + h + options.levelGap, family),
			);
			cursor += child.width + options.siblingGap;
		}
		return bottom;
	};

	const families = familiesOf(board);
	let x = 0;
	let rowTop = 0;
	let rowBottom = 0;
	let width = 0;
	families.forEach((family, index) => {
		const ordered = [...family].sort(childOrder);
		const roots: Tree[] = [];
		for (const k of ordered) {
			if (!parentOf.has(k) && !visited.has(k)) roots.push(build(k));
		}
		for (const k of ordered) if (!visited.has(k)) roots.push(build(k));
		const familyWidth =
			roots.reduce((sum, r) => sum + r.width, 0) +
			Math.max(0, roots.length - 1) * options.siblingGap;
		if (x > 0 && x + familyWidth > options.maxWidth) {
			x = 0;
			rowTop = rowBottom + options.rowGap;
		}
		let cursor = x;
		for (const root of roots) {
			rowBottom = Math.max(rowBottom, place(root, cursor, rowTop, index));
			cursor += root.width + options.siblingGap;
		}
		x += familyWidth;
		width = Math.max(width, x);
		x += options.familyGap;
	});

	return { nodes: placed, families, width, height: rowBottom };
}

export function layoutForAspect(
	board: Board,
	aspect: number,
	options: LayoutOptions = defaultLayoutOptions,
): BoardLayout {
	const singleRow = layoutBoard(board, {
		...options,
		maxWidth: Number.POSITIVE_INFINITY,
	});
	const fitScore = (l: BoardLayout) =>
		Math.min(aspect / Math.max(1, l.width), 1 / Math.max(1, l.height));
	let best = singleRow;
	const step = options.subagent.w;
	for (
		let maxWidth = options.session.w;
		maxWidth < singleRow.width;
		maxWidth += step
	) {
		const candidate = layoutBoard(board, { ...options, maxWidth });
		if (fitScore(candidate) > fitScore(best)) best = candidate;
	}
	return best;
}
