import "./focus/focus.css";
import "./docs.css";
import { BookOpen, Download, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
	docFileUrl,
	isImagePath,
	isMarkdownPath,
	resolveDocPath,
} from "../shared/docPaths.ts";
import { linkedTo } from "../shared/relations.ts";
import type { DocFile, DocStore } from "../shared/types.ts";
import { TreeRows, toggled } from "./DocTree.tsx";
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
import { Mermaid } from "./Mermaid.tsx";
import {
	type MarkdownResolver,
	parseMarkdown,
	renderMarkdown,
} from "./markdown.ts";
import { relations } from "./relationState.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { now, openSession, sessionsById } from "./state.ts";
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

function SessionChips(props: { store: string }): JSX.Element | null {
	const sessions = linkedTo(relations.value, { kind: "docs", id: props.store })
		.flatMap((end) =>
			end.kind === "session" ? [sessionsById.value.get(end.id)] : [],
		)
		.filter((session) => session !== undefined);
	if (sessions.length === 0) return null;
	return (
		<ul class="doc-viewer-sessions" aria-label="Linked sessions">
			{sessions.map((session) => (
				<li key={session.id}>
					<button
						type="button"
						class="doc-viewer-session"
						title={`Open ${session.name}`}
						onClick={() => {
							closeDoc();
							openSession(session.id);
						}}
					>
						{session.name}
					</button>
				</li>
			))}
		</ul>
	);
}

export function DocViewer(props: {
	store: DocStore;
	open: OpenDoc;
}): JSX.Element {
	const { store, open } = props;
	const dialog = useRef<HTMLDialogElement>(null);
	const content = useRef<HTMLElement>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	useRestoreFocus();

	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		element.showModal();
		let pressedBackdrop = false;
		const press = (event: PointerEvent) => {
			pressedBackdrop = event.target === element;
		};
		const click = (event: MouseEvent) => {
			if (event.target === element && pressedBackdrop) closeDoc();
		};
		element.addEventListener("pointerdown", press);
		element.addEventListener("click", click);
		return () => {
			element.removeEventListener("pointerdown", press);
			element.removeEventListener("click", click);
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

	return (
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
				<SessionChips store={store.id} />
				{file && (
					<a
						class="focus-button doc-viewer-download"
						href={docFileUrl(store.id, file.path, file.updatedAt)}
						download={file.path.slice(file.path.lastIndexOf("/") + 1)}
					>
						<Download size={14} aria-hidden="true" />
						Download
					</a>
				)}
				<button
					type="button"
					class="focus-button focus-icon-button"
					onClick={closeDoc}
					aria-label="Close"
				>
					<X size={16} />
				</button>
			</header>
			<div class="doc-viewer-main">
				{files.length > 0 && (
					<nav class="doc-viewer-files" aria-label="Files">
						<TreeRows
							nodes={tree}
							depth={0}
							current={path}
							collapsed={collapsed}
							onToggle={(folder) => setCollapsed(toggled(collapsed, folder))}
							onOpen={(next) => openDocStore(store.id, next)}
						/>
					</nav>
				)}
				<article class="doc-viewer-content" ref={content}>
					{file ? (
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
							No docs yet. Link a session to this doc store and it will write
							here as it works.
						</p>
					)}
				</article>
			</div>
		</dialog>
	);
}
