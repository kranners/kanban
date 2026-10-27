import type { Definition, ListItem, Nodes, Parents, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { type ComponentChildren, h } from "preact";

export type TaskToggle = (marker: number) => void;

type Context = {
	source: string;
	definitions: Map<string, Definition>;
	onToggle: TaskToggle | undefined;
	depth: number;
};

const maxDepth = 32;

const linkProtocols = new Set(["http:", "https:", "mailto:"]);
const taskPrefix = /(?:[-+*]|\d{1,9}[.)])\s+(?=\[[ xX]\])/y;

function plainRoot(source: string): Root {
	return {
		type: "root",
		children: [
			{ type: "paragraph", children: [{ type: "text", value: source }] },
		],
	};
}

export function parseMarkdown(source: string): Root {
	try {
		return fromMarkdown(source, {
			extensions: [gfm()],
			mdastExtensions: [gfmFromMarkdown()],
		});
	} catch {
		return plainRoot(source);
	}
}

export function isPlain(root: Root): boolean {
	return root.children.every((node) => node.type === "paragraph");
}

export function safeHref(url: string): string | undefined {
	const parsed = URL.parse(url);
	return parsed && linkProtocols.has(parsed.protocol) ? parsed.href : undefined;
}

export function taskMarker(source: string, item: ListItem): number | undefined {
	const start = item.position?.start.offset;
	if (item.checked == null || start === undefined) return undefined;
	taskPrefix.lastIndex = start;
	const prefix = taskPrefix.exec(source);
	return prefix ? start + prefix[0].length : undefined;
}

export function toggledTask(source: string, marker: number): string {
	const box = source.slice(marker, marker + 3);
	if (!/^\[[ xX]\]$/.test(box)) return source;
	const mark = box[1] === " " ? "x" : " ";
	return `${source.slice(0, marker + 1)}${mark}${source.slice(marker + 2)}`;
}

function definitionsIn(root: Root): Map<string, Definition> {
	const found = new Map<string, Definition>();
	const pending: Nodes[] = [root];
	for (let node = pending.pop(); node; node = pending.pop()) {
		if (node.type === "definition" && !found.has(node.identifier)) {
			found.set(node.identifier, node);
		}
		if ("children" in node) pending.push(...node.children.toReversed());
	}
	return found;
}

function sourceOf(node: Nodes, context: Context): string {
	const { start, end } = node.position ?? {};
	return start?.offset === undefined || end?.offset === undefined
		? ""
		: context.source.slice(start.offset, end.offset);
}

function deeper(context: Context): Context {
	return { ...context, depth: context.depth + 1 };
}

function children(parent: Parents, context: Context): ComponentChildren[] {
	const inner = deeper(context);
	return parent.children.map((child) => render(child, inner));
}

function link(
	url: string,
	title: string | null | undefined,
	content: ComponentChildren,
): ComponentChildren {
	const href = safeHref(url);
	if (!href) return h("span", null, content);
	return h(
		"a",
		{
			href,
			title: title ?? undefined,
			target: "_blank",
			rel: "noopener noreferrer",
		},
		content,
	);
}

function image(
	url: string,
	alt: string | null | undefined,
	title: string | null | undefined,
): ComponentChildren {
	return link(url, title, alt || url);
}

function listItem(
	item: ListItem,
	tight: boolean,
	context: Context,
): ComponentChildren {
	const content = item.children.map((child) =>
		tight && child.type === "paragraph"
			? children(child, context)
			: render(child, deeper(context)),
	);
	if (item.checked == null) return h("li", null, content);
	const marker = taskMarker(context.source, item);
	const { onToggle } = context;
	return h(
		"li",
		{ class: "task" },
		h("input", {
			type: "checkbox",
			checked: item.checked,
			disabled: marker === undefined || !onToggle,
			"aria-label": item.checked ? "Done" : "Not done",
			onChange: () => {
				if (marker !== undefined) onToggle?.(marker);
			},
		}),
		content,
	);
}

function render(node: Nodes, context: Context): ComponentChildren {
	if (context.depth > maxDepth) return sourceOf(node, context);
	switch (node.type) {
		case "root":
			return children(node, context);
		case "paragraph":
			return h("p", null, children(node, context));
		case "heading":
			return h(`h${node.depth}`, null, children(node, context));
		case "thematicBreak":
			return h("hr", null);
		case "blockquote":
			return h("blockquote", null, children(node, context));
		case "list":
			return h(
				node.ordered ? "ol" : "ul",
				{ start: node.ordered && node.start !== 1 ? node.start : undefined },
				node.children.map((item) => listItem(item, !node.spread, context)),
			);
		case "listItem":
			return listItem(node, false, context);
		case "table": {
			const [head, ...body] = node.children;
			const cells = (row: typeof head, tag: "th" | "td") =>
				h(
					"tr",
					null,
					row?.children.map((cell, index) =>
						h(
							tag,
							{ style: { textAlign: node.align?.[index] ?? undefined } },
							children(cell, context),
						),
					),
				);
			return h(
				"table",
				null,
				h("thead", null, cells(head, "th")),
				body.length > 0 &&
					h(
						"tbody",
						null,
						body.map((row) => cells(row, "td")),
					),
			);
		}
		case "code":
			return h(
				"pre",
				null,
				h(
					"code",
					{ class: node.lang ? `language-${node.lang}` : undefined },
					node.value,
				),
			);
		case "inlineCode":
			return h("code", null, node.value);
		case "text":
		case "html":
			return node.value;
		case "emphasis":
			return h("em", null, children(node, context));
		case "strong":
			return h("strong", null, children(node, context));
		case "delete":
			return h("del", null, children(node, context));
		case "break":
			return h("br", null);
		case "link":
			return link(node.url, node.title, children(node, context));
		case "linkReference": {
			const target = context.definitions.get(node.identifier);
			const content = children(node, context);
			return target ? link(target.url, target.title, content) : content;
		}
		case "image":
			return image(node.url, node.alt, node.title);
		case "imageReference": {
			const target = context.definitions.get(node.identifier);
			return target ? image(target.url, node.alt, target.title) : node.alt;
		}
		case "footnoteReference":
			return h("sup", null, `[${node.label ?? node.identifier}]`);
		case "footnoteDefinition":
			return h(
				"div",
				{ class: "footnote" },
				h("sup", null, `[${node.label ?? node.identifier}]`),
				children(node, context),
			);
		default:
			return null;
	}
}

export function renderMarkdown(
	source: string,
	root: Root = parseMarkdown(source),
	onToggle?: TaskToggle,
): ComponentChildren {
	return render(root, {
		source,
		definitions: definitionsIn(root),
		onToggle,
		depth: 0,
	});
}
