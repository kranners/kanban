import "./docs.css";
import { BookOpen, File, Folder } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { linkedTo } from "../shared/relations.ts";
import { type DocStore, maxDocTitle } from "../shared/types.ts";
import { current, editing, save } from "./annotations.ts";
import { docIndex, openDocStore } from "./docState.ts";
import { docPreview, lastUpdated, plural } from "./docTree.ts";
import { defaultDocTitle } from "./notes.ts";
import { RelationHandles } from "./RelationHandles.tsx";
import { relations } from "./relationState.ts";
import { now } from "./state.ts";
import { ago } from "./time.ts";

function rename(store: DocStore, input: string): void {
	if (editing.peek() === store.id) editing.value = null;
	const latest = current.peek()[store.id];
	if (latest?.kind !== "docs") return;
	const title = input.trim() || defaultDocTitle;
	if (title !== latest.title) save([{ ...latest, title }]);
}

function TitleEditor(props: { store: DocStore }): JSX.Element {
	const { store } = props;
	const field = useRef<HTMLInputElement>(null);
	const cancelled = useRef(false);

	useEffect(() => {
		field.current?.focus({ preventScroll: true });
		field.current?.select();
	}, []);

	return (
		<input
			ref={field}
			class="doc-store-title-input"
			defaultValue={store.title}
			maxLength={maxDocTitle}
			spellcheck={false}
			aria-label="Doc store title"
			onBlur={(event) => {
				if (cancelled.current) {
					if (editing.peek() === store.id) editing.value = null;
				} else rename(store, event.currentTarget.value);
			}}
			onKeyDown={(event) => {
				if (event.isComposing) return;
				if (event.key === "Enter" || event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					cancelled.current = event.key === "Escape";
					event.currentTarget.blur();
				}
			}}
		/>
	);
}

export function DocStoreBody(props: {
	store: DocStore;
	editing: boolean;
}): JSX.Element {
	const { store } = props;
	const files = docIndex.value[store.id] ?? [];
	const updated = lastUpdated(files);
	const preview = docPreview(files);
	const linked = linkedTo(relations.value, { kind: "docs", id: store.id });
	return (
		<div class="doc-store-body">
			<header class="doc-store-header">
				<BookOpen size={15} aria-hidden="true" />
				{props.editing ? (
					<TitleEditor store={store} />
				) : (
					<span class="doc-store-title">{store.title}</span>
				)}
			</header>
			<p class="doc-store-meta">
				{updated === null
					? "Empty: link a session to fill it"
					: `${plural(files.length, "file")} · updated ${ago(updated, now.value)}`}
			</p>
			{preview.rows.length > 0 && (
				<ul class="doc-store-tree">
					{preview.rows.map((row) => (
						<li key={`${row.kind}:${row.name}`}>
							{row.kind === "folder" ? (
								<Folder size={12} aria-hidden="true" />
							) : (
								<File size={12} aria-hidden="true" />
							)}
							<span class="doc-store-name">{row.name}</span>
							{row.kind === "folder" && (
								<span class="doc-store-count">{row.count}</span>
							)}
						</li>
					))}
					{preview.more > 0 && (
						<li class="doc-store-more">+{preview.more} more</li>
					)}
				</ul>
			)}
			<footer class="doc-store-footer">
				<span class="doc-store-linked">{linked.length} linked</span>
				<button
					type="button"
					class="doc-store-open"
					onClick={() => openDocStore(store.id)}
				>
					Open
				</button>
			</footer>
			<RelationHandles end={{ kind: "docs", id: store.id }} />
		</div>
	);
}
