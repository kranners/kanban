import "./annotations.css";
import {
	BookOpen,
	BringToFront,
	Copy,
	Pencil,
	SendToBack,
	SquareDashed,
	Sticker as StickerIcon,
	StickyNote,
	Trash2,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Annotation, Note, Point, Sticker } from "../shared/types.ts";
import { noteColors } from "../shared/types.ts";
import {
	addDocStore,
	addNote,
	addSticker,
	annotationMenu,
	bringSelectionToFront,
	deleteSelection,
	duplicateSelection,
	editing,
	nudgeSelection,
	ordered,
	preview,
	recolourSelection,
	save,
	saveText,
	select,
	selected,
	selection,
	sendSelectionToBack,
	stickerPicker,
	toggleSelected,
	typeText,
} from "./annotations.ts";
import { boardPointAt, detail, view } from "./Canvas.tsx";
import { DocStoreBody } from "./DocStoreCard.tsx";
import { openDocStore } from "./docState.ts";
import { commandKey } from "./focus/platform.ts";
import {
	isPlain,
	parseMarkdown,
	renderMarkdown,
	toggledTask,
} from "./markdown.ts";
import { moveMenuFocus } from "./menuFocus.ts";
import {
	type AnnotationCommand,
	annotationCommand,
	documentFont,
	gridStep,
	matchingStickers,
	moved,
	noteFontSize,
	noteTextLimit,
	resized,
} from "./notes.ts";
import {
	openReport,
	ReportDashboard,
	ReportHeader,
	ReportModal,
	ReportTimeline,
} from "./ReportView.tsx";
import { regionDialog } from "./regionState.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { blocked, isTyping, pointerTarget } from "./Spawning.tsx";
import { boardMenu } from "./spawns.ts";
import { stickerFiles } from "./stickers/files.ts";
import { stickerManifest } from "./stickers/manifest.ts";

const dragThreshold = 4;
const pickerColumns = 8;
const stickerNames = new Map(stickerManifest.map((s) => [s.id, s.name]));
let justDragged = false;

function position(annotation: Annotation) {
	return {
		transform: `translate(${annotation.x}px, ${annotation.y}px)`,
		width: `${annotation.w}px`,
		height: `${annotation.h}px`,
	};
}

function onNoteControl(event: MouseEvent): boolean {
	const target = event.target as HTMLElement;
	const onScrollbar =
		(target.classList.contains("note-text") ||
			target.classList.contains("report-scroll") ||
			target.classList.contains("timeline-scroll")) &&
		(event.offsetX > target.clientWidth || event.offsetY > target.clientHeight);
	return onScrollbar || target.closest("a, button, input") !== null;
}

function grab(event: PointerEvent, annotation: Annotation): void {
	if (event.button !== 0 || editing.peek() === annotation.id) return;
	if (onNoteControl(event)) return;
	const element = event.currentTarget as HTMLElement;
	const resizing = (event.target as Element).closest("[data-resize]") !== null;
	if (event.shiftKey && !resizing) {
		toggleSelected(annotation.id);
		return;
	}
	const wasSelected = selection.peek().has(annotation.id);
	if (!wasSelected) select([annotation.id]);
	const origins = resizing ? [annotation] : selected.peek();
	const start = { x: event.clientX, y: event.clientY };
	let latest: Annotation[] = origins;
	let dragging = false;
	element.setPointerCapture(event.pointerId);

	const move = (next: PointerEvent) => {
		if (next.pointerId !== event.pointerId) return;
		const sx = next.clientX - start.x;
		const sy = next.clientY - start.y;
		if (!dragging && Math.hypot(sx, sy) < dragThreshold) return;
		dragging = true;
		const { k } = view.peek();
		latest = origins.map((a) =>
			resizing ? resized(a, sx / k, sy / k) : moved(a, sx / k, sy / k),
		);
		preview(latest);
	};
	const finish = (next: PointerEvent) => {
		if (next.pointerId !== event.pointerId) return;
		element.removeEventListener("pointermove", move);
		element.removeEventListener("pointerup", finish);
		element.removeEventListener("pointercancel", finish);
		if (dragging) {
			save(next.type === "pointercancel" ? origins : latest);
			justDragged = true;
			setTimeout(() => {
				justDragged = false;
			}, 0);
		} else if (wasSelected && !resizing) {
			select([annotation.id]);
		}
	};
	element.addEventListener("pointermove", move);
	element.addEventListener("pointerup", finish);
	element.addEventListener("pointercancel", finish);
}

