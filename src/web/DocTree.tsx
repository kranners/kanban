import { ChevronRight, File, FileImage, FileText, Folder } from "lucide-preact";
import type { JSX } from "preact";
import { isImagePath, isMarkdownPath } from "../shared/docPaths.ts";
import type { DocNode } from "./docTree.ts";

function fileIcon(path: string): JSX.Element {
	if (isImagePath(path)) return <FileImage size={14} aria-hidden="true" />;
	if (isMarkdownPath(path)) return <FileText size={14} aria-hidden="true" />;
	return <File size={14} aria-hidden="true" />;
}

export function TreeRows(props: {
	nodes: DocNode[];
	depth: number;
	current: string | null;
	collapsed: ReadonlySet<string>;
	onToggle: (folder: string) => void;
	onOpen: (path: string) => void;
}): JSX.Element {
	const { nodes, depth, current, collapsed } = props;
	return (
		<ul class="doc-tree">
			{nodes.map((node) =>
				node.kind === "folder" ? (
					<li key={`folder:${node.path}`}>
						<button
							type="button"
							class="doc-tree-row doc-tree-folder"
							style={`--depth: ${depth}`}
							aria-expanded={!collapsed.has(node.path)}
							onClick={() => props.onToggle(node.path)}
						>
							<ChevronRight
								size={12}
								class="doc-tree-chevron"
								aria-hidden="true"
							/>
							<Folder size={14} aria-hidden="true" />
							<span class="doc-tree-name">{node.name}</span>
							<span class="doc-tree-count">{node.count}</span>
						</button>
						{!collapsed.has(node.path) && (
							<TreeRows {...props} nodes={node.children} depth={depth + 1} />
						)}
					</li>
				) : (
					<li key={`file:${node.file.path}`}>
						<button
							type="button"
							class="doc-tree-row"
							style={`--depth: ${depth}`}
							aria-current={node.file.path === current ? "page" : undefined}
							onClick={() => props.onOpen(node.file.path)}
						>
							{fileIcon(node.file.path)}
							<span class="doc-tree-name">{node.name}</span>
						</button>
					</li>
				),
			)}
		</ul>
	);
}

export function toggled(set: ReadonlySet<string>, item: string): Set<string> {
	const next = new Set(set);
	if (next.has(item)) next.delete(item);
	else next.add(item);
	return next;
}
