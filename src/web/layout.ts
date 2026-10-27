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
	follows?: NodeKey;
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
	subagentColumns: number;
	siblingGap: number;
	levelGap: number;
	familyGap: number;
	rowGap: number;
};

export const sessionLabelHeight = 48;

export const defaultLayoutOptions: LayoutOptions = {
	maxWidth: 2400,
	session: { w: 312, h: 240 },
	subagent: { w: 216, h: 72 },
	subagentColumns: 3,
	siblingGap: 24,
	levelGap: 48,
	familyGap: 144,
	rowGap: 144,
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
};

function collectNodes(board: Board): Map<NodeKey, GraphNode> {
	const nodes = new Map<NodeKey, GraphNode>();
	for (const s of board.sessions) {
		const ref: NodeRef = { kind: "session", id: s.id };
		nodes.set(nodeKey(ref), {
			key: nodeKey(ref),
			ref,
			startedAt: s.startedAt,
		});
	}
	for (const a of board.subagents) {
		const ref: NodeRef = { kind: "subagent", id: a.id };
		nodes.set(nodeKey(ref), {
			key: nodeKey(ref),
			ref,
			startedAt: a.startedAt,
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
	const founded = (group: NodeKey[]) =>
		Math.min(...group.map((k) => nodes.get(k)?.startedAt ?? 0));
	const firstKey = (group: NodeKey[]) => [...group].sort()[0] ?? "";
	return [...groups.values()].sort(
		(a, b) => founded(b) - founded(a) || firstKey(a).localeCompare(firstKey(b)),
	);
}

type Tree = {
	key: NodeKey;
	grid: NodeKey[];
	branches: Tree[];
	width: number;
};

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
	const isLeafSubagent = (tree: Tree) =>
		nodes.get(tree.key)?.ref.kind === "subagent" &&
		tree.grid.length === 0 &&
		tree.branches.length === 0;

	const gridColumns = (count: number) =>
		Math.min(count, options.subagentColumns);
	const gridWidth = (count: number) =>
		count === 0
			? 0
			: gridColumns(count) * (options.subagent.w + options.siblingGap) -
				options.siblingGap;
	const blockWidths = (tree: Tree) => [
		...(tree.grid.length > 0 ? [gridWidth(tree.grid.length)] : []),
		...tree.branches.map((b) => b.width),
	];
	const rowWidth = (widths: number[]) =>
		widths.reduce((sum, w) => sum + w, 0) +
		Math.max(0, widths.length - 1) * options.siblingGap;

	const visited = new Set<NodeKey>();
	const build = (key: NodeKey): Tree => {
		visited.add(key);
		const children = (childrenOf.get(key) ?? [])
			.filter((c) => !visited.has(c))
			.sort(childOrder)
			.map(build);
		const tree: Tree = {
			key,
			grid: children.filter(isLeafSubagent).map((c) => c.key),
			branches: children.filter((c) => !isLeafSubagent(c)),
			width: 0,
		};
		tree.width = Math.max(size(key).w, rowWidth(blockWidths(tree)));
		return tree;
	};

	const placed = new Map<NodeKey, PlacedNode>();
	const put = (key: NodeKey, x: number, y: number, family: number) => {
		const node = nodes.get(key);
		if (node)
			placed.set(key, { key, ref: node.ref, family, x, y, ...size(key) });
	};
	const placeGrid = (
		keys: NodeKey[],
		left: number,
		top: number,
		family: number,
	): number => {
		const { w, h } = options.subagent;
		const columns = gridColumns(keys.length);
		keys.forEach((key, index) => {
			const column = index % columns;
			const row = Math.floor(index / columns);
			put(
				key,
				left + column * (w + options.siblingGap),
				top + row * (h + options.siblingGap),
				family,
			);
		});
		const rows = Math.ceil(keys.length / columns);
		return top + rows * h + (rows - 1) * options.siblingGap;
	};
	const place = (
		tree: Tree,
		left: number,
		top: number,
		family: number,
	): number => {
		const { w, h } = size(tree.key);
		if (!nodes.has(tree.key)) return top;
		put(tree.key, left + (tree.width - w) / 2, top, family);
		const childTop = top + h + options.levelGap;
		let cursor = left + (tree.width - rowWidth(blockWidths(tree))) / 2;
		let bottom = top + h;
		if (tree.grid.length > 0) {
			bottom = Math.max(bottom, placeGrid(tree.grid, cursor, childTop, family));
			cursor += gridWidth(tree.grid.length) + options.siblingGap;
		}
		for (const branch of tree.branches) {
			bottom = Math.max(bottom, place(branch, cursor, childTop, family));
			cursor += branch.width + options.siblingGap;
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
