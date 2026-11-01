import "./focus/focus.css";
import "./docs.css";
import {
	BookOpen,
	CircleAlert,
	Download,
	FilePlus,
	Pencil,
	Trash2,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import {
	docFileUrl,
	isImagePath,
	isMarkdownPath,
	isTextPath,
	maxDocTextBytes,
	resolveDocPath,
} from "../shared/docPaths.ts";
import type { DocFile, DocStore } from "../shared/types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { TreeRows, toggled } from "./DocTree.tsx";
import { deleteDocPage, writeDocPage } from "./docActions.ts";
import { pagePathProblem } from "./docShelf.ts";
import { closeDoc, docIndex, type OpenDoc, openDocStore } from "./docState.ts";
import {
	anchorId,
	createSlugger,
	docHome,
	docTree,
	fragmentOf,
	lastUpdated,
	plural,
} from "./docTree.ts";
import { commandKey } from "./focus/platform.ts";
import { Mermaid } from "./Mermaid.tsx";
import {
	type MarkdownResolver,
	parseMarkdown,
	renderMarkdown,
} from "./markdown.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { now } from "./state.ts";
import { ago } from "./time.ts";

type Loaded = { path: string; text: string | null };

function useDocText(path: string | null, url: string | null): Loaded | null {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	useEffect(() => {
		if (!path || !url) return;
		const abort = new AbortController();
		fetch(url, { signal: abort.signal })
			.then((response) => {
				if (!response.ok) throw new Error(`doc ${response.status}`);
				return response.text();
			})
			.then(
				(text) => setLoaded({ path, text }),
				() => {
					if (!abort.signal.aborted) setLoaded({ path, text: null });
				},
			);
		return () => abort.abort();
	}, [path, url]);
	return loaded?.path === path ? loaded : null;
}

function scrollToAnchor(content: HTMLElement | null, fragment: string): void {
	content
		?.querySelector(`#${CSS.escape(anchorId(fragment))}`)
		?.scrollIntoView({ block: "start" });
}

function docResolver(
	store: string,
	page: string,
	files: readonly DocFile[],
	content: { current: HTMLElement | null },
): MarkdownResolver {
	const versionOf = (path: string) =>
		files.find((file) => file.path === path)?.updatedAt;
	return {
		image: (url, alt, title) => {
			const target = resolveDocPath(page, url);
			if (!target) return undefined;
			return (
				<img
					src={docFileUrl(store, target, versionOf(target))}
					alt={alt}
					title={title ?? undefined}
					loading="lazy"
				/>
			);
		},
		link: (url, title, children) => {
			if (url.startsWith("#")) {
				return (
					<a
						href={url}
						title={title ?? undefined}
						onClick={(event) => {
							event.preventDefault();
							scrollToAnchor(content.current, url.slice(1));
						}}
					>
						{children}
					</a>
				);
			}
			const target = resolveDocPath(page, url);
			if (!target) return undefined;
			if (versionOf(target) === undefined) {
				return (
					<span
						class="doc-missing-link"
						title={`${target} isn't in this doc store`}
					>
						{children}
					</span>
				);
			}
			return (
				<a
					href={docFileUrl(store, target)}
					title={title ?? undefined}
					onClick={(event) => {
						if (event.metaKey || event.ctrlKey || event.shiftKey) return;
						event.preventDefault();
						openDocStore(store, target, fragmentOf(url) ?? undefined);
					}}
				>
					{children}
				</a>
			);
		},
		code: (lang, value) =>
			lang === "mermaid" ? <Mermaid code={value} /> : undefined,
		headingId: createSlugger(),
	};
}

function DocPage(props: {
	store: string;
	file: DocFile;
	files: readonly DocFile[];
	content: { current: HTMLElement | null };
	onReady: () => void;
}): JSX.Element {
	const { store, file, files } = props;
	const url = docFileUrl(store, file.path, file.updatedAt);
	const image = isImagePath(file.path);
	const loaded = useDocText(image ? null : file.path, image ? null : url);
	const text = loaded?.text ?? null;
	const root = useMemo(
		() =>
			text !== null && isMarkdownPath(file.path) ? parseMarkdown(text) : null,
		[text, file.path],
	);
	const { onReady } = props;
	useEffect(() => {
		if (image || loaded) onReady();
	}, [image, loaded, onReady]);

	if (image) {
		return (
			<figure class="doc-image">
				<img src={url} alt={file.path} />
			</figure>
		);
	}
	if (!loaded) return <p class="doc-viewer-note">Loading {file.path}…</p>;
	if (text === null) {
		return <p class="doc-viewer-note">Couldn't load {file.path}.</p>;
	}
	if (!root) return <pre class="doc-text">{text}</pre>;
	return (
		<div class="markdown doc-page">
			{renderMarkdown(
				text,
				root,
				undefined,
				docResolver(store, file.path, files, props.content),
			)}
		</div>
	);
}

type Editor = {
	mode: "new" | "edit";
	path: string;
	original: string;
	text: string;
	base: number | null;
};

const textBytes = (text: string) => new TextEncoder().encode(text).length;

function staleNote(editor: Editor, files: readonly DocFile[]): string | null {
	if (editor.mode !== "edit") return null;
	const latest = files.find((file) => file.path === editor.path);
	if (!latest)
		return "This page was deleted while you were editing. Saving puts it back.";
	return latest.updatedAt !== editor.base
		? "A session changed this page while you were editing. Saving replaces its version."
		: null;
}

function PageEditor(props: {
	store: string;
	editor: Editor;
	files: readonly DocFile[];
	onChange: (editor: Editor) => void;
	onCancel: () => void;
	onSaved: (path: string) => void;
}): JSX.Element {
	const { store, editor, files, onChange } = props;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pathField = useRef<HTMLInputElement>(null);
	const textField = useRef<HTMLTextAreaElement>(null);
	const id = useId();

	useEffect(() => {
		if (editor.mode === "new") pathField.current?.focus();
		else textField.current?.focus();
	}, [editor.mode]);

	const save = async (event?: Event) => {
		event?.preventDefault();
		if (busy) return;
		const path = editor.path.trim();
		const problem = editor.mode === "new" ? pagePathProblem(path, files) : null;
		if (problem) {
			setError(problem);
			pathField.current?.focus();
			return;
		}
		if (textBytes(editor.text) > maxDocTextBytes) {
			setError(`Pages are limited to ${maxDocTextBytes / 1024 / 1024} MB`);
			return;
		}
		setBusy(true);
		setError(null);
		const result = await writeDocPage(store, path, editor.text);
		setBusy(false);
		if (result.ok) props.onSaved(result.value.path);
		else setError(result.error);
	};

	const stale = staleNote(editor, files);
	return (
		<form
			class="doc-editor"
			onSubmit={save}
			onKeyDown={(event) => {
				if (
					(event.metaKey || event.ctrlKey) &&
					event.key.toLowerCase() === "s"
				) {
					event.preventDefault();
					void save();
				}
			}}
		>
			{editor.mode === "new" ? (
				<label class="doc-editor-path">
					<span>Path</span>
					<input
						ref={pathField}
						type="text"
						value={editor.path}
						placeholder="notes/setup.md"
						spellcheck={false}
						autocomplete="off"
						disabled={busy}
						aria-invalid={error !== null}
						aria-describedby={error ? `${id}-error` : undefined}
						onInput={(event) => {
							setError(null);
							onChange({ ...editor, path: event.currentTarget.value });
						}}
					/>
				</label>
			) : (
				<p class="doc-editor-heading">Editing {editor.path}</p>
			)}
			{stale && (
				<p class="doc-editor-stale" role="status">
					<CircleAlert size={14} class="doc-alert-icon" aria-hidden="true" />
					{stale}
				</p>
			)}
			<textarea
				ref={textField}
				class="doc-editor-text"
				value={editor.text}
				spellcheck={false}
				disabled={busy}
				aria-label={
					editor.mode === "new" ? "New page content" : `${editor.path} content`
				}
				placeholder={
					editor.mode === "new"
						? "# Title\n\nWhat this page covers…"
						: undefined
				}
				onInput={(event) =>
					onChange({ ...editor, text: event.currentTarget.value })
				}
			/>
			{error && (
				<p id={`${id}-error`} class="doc-editor-error" role="alert">
					{error}
				</p>
			)}
			<footer class="doc-editor-footer">
				<span class="focus-muted focus-form-shortcut">
					<kbd>{commandKey}S</kbd> to save
				</span>
				<button
					type="button"
					class="focus-button"
					disabled={busy}
					onClick={props.onCancel}
				>
					Cancel
				</button>
				<button
					type="submit"
					class="focus-button focus-button-primary"
					disabled={busy}
				>
					{editor.mode === "new" ? "Create page" : "Save"}
				</button>
			</footer>
		</form>
	);
}

async function loadText(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, { cache: "no-store" });
		return response.ok ? await response.text() : null;
	} catch {
		return null;
	}
}

