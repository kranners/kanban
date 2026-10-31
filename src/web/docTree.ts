import { isMarkdownPath } from "../shared/docPaths.ts";
import type { DocFile } from "../shared/types.ts";

export type DocFolder = {
	kind: "folder";
	name: string;
	path: string;
	count: number;
	children: DocNode[];
};
export type DocLeaf = { kind: "file"; name: string; file: DocFile };
export type DocNode = DocFolder | DocLeaf;

export type DocPreviewRow =
	| { kind: "folder"; name: string; count: number }
	| { kind: "file"; name: string };
export type DocPreview = { rows: DocPreviewRow[]; more: number };

const byName = (a: { name: string }, b: { name: string }) =>
	a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
	a.name.localeCompare(b.name);

function sorted(nodes: DocNode[]): DocNode[] {
	const folders = nodes.filter((node) => node.kind === "folder");
	const files = nodes.filter((node) => node.kind === "file");
	for (const folder of folders) folder.children = sorted(folder.children);
	return [...folders.sort(byName), ...files.sort(byName)];
}

export function docTree(files: readonly DocFile[]): DocNode[] {
	const root: DocNode[] = [];
	for (const file of files) {
		const segments = file.path.split("/");
		const name = segments.pop() ?? file.path;
		let level = root;
		let path = "";
		for (const segment of segments) {
			path = path ? `${path}/${segment}` : segment;
			let folder = level.find(
				(node): node is DocFolder =>
					node.kind === "folder" && node.name === segment,
			);
			if (!folder) {
				folder = {
					kind: "folder",
					name: segment,
					path,
					count: 0,
					children: [],
				};
				level.push(folder);
			}
			folder.count += 1;
			level = folder.children;
		}
		level.push({ kind: "file", name, file });
	}
	return sorted(root);
}

export function docPreview(files: readonly DocFile[], limit = 6): DocPreview {
	const rows: DocPreviewRow[] = docTree(files).map((node) =>
		node.kind === "folder"
			? { kind: "folder", name: node.name, count: node.count }
			: { kind: "file", name: node.name },
	);
	if (rows.length <= limit) return { rows, more: 0 };
	return { rows: rows.slice(0, limit - 1), more: rows.length - limit + 1 };
}

export function docHome(files: readonly DocFile[]): string | null {
	const paths = files.map((file) => file.path);
	const root = paths.filter((path) => !path.includes("/"));
	return (
		root.find((path) => path === "index.md") ??
		root.find((path) => path.toLowerCase() === "readme.md") ??
		paths.find(isMarkdownPath) ??
		paths[0] ??
		null
	);
}

export function lastUpdated(files: readonly DocFile[]): number | null {
	return files.length === 0
		? null
		: Math.max(...files.map((file) => file.updatedAt));
}

export function slugOf(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s+/g, "-");
}

export function createSlugger(): (text: string) => string {
	const seen = new Map<string, number>();
	return (text) => {
		const base = `doc-${slugOf(text)}`;
		const repeats = seen.get(base) ?? 0;
		seen.set(base, repeats + 1);
		return repeats === 0 ? base : `${base}-${repeats}`;
	};
}

function decoded(fragment: string): string {
	try {
		return decodeURIComponent(fragment);
	} catch {
		return fragment;
	}
}

export function anchorId(fragment: string): string {
	return `doc-${slugOf(decoded(fragment))}`;
}

export function fragmentOf(href: string): string | null {
	const hash = href.indexOf("#");
	return hash === -1 || hash === href.length - 1 ? null : href.slice(hash + 1);
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}
