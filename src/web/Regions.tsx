import "./focus/focus.css";
import "./actions.css";
import "./regions.css";
import { CircleAlert, Folder, LoaderCircle, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { groups } from "./arrangement.ts";
import { colourOf } from "./colours.ts";
import { isAbsoluteDirectory } from "./focus/paths.ts";
import {
	belowLabel,
	openRegionMenu,
	openRegionMenuAtPointer,
} from "./Groups.tsx";
import type { Group } from "./groups.ts";
import { NeedsYouCount, needsYouClass } from "./NeedsYou.tsx";
import { justDragged, projectGestures } from "./projectDrag.ts";
import {
	createRegion,
	regionDialog,
	regionMenu,
	renameRegion,
} from "./regionState.ts";
import type { RegionHandle } from "./regions.ts";
import {
	clearOfProjects,
	isRegionKey,
	newRegionAt,
	regionEdges,
	storableRegion,
} from "./regions.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { blocked, isTyping, pointerTarget } from "./Spawning.tsx";
import { OutstandingSubagentsCount } from "./SubagentPill.tsx";
import { knownCwds } from "./state.ts";

function gestures(group: Group, handle: RegionHandle) {
	return {
		...projectGestures(group, handle),
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
					if (!justDragged())
						openRegionMenu(group, belowLabel(event.currentTarget));
				}}
			>
				<Folder size={12} aria-hidden="true" />
				<span class="group-label-text">{group.project}</span>
				<NeedsYouCount members={group.members} />
				<OutstandingSubagentsCount members={group.members} />
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
						...clearOfProjects(
							storableRegion(newRegionAt(open.at)),
							groups.peek().map((group) => group.frame),
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