const dirty = (editor: Editor | null): boolean =>
	editor !== null &&
	(editor.text !== editor.original ||
		(editor.mode === "new" && editor.path.trim() !== ""));

export function DocViewer(props: {
	store: DocStore;
	open: OpenDoc;
}): JSX.Element {
	const { store, open } = props;
	const dialog = useRef<HTMLDialogElement>(null);
	const content = useRef<HTMLElement>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [editor, setEditor] = useState<Editor | null>(null);
	const [discard, setDiscard] = useState<(() => void) | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const editorRef = useRef(editor);
	editorRef.current = editor;
	useRestoreFocus();

	const guard = (action: () => void) => {
		if (!dirty(editorRef.current)) {
			setEditor(null);
			action();
		} else
			setDiscard(() => () => {
				setEditor(null);
				action();
			});
	};
	const guardRef = useRef(guard);
	guardRef.current = guard;

	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		element.showModal();
		let pressedBackdrop = false;
		const press = (event: PointerEvent) => {
			pressedBackdrop = event.target === element;
		};
		const click = (event: MouseEvent) => {
			if (event.target === element && pressedBackdrop)
				guardRef.current(closeDoc);
		};
		const cancel = (event: Event) => {
			if (!editorRef.current) return;
			event.preventDefault();
			guardRef.current(() => {});
		};
		element.addEventListener("pointerdown", press);
		element.addEventListener("click", click);
		element.addEventListener("cancel", cancel);
		return () => {
			element.removeEventListener("pointerdown", press);
			element.removeEventListener("click", click);
			element.removeEventListener("cancel", cancel);
		};
	}, []);

	const files = docIndex.value[store.id] ?? [];
	const tree = useMemo(() => docTree(files), [files]);
	const path =
		open.path && files.some((file) => file.path === open.path)
			? open.path
			: docHome(files);
	const file = files.find((candidate) => candidate.path === path);
	const updated = lastUpdated(files);

	const placed = useRef<{ open: OpenDoc; path: string | null } | null>(null);
	const onReady = () => {
		if (placed.current?.open === open && placed.current.path === path) return;
		placed.current = { open, path };
		if (open.anchor) scrollToAnchor(content.current, open.anchor);
		else content.current?.scrollTo({ top: 0 });
	};

	const startEditing = async (target: DocFile) => {
		setProblem(null);
		setLoading(true);
		const text = await loadText(
			docFileUrl(store.id, target.path, target.updatedAt),
		);
		setLoading(false);
		if (text === null) {
			setProblem(`Couldn't load ${target.path} to edit it.`);
			return;
		}
		setEditor({
			mode: "edit",
			path: target.path,
			original: text,
			text,
			base: target.updatedAt,
		});
	};

	const confirmDeletion = async () => {
		const doomed = deleting;
		setDeleting(null);
		if (!doomed) return;
		const result = await deleteDocPage(store.id, doomed);
		if (!result.ok) setProblem(result.error);
		else if (doomed === path) openDocStore(store.id);
	};

	return (
		<>
			<dialog
				class="focus-dialog doc-viewer"
				ref={dialog}
				aria-label={store.title}
				onClose={closeDoc}
			>
				<header class="doc-viewer-header">
					<BookOpen size={18} aria-hidden="true" />
					<div class="doc-viewer-heading">
						<h2>{store.title}</h2>
						<p class="doc-viewer-meta">
							{updated === null
								? "No files yet"
								: `${plural(files.length, "file")} · updated ${ago(updated, now.value)}`}
						</p>
					</div>
					{!editor && (
						<>
							<button
								type="button"
								class="focus-button"
								onClick={() => {
									setProblem(null);
									setEditor({
										mode: "new",
										path: "",
										original: "",
										text: "",
										base: null,
									});
								}}
							>
								<FilePlus size={14} aria-hidden="true" />
								New page
							</button>
							{file && isTextPath(file.path) && (
								<button
									type="button"
									class="focus-button"
									disabled={loading}
									onClick={() => void startEditing(file)}
								>
									<Pencil size={14} aria-hidden="true" />
									Edit
								</button>
							)}
							{file && (
								<>
									<a
										class="focus-button focus-icon-button doc-viewer-download"
										href={docFileUrl(store.id, file.path, file.updatedAt)}
										download={file.path.slice(file.path.lastIndexOf("/") + 1)}
										aria-label="Download"
										title="Download"
									>
										<Download size={14} aria-hidden="true" />
									</a>
									<button
										type="button"
										class="focus-button focus-icon-button"
										aria-label={`Delete ${file.path}`}
										title="Delete page"
										onClick={() => setDeleting(file.path)}
									>
										<Trash2 size={14} />
									</button>
								</>
							)}
						</>
					)}
					<button
						type="button"
						class="focus-button focus-icon-button"
						onClick={() => guard(closeDoc)}
						aria-label="Close"
					>
						<X size={16} />
					</button>
				</header>
				{problem && (
					<p class="doc-viewer-problem" role="alert">
						<CircleAlert size={14} class="doc-alert-icon" aria-hidden="true" />
						{problem}
					</p>
				)}
				<div class="doc-viewer-main">
					{files.length > 0 && (
						<nav class="doc-viewer-files" aria-label="Files">
							<TreeRows
								nodes={tree}
								depth={0}
								current={editor?.mode === "new" ? null : path}
								collapsed={collapsed}
								onToggle={(folder) => setCollapsed(toggled(collapsed, folder))}
								onOpen={(next) => guard(() => openDocStore(store.id, next))}
							/>
						</nav>
					)}
					<article class="doc-viewer-content" ref={content}>
						{editor ? (
							<PageEditor
								store={store.id}
								editor={editor}
								files={files}
								onChange={setEditor}
								onCancel={() => guard(() => {})}
								onSaved={(saved) => {
									setEditor(null);
									openDocStore(store.id, saved);
								}}
							/>
						) : file ? (
							<DocPage
								key={`${store.id}:${file.path}`}
								store={store.id}
								file={file}
								files={files}
								content={content}
								onReady={onReady}
							/>
						) : (
							<p class="doc-viewer-note">
								No pages yet. Sessions write here as they work, or add one with
								New page. Start with an index.md that says what this store
								covers.
							</p>
						)}
					</article>
				</div>
			</dialog>
			{deleting && (
				<ConfirmDialog
					title="Delete page"
					confirmLabel="Delete"
					danger
					onConfirm={() => void confirmDeletion()}
					onCancel={() => setDeleting(null)}
				>
					<p>
						Delete {deleting} from "{store.title}"? Sessions lose it too.
					</p>
				</ConfirmDialog>
			)}
			{discard && (
				<ConfirmDialog
					title="Discard changes"
					confirmLabel="Discard"
					danger
					onConfirm={() => {
						setDiscard(null);
						discard();
					}}
					onCancel={() => setDiscard(null)}
				>
					<p>Your changes to this page aren't saved. Discard them?</p>
				</ConfirmDialog>
			)}
		</>
	);
}
