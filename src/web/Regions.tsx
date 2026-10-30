import "./focus/focus.css";
import "./actions.css";
import "./regions.css";
import { CircleAlert, Folder, LoaderCircle, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { groups } from "./arrangement.ts";
import { boardPointAt } from "./Canvas.tsx";
import { colourOf } from "./colours.ts";
import { FolderPicker } from "./FolderPicker.tsx";
import {
	belowLabel,
	groupUnder,
	openRegionMenu,
	openRegionMenuAtPointer,
} from "./Groups.tsx";
import type { Group } from "./groups.ts";
import { ignoreFor } from "./ignoreState.ts";
import { NeedsYouCount, needsYouClass } from "./NeedsYou.tsx";
import { justDragged, projectGestures } from "./projectDrag.ts";
import { RegionControls } from "./RegionControls.tsx";
import {
	createRegion,
	frontGroup,
	regionDialog,
	regionMenu,
	renameRegion,
} from "./regionState.ts";
import type { RegionHandle } from "./regions.ts";
import {
	clearOfProjects,
	framesBesideNew,
	isRegionKey,
	newRegionAt,
	regionEdges,
	storableRegion,
} from "./regions.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { blocked, isTyping, pointerTarget } from "./Spawning.tsx";
import { knownCwds } from "./state.ts";

function gestures(group: Group, handle: RegionHandle) {
	return {
		...projectGestures(group, handle),
		onContextMenu: (event: MouseEvent) =>
			openRegionMenuAtPointer(
				group,
				event,
				boardPointAt(event.clientX, event.clientY) ?? undefined,
			),
	};
}

function ProjectFrame(props: { group: Group }): JSX.Element {
	const { group } = props;
	const { region } = group;
	return (
		<div
			class={`group-frame region region-${colourOf(group.cwd)}${region ? " region-frame" : ""}${needsYouClass(group.members)}${ignoreFor(group.cwd) ? " ignored" : ""}${frontGroup.value === group.key ? " front" : ""}`}
			data-region={region?.id}
			data-group={group.key}
			style={{
				transform: `translate(${group.frame.x}px, ${group.frame.y}px)`,
				width: `${group.frame.w}px`,
				height: `${group.frame.h}px`,
			}}
		>
			<div class="project-bar" {...gestures(group, "move")}>
				<button
					type="button"
					class="group-label"
					title={`${group.cwd} · drag to move, click for ${region ? "options" : "colours"}`}
					aria-haspopup="menu"
					aria-expanded={regionMenu.value?.key === group.key}
					onClick={(event) => {
						if (!justDragged())
							openRegionMenu(group, belowLabel(event.currentTarget));
					}}
				>
					<Folder size={12} aria-hidden="true" />
					<span class="group-label-text">{group.project}</span>
					<NeedsYouCount members={group.members} />
				</button>
				<RegionControls group={group} />
			</div>
			{region &&
				regionEdges.map((edge) => (
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

export function ProjectFrames(props: {
	groups: readonly Group[];
}): JSX.Element {
	return (
		<>
			{props.groups.map((group) => (
				<ProjectFrame key={group.key} group={group} />
			))}
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
	const folder = useRef<HTMLButtonElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);
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
		folder.current?.focus();
		nameInput.current?.focus();
		nameInput.current?.select();
	}, []);

	const close = () => {
		if (!busy) regionDialog.value = null;
	};
	const ready = !busy && (renaming !== null || cwd !== "");

	const submit = async (event: Event) => {
		event.preventDefault();
		if (!ready) return;
		setBusy(true);
		setError(null);
		const result = renaming
			? await renameRegion(renaming.id, name)
			: open.mode === "create"
				? await createRegion({
						cwd,
						...(name.trim() ? { name: name.trim() } : {}),
						...clearOfProjects(
							storableRegion(newRegionAt(open.at)),
							framesBesideNew(cwd, groups.peek()),
						),
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
					<div class="focus-field">
						<span id={`${id}-folder`}>Folder</span>
						<FolderPicker
							variant="field"
							value={cwd}
							recent={knownCwds.value}
							onPick={setCwd}
							labelledBy={`${id}-folder`}
							disabled={busy}
							trigger={folder}
						/>
					</div>
				)}

				<label class="focus-field">
					<span>Name</span>
					<input
						type="text"
						ref={renaming ? nameInput : undefined}
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
		const bringForward = (event: MouseEvent) => {
			const target = event.target as Element;
			const onBoard =
				target.closest("[data-group]") ??
				!target.closest("[data-node], [data-no-pan]");
			if (!target.closest(".viewport") || !onBoard) return;
			const group = groupUnder(event);
			if (group) frontGroup.value = group.key;
		};
		addEventListener("keydown", onKeyDown);
		addEventListener("click", bringForward);
		return () => {
			removeEventListener("keydown", onKeyDown);
			removeEventListener("click", bringForward);
		};
	}, []);
	const open = regionDialog.value;
	return open ? <RegionDialogView open={open} /> : null;
}
