import "./focus/focus.css";
import "./actions.css";
import "./regions.css";
import { CircleAlert, Folder, LoaderCircle, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { Annotation, Placement, Point } from "../shared/types.ts";
import { preview, save, current as shownAnnotations } from "./annotations.ts";
import {
	arrangement,
	cancelPlacement,
	commitPlacement,
	previewPlacement,
	savedPlacement,
} from "./arrangement.ts";
import { view } from "./Canvas.tsx";
import { colourOf } from "./colours.ts";
import { isAbsoluteDirectory } from "./focus/paths.ts";
import {
	belowLabel,
	openRegionMenu,
	openRegionMenuAtPointer,
} from "./Groups.tsx";
import type { Group } from "./groups.ts";
import type { NodeKey } from "./layout.ts";
import { NeedsYouCount, needsYouClass } from "./NeedsYou.tsx";
import { moved } from "./notes.ts";
import type { Rect } from "./placement.ts";
import {
	cancelRegion,
	commitRegion,
	createRegion,
	previewRegion,
	regionDialog,
	regionMenu,
	renameRegion,
} from "./regionState.ts";
import type { RegionHandle } from "./regions.ts";
import {
	arrangedRegion,
	centredIn,
	isRegionKey,
	newRegionAt,
	rectOf,
	regionEdges,
	storableRegion,
} from "./regions.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { blocked, isTyping, pointerTarget } from "./Spawning.tsx";
import { knownCwds } from "./state.ts";

const dragThreshold = 4;

type Member = { key: NodeKey; at: Point; size: Partial<Placement> };

type Drag = {
	pointerId: number;
	region: string;
	handle: RegionHandle;
	origin: Rect;
	start: Point;
	rect: Rect;
	members: Member[];
	notes: Annotation[];
	moved: boolean;
};

let drag: Drag | null = null;
let dragged = false;

function membersOf(group: Group): Member[] {
	const nodes = arrangement.peek()?.nodes;
	return group.members.flatMap((key) => {
		const node = nodes?.get(key);
		if (!node) return [];
		const saved = savedPlacement(key);
		const size =
			saved?.w !== undefined && saved.h !== undefined
				? { w: saved.w, h: saved.h }
				: {};
		return [{ key, at: { x: node.x, y: node.y }, size }];
	});
}

function carried(notes: Annotation[], origin: Rect, rect: Rect): Annotation[] {
	return notes.map((note) => moved(note, rect.x - origin.x, rect.y - origin.y));
}

function memberPlacement(member: Member, origin: Rect, rect: Rect): Placement {
	return {
		x: member.at.x + rect.x - origin.x,
		y: member.at.y + rect.y - origin.y,
		...member.size,
		pinned: true,
	};
}

function setArranging(on: boolean): void {
	document.querySelector(".viewport")?.classList.toggle("arranging", on);
}

function beginDrag(
	event: PointerEvent,
	group: Group,
	handle: RegionHandle,
): void {
	if (event.button !== 0 || !group.region) return;
	(event.currentTarget as Element).setPointerCapture(event.pointerId);
	const origin = rectOf(group.region);
	const moving = handle === "move";
	drag = {
		pointerId: event.pointerId,
		region: group.region.id,
		handle,
		origin,
		start: { x: event.clientX, y: event.clientY },
		rect: origin,
		members: moving ? membersOf(group) : [],
		notes: moving
			? centredIn(group.frame, Object.values(shownAnnotations.peek()))
			: [],
		moved: false,
	};
}

function continueDrag(event: PointerEvent): void {
	if (!drag || event.pointerId !== drag.pointerId) return;
	const dx = event.clientX - drag.start.x;
	const dy = event.clientY - drag.start.y;
	if (!drag.moved && Math.hypot(dx, dy) < dragThreshold) return;
	drag.moved = true;
	setArranging(true);
	const { k } = view.peek();
	drag.rect = arrangedRegion(drag.origin, drag.handle, dx / k, dy / k);
	previewRegion(drag.region, drag.rect);
	for (const member of drag.members)
		previewPlacement(
			member.key,
			memberPlacement(member, drag.origin, drag.rect),
		);
	if (drag.notes.length > 0)
		preview(carried(drag.notes, drag.origin, drag.rect));
}

function endDrag(event: PointerEvent): void {
	if (!drag || event.pointerId !== drag.pointerId) return;
	const ended = drag;
	drag = null;
	if (!ended.moved) return;
	setArranging(false);
	dragged = true;
	setTimeout(() => {
		dragged = false;
	}, 0);
	if (event.type === "pointercancel") {
		cancelRegion(ended.region);
		for (const member of ended.members) cancelPlacement(member.key);
		if (ended.notes.length > 0) save(ended.notes);
		return;
	}
	void commitRegion(ended.region, storableRegion(ended.rect));
	for (const member of ended.members)
		void commitPlacement(
			member.key,
			memberPlacement(member, ended.origin, ended.rect),
		);
	if (ended.notes.length > 0)
		save(carried(ended.notes, ended.origin, ended.rect));
}

function gestures(group: Group, handle: RegionHandle) {
	return {
		"data-no-pan": true,
		onPointerDown: (event: PointerEvent) => beginDrag(event, group, handle),
		onPointerMove: continueDrag,
		onPointerUp: endDrag,
		onPointerCancel: endDrag,
		onContextMenu: (event: MouseEvent) => openRegionMenuAtPointer(group, event),
	};
}

function RegionFrame(props: { group: Group }): JSX.Element | null {
	const { group } = props;
	const region = group.region;
	if (!region) return null;
	return (
		<div
			class={`group-frame region-frame region region-${colourOf(region.cwd)}${needsYouClass(group.members)}`}
			data-region={region.id}
			style={{
				transform: `translate(${group.frame.x}px, ${group.frame.y}px)`,
				width: `${group.frame.w}px`,
				height: `${group.frame.h}px`,
			}}
		>
			<button
				type="button"
				class="group-label region-label"
				title={`${region.cwd} · drag to move, click for options`}
				aria-haspopup="menu"
				aria-expanded={regionMenu.value?.key === group.key}
				{...gestures(group, "move")}
				onClick={(event) => {
					if (!dragged) openRegionMenu(group, belowLabel(event.currentTarget));
				}}
			>
				<Folder size={12} aria-hidden="true" />
				<span class="group-label-text">{group.project}</span>
				<NeedsYouCount members={group.members} />
			</button>
			{regionEdges.map((edge) => (
				<div
					key={edge}
					class="region-edge"
					data-edge={edge}
					aria-hidden="true"
					{...gestures(group, edge)}
				/>
			))}
		</div>
	);
}

export function RegionFrames(props: { groups: readonly Group[] }): JSX.Element {
	return (
		<>
			{props.groups.map((group) =>
				group.region ? <RegionFrame key={group.key} group={group} /> : null,
			)}
		</>
	);
}

function startRegion(): void {
	const at = pointerTarget()?.board;
	if (at) regionDialog.value = { mode: "create", at };
}

function RegionDialogView(props: {
	open: NonNullable<typeof regionDialog.value>;
}): JSX.Element {
	const { open } = props;
	const dialog = useRef<HTMLDialogElement>(null);
	const first = useRef<HTMLInputElement>(null);
	const pressedBackdrop = useRef(false);
	const id = useId();
	const renaming = open.mode === "rename" ? open.region : null;
	const [cwd, setCwd] = useState("");
	const [name, setName] = useState(renaming?.name ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useRestoreFocus();

	useEffect(() => {
		dialog.current?.showModal();
		first.current?.focus();
		first.current?.select();
	}, []);

	const close = () => {
		if (!busy) regionDialog.value = null;
	};
	const cwdInvalid = cwd !== "" && !isAbsoluteDirectory(cwd);
	const ready = !busy && (renaming !== null || isAbsoluteDirectory(cwd));

	const submit = async (event: Event) => {
		event.preventDefault();
		if (!ready) return;
		setBusy(true);
		setError(null);
		const result = renaming
			? await renameRegion(renaming.id, name)
			: open.mode === "create"
				? await createRegion({
						cwd: cwd.trim(),
						...(name.trim() ? { name: name.trim() } : {}),
						...storableRegion(newRegionAt(open.at)),
					})
				: null;
		setBusy(false);
		if (result && !result.ok) setError(result.error);
		else regionDialog.value = null;
	};

	const title = renaming ? "Rename project region" : "New project region";
	return (
		<dialog
			class="focus-dialog"
			ref={dialog}
			onCancel={(event) => {
				if (busy) event.preventDefault();
			}}
			onClose={close}
			onPointerDown={(event) => {
				pressedBackdrop.current = event.target === event.currentTarget;
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget && pressedBackdrop.current)
					close();
			}}
			onKeyDown={(event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
					void submit(event);
			}}
			aria-labelledby={`${id}-title`}
		>
			<form class="focus-form" onSubmit={submit}>
				<header class="focus-form-header">
					<h2 id={`${id}-title`}>{title}</h2>
					<button
						type="button"
						class="focus-button focus-icon-button"
						onClick={close}
						aria-label="Close"
						disabled={busy}
					>
						<X size={16} />
					</button>
				</header>

				{!renaming && (
					<label class="focus-field">
						<span>Directory</span>
						<input
							type="text"
							ref={first}
							list={`${id}-cwds`}
							value={cwd}
							onInput={(event) => setCwd(event.currentTarget.value)}
							placeholder="/Users/you/dev/project"
							spellcheck={false}
							autocomplete="off"
							aria-invalid={cwdInvalid}
							required
						/>
						<datalist id={`${id}-cwds`}>
							{knownCwds.value.map((option) => (
								<option key={option} value={option} />
							))}
						</datalist>
						{cwdInvalid && (
							<small class="focus-field-hint focus-field-hint-error">
								Use an absolute path starting with /
							</small>
						)}
					</label>
				)}

				<label class="focus-field">
					<span>Name</span>
					<input
						type="text"
						ref={renaming ? first : undefined}
						value={name}
						onInput={(event) => setName(event.currentTarget.value)}
						placeholder="Optional; the directory's name otherwise"
						spellcheck={false}
						autocomplete="off"
						maxLength={60}
					/>
				</label>

				{error && (
					<div class="focus-form-error" role="alert">
						<CircleAlert size={14} />
						<p>{error}</p>
					</div>
				)}

				<footer class="focus-form-footer">
					<button
						type="button"
						class="focus-button"
						onClick={close}
						disabled={busy}
					>
						Cancel
					</button>
					<button
						type="submit"
						class="focus-button focus-button-primary"
						disabled={!ready}
					>
						{busy && <LoaderCircle size={14} class="focus-spin" />}
						{renaming ? "Rename" : "Create region"}
					</button>
				</footer>
			</form>
		</dialog>
	);
}

export function RegionLayer(): JSX.Element | null {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isRegionKey(event, isTyping(event.target)) || blocked()) return;
			event.preventDefault();
			startRegion();
		};
		addEventListener("keydown", onKeyDown);
		return () => removeEventListener("keydown", onKeyDown);
	}, []);
	const open = regionDialog.value;
	return open ? <RegionDialogView open={open} /> : null;
}
