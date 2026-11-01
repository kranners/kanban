import "./docs.css";
import { signal } from "@preact/signals";
import {
	BookOpen,
	ChevronRight,
	Expand,
	Pencil,
	Plus,
	Search,
	Trash2,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type DocStore, maxDocTitle } from "../shared/types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { TreeRows, toggled } from "./DocTree.tsx";
import {
	createDocStore,
	deleteDocStore,
	renameDocStore,
} from "./docActions.ts";
import {
	docShelf,
	type ShelfEntry,
	shelfFileCount,
	titleProblem,
} from "./docShelf.ts";
import { docIndex, docStores, openDoc, openDocStore } from "./docState.ts";
import { docTree, lastUpdated, plural } from "./docTree.ts";
import { now } from "./state.ts";
import { ago } from "./time.ts";

const docsQuery = signal("");
const expandedStores = signal<ReadonlySet<string>>(new Set());

function storeMeta(entry: ShelfEntry, filtering: boolean): string {
	const all = docIndex.value[entry.store.id] ?? [];
	if (all.length === 0) return "Empty";
	if (filtering && entry.files.length < all.length)
		return `${entry.files.length} of ${plural(all.length, "file")}`;
	const updated = lastUpdated(all);
	return updated === null
		? plural(all.length, "file")
		: `${plural(all.length, "file")} · updated ${ago(updated, now.value)}`;
}

function TitleField(props: {
	initial: string;
	label: string;
	placeholder?: string;
	onSubmit: (title: string) => Promise<string | null>;
	onDone: () => void;
}): JSX.Element {
	const field = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		field.current?.focus({ preventScroll: true });
		field.current?.select();
	}, []);

	const submit = async (event: Event) => {
		event.preventDefault();
		const title = field.current?.value ?? "";
		const problem = titleProblem(title);
		if (problem) {
			setError(problem);
			return;
		}
		if (title.trim() === props.initial) {
			props.onDone();
			return;
		}
		setBusy(true);
		const failure = await props.onSubmit(title);
		setBusy(false);
		if (failure) {
			setError(failure);
			field.current?.focus();
		} else props.onDone();
	};

	return (
		<form class="doc-shelf-form" onSubmit={submit}>
			<input
				ref={field}
				class="doc-shelf-input"
				defaultValue={props.initial}
				placeholder={props.placeholder}
				maxLength={maxDocTitle}
				spellcheck={false}
				disabled={busy}
				aria-label={props.label}
				aria-invalid={error !== null}
				onInput={() => setError(null)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						props.onDone();
					}
				}}
				onBlur={(event) => {
					const next = event.relatedTarget as Node | null;
					if (!busy && !event.currentTarget.form?.contains(next))
						props.onDone();
				}}
			/>
			{error && (
				<p class="doc-shelf-error" role="alert">
					{error}
				</p>
			)}
		</form>
	);
}

function StoreSection(props: {
	entry: ShelfEntry;
	filtering: boolean;
	onDelete: (store: DocStore) => void;
}): JSX.Element {
	const { entry, filtering } = props;
	const { store, files } = entry;
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [renaming, setRenaming] = useState(false);
	const tree = useMemo(() => docTree(files), [files]);
	const expanded = filtering || expandedStores.value.has(store.id);
	const viewing = openDoc.value;
	const currentPath = viewing?.store === store.id ? viewing.path : null;
	return (
		<li class="doc-shelf-store">
			{renaming ? (
				<TitleField
					initial={store.title}
					label={`Rename ${store.title}`}
					onSubmit={async (title) => {
						const result = await renameDocStore(store.id, title);
						return result.ok ? null : result.error;
					}}
					onDone={() => setRenaming(false)}
				/>
			) : (
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
						<ChevronRight
							size={12}
							class="doc-tree-chevron"
							aria-hidden="true"
						/>
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
						class="icon-button doc-shelf-action doc-shelf-extra"
						aria-label={`Rename ${store.title}`}
						title="Rename"
						onClick={() => setRenaming(true)}
					>
						<Pencil size={14} />
					</button>
					<button
						type="button"
						class="icon-button doc-shelf-action doc-shelf-extra"
						aria-label={`Delete ${store.title}`}
						title="Delete"
						onClick={() => props.onDelete(store)}
					>
						<Trash2 size={14} />
					</button>
				</div>
			)}
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

function deletionQuestion(store: DocStore): string {
	const files = docIndex.value[store.id]?.length ?? 0;
	return files === 0
		? `Delete "${store.title}"? It has no files.`
		: `Delete "${store.title}" and its ${plural(files, "file")}? Sessions lose them too.`;
}

function StoreDeletion(props: {
	store: DocStore;
	onDone: () => void;
}): JSX.Element {
	const { store, onDone } = props;
	const [error, setError] = useState<string | null>(null);
	return (
		<ConfirmDialog
			title="Delete doc store"
			confirmLabel="Delete"
			danger
			onConfirm={() => {
				void deleteDocStore(store.id).then((result) => {
					if (result.ok) onDone();
					else setError(result.error);
				});
			}}
			onCancel={onDone}
		>
			<p>{deletionQuestion(store)}</p>
			{error && (
				<p class="doc-shelf-error" role="alert">
					{error}
				</p>
			)}
		</ConfirmDialog>
	);
}

function NewStore(props: { onDone: () => void }): JSX.Element {
	return (
		<TitleField
			initial=""
			label="New doc store title"
			placeholder="Title, like Architecture"
			onSubmit={async (title) => {
				const result = await createDocStore(title);
				if (!result.ok) return result.error;
				expandedStores.value = new Set([
					...expandedStores.peek(),
					result.value.id,
				]);
				openDocStore(result.value.id);
				return null;
			}}
			onDone={props.onDone}
		/>
	);
}

function AddButton(props: { onClick: () => void }): JSX.Element {
	return (
		<button
			type="button"
			class="icon-button docs-view-add"
			aria-label="New doc store"
			title="New doc store"
			onClick={props.onClick}
		>
			<Plus size={15} />
		</button>
	);
}

export function DocsView(): JSX.Element {
	const [adding, setAdding] = useState(false);
	const [deleting, setDeleting] = useState<DocStore | null>(null);
	const query = docsQuery.value.trim();
	const all = docShelf(docStores.value, docIndex.value, "");
	const entries = query
		? docShelf(docStores.value, docIndex.value, query)
		: all;
	if (all.length === 0)
		return (
			<div class="docs-view">
				<p class="rail-empty">
					No docs yet. Sessions write docs here for each other as they work. You
					can add one too.
				</p>
				{adding ? (
					<NewStore onDone={() => setAdding(false)} />
				) : (
					<button
						type="button"
						class="focus-button docs-view-start"
						onClick={() => setAdding(true)}
					>
						<Plus size={14} aria-hidden="true" />
						New doc store
					</button>
				)}
			</div>
		);
	return (
		<div class="docs-view">
			<div class="docs-view-bar">
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
				<AddButton onClick={() => setAdding(true)} />
			</div>
			{adding && <NewStore onDone={() => setAdding(false)} />}
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
						onDelete={setDeleting}
					/>
				))}
			</ul>
			{deleting && (
				<StoreDeletion store={deleting} onDone={() => setDeleting(null)} />
			)}
		</div>
	);
}
