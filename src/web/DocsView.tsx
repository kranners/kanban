import "./docs.css";
import { signal } from "@preact/signals";
import {
	BookOpen,
	ChevronRight,
	Expand,
	LocateFixed,
	Search,
} from "lucide-preact";
import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import type { DocStore } from "../shared/types.ts";
import { current } from "./annotations.ts";
import { centreOn } from "./Canvas.tsx";
import { TreeRows, toggled } from "./DocTree.tsx";
import { docShelf, type ShelfEntry, shelfFileCount } from "./docShelf.ts";
import { docIndex, openDoc, openDocStore } from "./docState.ts";
import { docTree, lastUpdated, plural } from "./docTree.ts";
import { now } from "./state.ts";
import { ago } from "./time.ts";

const docsQuery = signal("");
const expandedStores = signal<ReadonlySet<string>>(new Set());

function storeMeta(entry: ShelfEntry, filtering: boolean): string {
	const all = docIndex.value[entry.store.id] ?? [];
	if (all.length === 0) return "Empty: link a session to fill it";
	if (filtering && entry.files.length < all.length)
		return `${entry.files.length} of ${plural(all.length, "file")}`;
	const updated = lastUpdated(all);
	return updated === null
		? plural(all.length, "file")
		: `${plural(all.length, "file")} · updated ${ago(updated, now.value)}`;
}

function StoreSection(props: {
	entry: ShelfEntry;
	filtering: boolean;
}): JSX.Element {
	const { entry, filtering } = props;
	const { store, files } = entry;
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const tree = useMemo(() => docTree(files), [files]);
	const expanded = filtering || expandedStores.value.has(store.id);
	const viewing = openDoc.value;
	const currentPath = viewing?.store === store.id ? viewing.path : null;
	return (
		<li class="doc-shelf-store">
			<div class="doc-shelf-head">
				<button
					type="button"
					class="doc-shelf-toggle"
					aria-expanded={expanded}
					disabled={filtering || files.length === 0}
					title={expanded ? "Hide files" : "Show files"}
					onClick={() => {
						expandedStores.value = toggled(expandedStores.value, store.id);
					}}
				>
					<ChevronRight size={12} class="doc-tree-chevron" aria-hidden="true" />
					<BookOpen size={14} aria-hidden="true" />
					<span class="doc-shelf-text">
						<span class="doc-shelf-title">{store.title}</span>
						<span class="doc-shelf-meta">{storeMeta(entry, filtering)}</span>
					</span>
				</button>
				<button
					type="button"
					class="icon-button doc-shelf-action"
					aria-label={`Open ${store.title}`}
					title="Open"
					onClick={() => openDocStore(store.id)}
				>
					<Expand size={14} />
				</button>
				<button
					type="button"
					class="icon-button doc-shelf-action"
					aria-label={`Show ${store.title} on the board`}
					title="Show on the board"
					onClick={() => locate(store)}
				>
					<LocateFixed size={14} />
				</button>
			</div>
			{expanded && files.length > 0 && (
				<TreeRows
					nodes={tree}
					depth={1}
					current={currentPath}
					collapsed={filtering ? new Set() : collapsed}
					onToggle={(folder) => setCollapsed(toggled(collapsed, folder))}
					onOpen={(path) => openDocStore(store.id, path)}
				/>
			)}
		</li>
	);
}

function locate(store: DocStore): void {
	centreOn({ x: store.x, y: store.y, w: store.w, h: store.h });
}

export function DocsView(): JSX.Element {
	const query = docsQuery.value.trim();
	const all = docShelf(current.value, docIndex.value, "");
	const entries = query ? docShelf(current.value, docIndex.value, query) : all;
	if (all.length === 0)
		return (
			<p class="rail-empty">
				No doc stores yet. Add one from the toolbar or press D, then link
				sessions to it: their agents write docs there as they work.
			</p>
		);
	return (
		<div class="docs-view">
			<label class="search">
				<Search size={14} aria-hidden="true" />
				<input
					type="search"
					placeholder="Filter docs"
					value={docsQuery.value}
					onInput={(event) => {
						docsQuery.value = event.currentTarget.value;
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape" && docsQuery.value) {
							event.stopPropagation();
							docsQuery.value = "";
						}
					}}
					aria-label="Filter doc stores and files"
				/>
			</label>
			<p class="rail-section num" aria-live="polite">
				{query
					? entries.length === 0
						? `Nothing matches “${query}”`
						: `${plural(shelfFileCount(entries), "file")} in ${plural(entries.length, "doc store")}`
					: `${plural(all.length, "doc store")} · ${plural(shelfFileCount(all), "file")}`}
			</p>
			<ul class="doc-shelf">
				{entries.map((entry) => (
					<StoreSection
						key={entry.store.id}
						entry={entry}
						filtering={query !== ""}
					/>
				))}
			</ul>
		</div>
	);
}