function openMenu(event: MouseEvent, annotation: Annotation): void {
	event.preventDefault();
	event.stopPropagation();
	if (!selection.peek().has(annotation.id)) select([annotation.id]);
	annotationMenu.value = { client: { x: event.clientX, y: event.clientY } };
}

function noteTextStyle(text: string, note: Note, plain: boolean) {
	const size = noteFontSize(
		text,
		note.w,
		note.h,
		plain ? undefined : documentFont,
	);
	return { fontSize: `${size}px` };
}

function noteTextClass(plain: boolean): string {
	return `note-text ${plain ? "plain" : "document"}`;
}

function NoteEditor(props: { note: Note }): JSX.Element {
	const { note } = props;
	const field = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState(note.text);
	const [opened] = useState(note.text);
	const [plain] = useState(() => isPlain(parseMarkdown(note.text)));

	useEffect(() => {
		const element = field.current;
		if (!element) return;
		element.focus({ preventScroll: true });
		element.setSelectionRange(element.value.length, element.value.length);
	}, []);

	const finish = () => {
		if (editing.peek() === note.id) editing.value = null;
		if (text !== opened) saveText(note, text);
	};

	return (
		<textarea
			ref={field}
			class={`${noteTextClass(plain)} note-editor`}
			value={text}
			maxLength={noteTextLimit}
			spellcheck={false}
			aria-label="Note text"
			style={noteTextStyle(text, note, plain)}
			onInput={(event) => {
				const next = event.currentTarget.value;
				setText(next);
				typeText(note, next);
			}}
			onBlur={finish}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					event.currentTarget.blur();
				}
			}}
		/>
	);
}

function NoteMarkdown(props: { note: Note }): JSX.Element {
	const { note } = props;
	const root = useMemo(() => parseMarkdown(note.text), [note.text]);
	const plain = isPlain(root);
	return (
		<div
			class={`${noteTextClass(plain)} markdown`}
			style={noteTextStyle(note.text, note, plain)}
		>
			{renderMarkdown(note.text, root, (marker) =>
				saveText(note, toggledTask(note.text, marker)),
			)}
		</div>
	);
}

