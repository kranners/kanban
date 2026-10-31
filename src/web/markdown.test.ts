import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ComponentChildren, h, type VNode } from "preact";
import {
	isPlain,
	type MarkdownResolver,
	parseMarkdown,
	plainText,
	renderMarkdown,
	safeHref,
	toggledTask,
} from "./markdown.ts";

type Element = { type: string; props: Record<string, unknown> };

function elements(tree: ComponentChildren): Element[] {
	if (Array.isArray(tree)) return tree.flatMap(elements);
	if (tree === null || typeof tree !== "object") return [];
	const node = tree as VNode<Record<string, unknown>>;
	const self =
		typeof node.type === "string"
			? [{ type: node.type, props: node.props }]
			: [];
	return [...self, ...elements(node.props.children as ComponentChildren)];
}

function text(tree: ComponentChildren): string {
	if (Array.isArray(tree)) return tree.map(text).join("");
	if (typeof tree === "string" || typeof tree === "number") return `${tree}`;
	if (tree === null || typeof tree !== "object") return "";
	return text((tree as VNode<{ children?: ComponentChildren }>).props.children);
}

function depthOf(tree: ComponentChildren): number {
	if (Array.isArray(tree)) return Math.max(0, ...tree.map(depthOf));
	if (tree === null || typeof tree !== "object") return 0;
	const node = tree as VNode<{ children?: ComponentChildren }>;
	return 1 + depthOf(node.props.children);
}

function rendered(source: string, onToggle?: (marker: number) => void) {
	const tree = renderMarkdown(source, parseMarkdown(source), onToggle);
	return { tree, elements: elements(tree), text: text(tree) };
}

function assertInert(source: string) {
	const { elements: found } = rendered(source);
	for (const element of found) {
		assert.ok(
			!["script", "iframe", "object", "embed", "style"].includes(element.type),
			`${element.type} rendered from ${source}`,
		);
		assert.equal(element.props.dangerouslySetInnerHTML, undefined);
		for (const [name, value] of Object.entries(element.props)) {
			if (name === "onChange") continue;
			assert.ok(!/^on/i.test(name), `${name} rendered from ${source}`);
			if (name === "href" || name === "src") {
				assert.match(String(value), /^(https?|mailto):/, source);
			}
		}
	}
}

describe("markdown rendering", () => {
	it("reads inline markdown as plain text for one-line labels", () => {
		assert.equal(
			plainText("**Status: background** — removing the `effort` override"),
			"Status: background — removing the effort override",
		);
		assert.equal(plainText("plain words"), "plain words");
	});

	it("renders GitHub-flavoured markdown", () => {
		const { elements: found } = rendered(
			[
				"# Report",
				"",
				"Some *emphasis*, **strong**, ~~gone~~ and `code`.",
				"",
				"> quoted",
				"",
				"1. first",
				"2. second",
				"",
				"| a | b |",
				"|:--|--:|",
				"| 1 | 2 |",
				"",
				"```ts",
				"const x = 1;",
				"```",
				"",
				"---",
				"",
				"[site](https://example.com) and www.example.org",
				"",
				"![chart](https://example.com/chart.png)",
			].join("\n"),
		);
		const types = new Set(found.map((e) => e.type));
		for (const tag of [
			"h1",
			"em",
			"strong",
			"del",
			"code",
			"blockquote",
			"ol",
			"li",
			"table",
			"th",
			"td",
			"pre",
			"hr",
			"a",
		]) {
			assert.ok(types.has(tag), tag);
		}
		const links = found.filter((e) => e.type === "a");
		assert.deepEqual(
			links.map((a) => [a.props.href, a.props.target, a.props.rel]),
			[
				["https://example.com/", "_blank", "noopener noreferrer"],
				["http://www.example.org/", "_blank", "noopener noreferrer"],
				["https://example.com/chart.png", "_blank", "noopener noreferrer"],
			],
		);
		const cells = found.filter((e) => e.type === "th");
		assert.deepEqual(
			cells.map((c) => (c.props.style as { textAlign?: string }).textAlign),
			["left", "right"],
		);
		assert.equal(
			found.find((e) => e.type === "code" && e.props.class)?.props.class,
			"language-ts",
		);
	});

	it("keeps tight list items free of paragraphs", () => {
		const { elements: found } = rendered("- one\n- two");
		assert.equal(found.filter((e) => e.type === "p").length, 0);
	});

	it("resolves reference links", () => {
		const { elements: found } = rendered(
			"[docs][d]\n\n[d]: https://example.com/docs",
		);
		assert.equal(
			found.find((e) => e.type === "a")?.props.href,
			"https://example.com/docs",
		);
	});

	it("shows raw HTML as text instead of running it", () => {
		const source =
			"<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)>";
		assertInert(source);
		const { text: shown, elements: found } = rendered(source);
		assert.ok(shown.includes("<script>alert(1)</script>"));
		assert.ok(shown.includes("<img src=x onerror=alert(1)>"));
		assert.equal(found.filter((e) => e.type === "img").length, 0);
	});

	it("drops dangerous link and image URLs", () => {
		for (const source of [
			"[x](javascript:alert(1))",
			"[x](JAVASCRIPT:alert(1))",
			"[x](java&#x09;script:alert(1))",
			"<javascript:alert(1)>",
			"[x](vbscript:msgbox(1))",
			"[x](data:text/html,<script>alert(1)</script>)",
			"![x](data:image/svg+xml,<svg onload=alert(1)>)",
			"![x](javascript:alert(1))",
			"[x][r]\n\n[r]: javascript:alert(1)",
			'<a href="javascript:alert(1)">x</a>',
			"[x](/api/annotations)",
		]) {
			assertInert(source);
			const { elements: found } = rendered(source);
			assert.equal(
				found.filter((e) => e.type === "a" || e.type === "img").length,
				0,
				source,
			);
		}
	});

	it("accepts only web and mail URLs", () => {
		assert.equal(safeHref("mailto:a@example.com"), "mailto:a@example.com");
		assert.equal(safeHref("ftp://example.com"), undefined);
	});

	it("shows images as links so nothing loads until clicked", () => {
		const { elements: found, text: shown } = rendered(
			"![chart](https://example.com/c.png?leak=1)\n\n![](https://example.com/x.svg)",
		);
		assert.equal(found.filter((e) => e.type === "img").length, 0);
		assert.deepEqual(
			found.filter((e) => e.type === "a").map((a) => a.props.href),
			["https://example.com/c.png?leak=1", "https://example.com/x.svg"],
		);
		assert.ok(shown.includes("chart"));
	});

	it("flattens nesting past a fixed depth instead of overflowing the stack", () => {
		for (const source of [
			`${"> ".repeat(5000)}boom`,
			`${"- ".repeat(800)}x`,
			`${"- ".repeat(3000)}x`,
		]) {
			const { tree, text: shown } = rendered(source);
			assert.ok(depthOf(tree) < 120, source.slice(0, 4));
			assert.ok(shown.includes(source.endsWith("boom") ? "boom" : "x"));
		}
	});

	it("centres only plain paragraphs", () => {
		assert.ok(isPlain(parseMarkdown("Ship *it*\ntoday")));
		assert.ok(isPlain(parseMarkdown("")));
		assert.ok(!isPlain(parseMarkdown("# Ship it")));
		assert.ok(!isPlain(parseMarkdown("- ship it")));
	});
});