function ReportNoteBody(props: { note: Note }): JSX.Element | null {
	const { report } = props.note;
	if (!report) return null;
	const open = () => {
		openReport.value = props.note.id;
	};
	const level = detail.value;
	return (
		<div class={`report-note-body report-${level}`}>
			<div class="report-scroll" data-scrollable>
				{level === "near" ? (
					<ReportDashboard report={report} onOpen={open} />
				) : (
					<div class="report-dashboard">
						<ReportHeader report={report} onOpen={open} />
						{level === "medium" && (
							<ReportTimeline report={report} minuteEm={1} />
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function NoteBody(props: { note: Note; editing: boolean }): JSX.Element {
	const { note } = props;
	if (props.editing) return <NoteEditor note={note} />;
	if (note.report) return <ReportNoteBody note={note} />;
	if (!note.text) {
		return <div class="note-text empty">Double-click to write</div>;
	}
	return <NoteMarkdown note={note} />;
}

function scrollNoteText(event: WheelEvent): void {
	if (event.ctrlKey || event.metaKey) return;
	const body = (event.currentTarget as Element).querySelector(
		".note-text, .report-scroll",
	);
	if (
		body &&
		(body.scrollHeight > body.clientHeight ||
			body.scrollWidth > body.clientWidth)
	) {
		event.stopPropagation();
	}
}

function StickerBody(props: { sticker: Sticker }): JSX.Element {
	const { sticker } = props;
	return (
		<img
			class="sticker-image"
			src={stickerFiles[sticker.sticker]}
			alt={stickerNames.get(sticker.sticker) ?? sticker.sticker}
			draggable={false}
			style={
				sticker.rotation ? { rotate: `${sticker.rotation}deg` } : undefined
			}
		/>
	);
}

function annotationLabel(annotation: Annotation): string | undefined {
	if (annotation.kind === "sticker") {
		return stickerNames.get(annotation.sticker) ?? annotation.sticker;
	}
	if (annotation.kind === "docs") return annotation.title;
	return annotation.text ? undefined : "Empty note";
}

function AnnotationView(props: {
	annotation: Annotation;
	selected: boolean;
	editing: boolean;
}): JSX.Element {
	const { annotation } = props;
	const kindClass =
		annotation.kind === "note"
			? `note note-${annotation.color}${annotation.report ? " report-note" : ""}`
			: annotation.kind;
	return (
		<div
			class={`annotation ${kindClass}${props.selected ? " selected" : ""}${props.editing ? " editing" : ""}`}
			style={position(annotation)}
			data-annotation={annotation.id}
			data-no-pan
			role="note"
			aria-roledescription={annotation.kind}
			aria-label={annotationLabel(annotation)}
			onPointerDown={(event) => grab(event, annotation)}
			onWheel={annotation.kind === "note" ? scrollNoteText : undefined}
			onDblClick={(event) => {
				if (annotation.kind === "sticker" || onNoteControl(event)) return;
				if (annotation.kind === "note" && annotation.report) {
					openReport.value = annotation.id;
					return;
				}
				select([annotation.id]);
				if (annotation.kind === "docs") openDocStore(annotation.id);
				else editing.value = annotation.id;
			}}
			onContextMenu={(event) => openMenu(event, annotation)}
		>
			{annotation.kind === "note" ? (
				<NoteBody note={annotation} editing={props.editing} />
			) : annotation.kind === "sticker" ? (
				<StickerBody sticker={annotation} />
			) : (
				<DocStoreBody store={annotation} editing={props.editing} />
			)}
			{!props.editing && (
				<span class="resize-handle" data-resize aria-hidden="true" />
			)}
		</div>
	);
}

export function ReportModalHost(): JSX.Element | null {
	const id = openReport.value;
	const note = ordered.value.find((a) => a.id === id);
	const report = note?.kind === "note" ? (note.report ?? null) : null;
	return (
		<ReportModal
			report={report}
			onClose={() => {
				openReport.value = null;
			}}
		/>
	);
}

export function AnnotationLayer(): JSX.Element {
	const chosen = selection.value;
	const open = editing.value;
	return (
		<>
			{ordered.value.map((annotation) => (
				<AnnotationView
					key={annotation.id}
					annotation={annotation}
					selected={chosen.has(annotation.id)}
					editing={open === annotation.id}
				/>
			))}
		</>
	);
}

function useDismiss(
	active: boolean,
	panel: { current: HTMLElement | null },
	close: () => void,
): void {
	useEffect(() => {
		if (!active) return;
		const closeOutside = (event: PointerEvent) => {
			if (!panel.current?.contains(event.target as Node)) close();
		};
		const startView = view.peek();
		const stopWatchingView = view.subscribe((v) => {
			if (v !== startView) close();
		});
		addEventListener("pointerdown", closeOutside, true);
		addEventListener("resize", close);
		addEventListener("blur", close);
		return () => {
			stopWatchingView();
			removeEventListener("pointerdown", closeOutside, true);
			removeEventListener("resize", close);
			removeEventListener("blur", close);
		};
	}, [active]);
}

function MenuItem(props: {
	icon: JSX.Element;
	label: string;
	shortcut?: string;
	onSelect: () => void;
	danger?: boolean;
}): JSX.Element {
	return (
		<button
			type="button"
			role="menuitem"
			class={`board-menu-item${props.danger ? " danger" : ""}`}
			onClick={() => {
				annotationMenu.value = null;
				props.onSelect();
			}}
		>
			{props.icon}
			<span class="board-menu-label">{props.label}</span>
			{props.shortcut && <kbd>{props.shortcut}</kbd>}
		</button>
	);
}

const colourNames = {
	yellow: "Yellow",
	pink: "Pink",
	green: "Green",
	blue: "Blue",
	purple: "Purple",
	orange: "Orange",
};

export function AnnotationMenu(): JSX.Element | null {
	const menu = annotationMenu.value;
	const list = useRef<HTMLDivElement>(null);
	useRestoreFocus(menu !== null);
	useDismiss(menu !== null, list, () => {
		annotationMenu.value = null;
	});

	useEffect(() => {
		if (menu) list.current?.querySelector("button")?.focus();
	}, [menu]);

	if (!menu) return null;
	const chosen = selected.value;
	const notes = chosen.filter((a): a is Note => a.kind === "note");
	const single = chosen.length === 1 ? notes[0] : undefined;
	const stores = chosen.filter((a) => a.kind === "docs");
	const store = chosen.length === 1 ? stores[0] : undefined;
	const left = Math.min(menu.client.x, innerWidth - 232);
	const height =
		(notes.length ? 252 : 156) + (store ? 80 : 0) - (stores.length ? 36 : 0);
	const top = Math.min(menu.client.y, innerHeight - height);
	return (
		<div
			class="board-menu annotation-menu"
			role="menu"
			ref={list}
			style={{ left: `${left}px`, top: `${top}px` }}
			onContextMenu={(event) => event.preventDefault()}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					annotationMenu.value = null;
				} else if (list.current) moveMenuFocus(list.current, event);
			}}
		>
			{single && (
				<MenuItem
					icon={<Pencil size={14} aria-hidden="true" />}
					label="Edit text"
					shortcut="Enter"
					onSelect={() => {
						editing.value = single.id;
					}}
				/>
			)}
			{store && (
				<>
					<MenuItem
						icon={<BookOpen size={14} aria-hidden="true" />}
						label="Open docs"
						shortcut="Enter"
						onSelect={() => openDocStore(store.id)}
					/>
					<MenuItem
						icon={<Pencil size={14} aria-hidden="true" />}
						label="Rename"
						onSelect={() => {
							editing.value = store.id;
						}}
					/>
					<span class="board-menu-sep" />
				</>
			)}
			{notes.length > 0 && (
				<fieldset class="swatches" aria-label="Colour">
					{noteColors.map((color) => (
						<button
							key={color}
							type="button"
							role="menuitemradio"
							aria-checked={notes.every((n) => n.color === color)}
							class={`swatch note-${color}`}
							title={colourNames[color]}
							aria-label={colourNames[color]}
							onClick={() => {
								annotationMenu.value = null;
								recolourSelection(color);
							}}
						/>
					))}
				</fieldset>
			)}
			{stores.length === 0 && (
				<MenuItem
					icon={<Copy size={14} aria-hidden="true" />}
					label="Duplicate"
					shortcut={`${commandKey}D`}
					onSelect={duplicateSelection}
				/>
			)}
			<MenuItem
				icon={<BringToFront size={14} aria-hidden="true" />}
				label="Bring to front"
				shortcut={`${commandKey}]`}
				onSelect={bringSelectionToFront}
			/>
			<MenuItem
				icon={<SendToBack size={14} aria-hidden="true" />}
				label="Send to back"
				shortcut={`${commandKey}[`}
				onSelect={sendSelectionToBack}
			/>
			<span class="board-menu-sep" />
			<MenuItem
				icon={<Trash2 size={14} aria-hidden="true" />}
				label="Delete"
				shortcut="⌫"
				onSelect={deleteSelection}
				danger
			/>
		</div>
	);
}

export function StickerPicker(): JSX.Element | null {
	const picker = stickerPicker.value;
	const panel = useRef<HTMLDivElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const matches = useMemo(
		() => matchingStickers(stickerManifest, query),
		[query],
	);
	useRestoreFocus(picker !== null);
	const close = () => {
		stickerPicker.value = null;
	};
	useDismiss(picker !== null, panel, close);

	useEffect(() => {
		setQuery("");
		setActive(0);
		search.current?.focus({ preventScroll: true });
	}, [picker]);

	useEffect(() => {
		panel.current
			?.querySelector(`[data-index="${active}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [active]);

	if (!picker) return null;
	const pick = (id: string | undefined) => {
		if (!id) return;
		close();
		addSticker(id, picker.board);
	};
	const left = Math.max(8, Math.min(picker.client.x, innerWidth - 344));
	const top = Math.max(8, Math.min(picker.client.y, innerHeight - 336));
	return (
		<div
			class="sticker-picker"
			role="dialog"
			aria-label="Add a sticker"
			ref={panel}
			style={{ left: `${left}px`, top: `${top}px` }}
			onContextMenu={(event) => event.preventDefault()}
		>
			<input
				type="search"
				class="sticker-search"
				placeholder="Search stickers"
				aria-label="Search stickers"
				aria-controls="sticker-grid"
				aria-activedescendant={
					matches[active] ? `sticker-${matches[active].id}` : undefined
				}
				value={query}
				ref={search}
				spellcheck={false}
				autocomplete="off"
				onInput={(event) => {
					setQuery(event.currentTarget.value);
					setActive(0);
				}}
				onKeyDown={(event) => {
					if (event.isComposing) return;
					if (event.key === "Escape") {
						event.preventDefault();
						close();
					} else if (event.key === "Enter") {
						event.preventDefault();
						pick(matches[active]?.id);
					} else if (event.key.startsWith("Arrow")) {
						const next = gridStep(
							active,
							event.key,
							pickerColumns,
							matches.length,
						);
						if (
							next !== active ||
							event.key === "ArrowUp" ||
							event.key === "ArrowDown"
						) {
							event.preventDefault();
							setActive(next);
						}
					}
				}}
			/>
			<div
				id="sticker-grid"
				class="sticker-grid"
				role="listbox"
				aria-label="Stickers"
				data-scrollable
			>
				{matches.map((sticker, index) => (
					<button
						key={sticker.id}
						id={`sticker-${sticker.id}`}
						type="button"
						role="option"
						tabIndex={-1}
						aria-selected={index === active}
						data-index={index}
						class="sticker-option"
						title={sticker.name}
						onPointerEnter={() => setActive(index)}
						onClick={() => pick(sticker.id)}
					>
						<img src={stickerFiles[sticker.id]} alt={sticker.name} />
					</button>
				))}
				{matches.length === 0 && (
					<p class="sticker-empty">No stickers match “{query}”</p>
				)}
			</div>
			<p class="sticker-credit">
				Stickers:{" "}
				<a
					href="https://github.com/jdecked/twemoji"
					target="_blank"
					rel="noreferrer"
				>
					Twemoji
				</a>
				,{" "}
				<a
					href="https://creativecommons.org/licenses/by/4.0/"
					target="_blank"
					rel="noreferrer"
				>
					CC-BY 4.0
				</a>
			</p>
		</div>
	);
}

function centre(): { board: Point; client: Point } | null {
	const stage = document.querySelector(".viewport");
	if (!stage) return null;
	const box = stage.getBoundingClientRect();
	const client = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
	const board = boardPointAt(client.x, client.y);
	return board ? { board, client } : null;
}

export function BoardTools(): JSX.Element {
	return (
		<>
			<button
				type="button"
				class="icon-button"
				onClick={() => {
					const at = centre();
					if (at) addNote(at.board);
				}}
				aria-label="Add note"
				title="Add note (N)"
			>
				<StickyNote size={15} />
			</button>
			<button
				type="button"
				class="icon-button"
				onClick={(event) => {
					const at = centre();
					const button = event.currentTarget.getBoundingClientRect();
					if (at) {
						stickerPicker.value = {
							board: at.board,
							client: { x: button.left, y: button.top - 312 },
						};
					}
				}}
				aria-label="Add sticker"
				title="Add sticker (S)"
			>
				<StickerIcon size={15} />
			</button>
			<button
				type="button"
				class="icon-button"
				onClick={() => {
					const at = centre();
					if (at) regionDialog.value = { mode: "create", at: at.board };
				}}
				aria-label="New project region"
				title="New project region (R)"
			>
				<SquareDashed size={15} />
			</button>
			<button
				type="button"
				class="icon-button"
				onClick={() => {
					const at = centre();
					if (at) addDocStore(at.board);
				}}
				aria-label="Add doc store"
				title="Add doc store (D)"
			>
				<BookOpen size={15} />
			</button>
		</>
	);
}

const commands: {
	[K in AnnotationCommand["kind"]]: (
		command: Extract<AnnotationCommand, { kind: K }>,
	) => void;
} = {
	note: () => {
		const at = pointerTarget();
		if (at) addNote(at.board);
	},
	sticker: () => {
		const at = pointerTarget();
		if (at) stickerPicker.value = at;
	},
	docs: () => {
		const at = pointerTarget();
		if (at) addDocStore(at.board);
	},
	open: () => {
		const [only] = selected.peek();
		if (only?.kind === "docs") openDocStore(only.id);
	},
	delete: deleteSelection,
	duplicate: duplicateSelection,
	front: bringSelectionToFront,
	back: sendSelectionToBack,
	edit: () => {
		const [only] = selection.peek();
		if (only) editing.value = only;
	},
	deselect: () => select([]),
	nudge: ({ dx, dy }) => nudgeSelection(dx, dy),
};

function run<K extends AnnotationCommand["kind"]>(
	command: Extract<AnnotationCommand, { kind: K }>,
): void {
	(commands[command.kind as K] as (c: typeof command) => void)(command);
}

function onActivatable(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest("button, a, [role=button], [role=menuitem]") !== null
	);
}

export function useAnnotationGestures(): void {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.isComposing || isTyping(event.target) || blocked()) return;
			const chosen = selected.peek();
			const command = annotationCommand(event, {
				count: chosen.length,
				notes: chosen.filter((a) => a.kind === "note").length,
				docs: chosen.filter((a) => a.kind === "docs").length,
			});
			if (!command) return;
			if (
				boardMenu.peek() &&
				command.kind !== "note" &&
				command.kind !== "sticker" &&
				command.kind !== "docs"
			)
				return;
			if (
				(command.kind === "edit" || command.kind === "open") &&
				onActivatable(event.target)
			)
				return;
			if (command.kind === "deselect" && document.querySelector(".board-menu"))
				return;
			event.preventDefault();
			run(command);
		};
		const onClick = (event: MouseEvent) => {
			const target = event.target as Element;
			if (justDragged || event.shiftKey) return;
			if (!target.closest(".viewport") || target.closest("[data-no-pan]"))
				return;
			if (selection.peek().size > 0) select([]);
		};
		addEventListener("keydown", onKeyDown);
		addEventListener("click", onClick);
		return () => {
			removeEventListener("keydown", onKeyDown);
			removeEventListener("click", onClick);
		};
	}, []);
}