describe("task lists", () => {
	const checkboxes = (source: string, onToggle?: (marker: number) => void) =>
		rendered(source, onToggle).elements.filter((e) => e.type === "input");

	it("renders task items as checkboxes", () => {
		const boxes = checkboxes("- [ ] todo\n- [x] done\n- plain");
		assert.deepEqual(
			boxes.map((b) => [b.props.type, b.props.checked]),
			[
				["checkbox", false],
				["checkbox", true],
			],
		);
		assert.ok(boxes.every((b) => b.props.disabled === true));
	});

	it("toggles the source of the clicked item", () => {
		const source =
			"- [ ] one\n- [x]   two\n\n> 1. [X] quoted\n\n* [ ] [link](https://example.com) [ ]";
		const markers: number[] = [];
		const boxes = checkboxes(source, (marker) => markers.push(marker));
		assert.ok(boxes.every((b) => b.props.disabled === false));
		for (const box of boxes) (box.props.onChange as () => void)();
		const toggled = markers.reduce(toggledTask, source);
		assert.equal(
			toggled,
			"- [x] one\n- [ ]   two\n\n> 1. [ ] quoted\n\n* [x] [link](https://example.com) [ ]",
		);
	});

	it("leaves text alone when the marker moved", () => {
		assert.equal(toggledTask("- [ ] one", 0), "- [ ] one");
		assert.equal(toggledTask("- [ ] one", 99), "- [ ] one");
	});
});

describe("resolved markdown", () => {
	const resolve = (source: string, resolver: MarkdownResolver) => {
		const tree = renderMarkdown(
			source,
			parseMarkdown(source),
			undefined,
			resolver,
		);
		return { tree, elements: elements(tree), text: text(tree) };
	};

	it("renders images through the resolver", () => {
		const seen: unknown[] = [];
		const { elements: found } = resolve('![Flow](assets/flow.png "How")', {
			image: (url, alt, title) => {
				seen.push([url, alt, title]);
				return h("img", { src: `/files/${url}`, alt });
			},
		});
		assert.deepEqual(seen, [["assets/flow.png", "Flow", "How"]]);
		const image = found.find((element) => element.type === "img");
		assert.equal(image?.props.src, "/files/assets/flow.png");
	});

	it("hands links to the resolver, which can open another page", () => {
		const opened: string[] = [];
		const { elements: found, text: shown } = resolve(
			"See [setup](guides/setup.md#install) and [site](https://example.com).",
			{
				link: (url, _title, content) =>
					url.startsWith("https:")
						? undefined
						: h("a", { onClick: () => opened.push(url) }, content),
			},
		);
		assert.equal(shown, "See setup and site.");
		const [local, web] = found.filter((element) => element.type === "a");
		assert.ok(local);
		(local.props.onClick as () => void)();
		assert.deepEqual(opened, ["guides/setup.md#install"]);
		assert.equal(web?.props.href, "https://example.com/");
		assert.equal(web?.props.target, "_blank");
	});

	it("gives headings ids", () => {
		let count = 0;
		const { elements: found } = resolve("# One\n\n## Two *parts*", {
			headingId: (heading) => `h${++count}-${heading}`,
		});
		assert.deepEqual(
			found
				.filter((element) => /^h\d$/.test(element.type))
				.map((element) => element.props.id),
			["h1-One", "h2-Two parts"],
		);
		const plain = rendered("# One").elements.find((e) => e.type === "h1");
		assert.equal(plain?.props.id, undefined);
	});

	it("sends mermaid blocks to the code hook and keeps other code", () => {
		const { elements: found } = resolve(
			"```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst a = 1;\n```",
			{
				code: (lang, value) =>
					lang === "mermaid" ? h("figure", { "data-code": value }) : undefined,
			},
		);
		const diagram = found.find((element) => element.type === "figure");
		assert.equal(diagram?.props["data-code"], "graph TD; A-->B");
		const code = found.find((element) => element.type === "code");
		assert.equal(code?.props.class, "language-ts");
		assert.ok(found.some((element) => element.type === "pre"));
	});
});
