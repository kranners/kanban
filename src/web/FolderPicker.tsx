import "./focus/focus.css";
import "./folderPicker.css";
import {
	Check,
	ChevronDown,
	CircleAlert,
	CornerLeftUp,
	Folder,
	FolderOpen,
	House,
	LoaderCircle,
} from "lucide-preact";
import type { JSX, RefObject } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { FolderListing, FolderPick, RunsOn } from "../shared/types.ts";
import { directoryName } from "./focus/paths.ts";
import {
	browseTarget,
	checksFolder,
	childPath,
	fetchFolders,
} from "./folderBrowse.ts";
import { moveMenuFocus } from "./menuFocus.ts";
import { localIsMac } from "./runners.ts";

export async function pickHostFolder(): Promise<FolderPick> {
	try {
		const response = await fetch("/api/folder-picker", { method: "POST" });
		if (!response.ok)
			return {
				ok: false,
				error: `The board server answered HTTP ${response.status}`,
			};
		return (await response.json()) as FolderPick;
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

/**
 * Checks a chosen folder exists on the machine a session would run on, so a
 * Mac path checked against a Linux board says so before the session starts.
 */
export function useFolderProblem(cwd: string, runsOn: RunsOn): string | null {
	const key = `${runsOn}\n${cwd}`;
	const [found, setFound] = useState<{
		key: string;
		problem: string | null;
	} | null>(null);
	useEffect(() => {
		if (cwd === "" || !checksFolder(runsOn)) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			fetchFolders(runsOn, cwd, controller.signal)
				.then((browse) => {
					if (!controller.signal.aborted)
						setFound({ key, problem: browse.ok ? null : browse.error });
				})
				.catch(() => {});
		}, 250);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [key, cwd, runsOn]);
	return found?.key === key ? found.problem : null;
}

export function FolderPicker(props: {
	value: string;
	recent: readonly string[];
	onPick: (path: string) => void;
	variant: "chip" | "field";
	/** Where the session runs, whose disk the folder browser reads. */
	runsOn: RunsOn;
	/** A problem with the chosen folder found up front, shown under it. */
	problem?: string | null;
	labelledBy?: string;
	disabled?: boolean;
	trigger?: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
	const own = useRef<HTMLButtonElement>(null);
	const trigger = props.trigger ?? own;
	const root = useRef<HTMLDivElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const id = useId();
	const [shown, setShown] = useState<readonly string[] | null>(null);
	const open = shown !== null;
	const [browserOpen, setBrowserOpen] = useState(false);
	const [native, setNative] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const target = browseTarget(props.runsOn);
	// The Mac's own folder panel opens on the board's screen, so only offer it
	// for the board's own disk, and only when the board runs on a Mac.
	const nativeShown = target === "local" && localIsMac();

	useEffect(() => {
		if (!open) return;
		const items =
			menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]");
		const checked = menu.current?.querySelector<HTMLElement>(
			"[aria-checked=true]",
		);
		(checked ?? items?.[0])?.focus({ preventScroll: true });
	}, [open]);

	useEffect(() => {
		if (!open && !browserOpen) return;
		const closeOutside = (event: PointerEvent) => {
			if (root.current?.contains(event.target as Node)) return;
			setShown(null);
			setBrowserOpen(false);
		};
		addEventListener("pointerdown", closeOutside, true);
		return () => removeEventListener("pointerdown", closeOutside, true);
	}, [open, browserOpen]);

	const close = () => {
		setShown(null);
		setBrowserOpen(false);
		trigger.current?.focus({ preventScroll: true });
	};

	const choose = (path: string) => {
		setError(null);
		close();
		props.onPick(path);
	};

	const openBrowser = () => {
		setShown(null);
		setError(null);
		setBrowserOpen(true);
	};

	const pickNatively = async () => {
		setShown(null);
		setBrowserOpen(false);
		setError(null);
		setNative(true);
		const pick = await pickHostFolder();
		setNative(false);
		trigger.current?.focus({ preventScroll: true });
		if (pick.ok) props.onPick(pick.path);
		else if ("error" in pick) setError(pick.error);
	};

	const onMenuKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
		} else if (event.key === "Tab") setShown(null);
		else if (menu.current) moveMenuFocus(menu.current, event);
	};

	const name = props.value ? directoryName(props.value) || props.value : "";
	const shownError = error ?? props.problem ?? null;
	return (
		<div
			ref={root}
			class={`folder-picker folder-picker-${props.variant}`}
			data-no-pan
		>
			<button
				type="button"
				ref={trigger}
				class="folder-picker-trigger"
				title={props.value || undefined}
				aria-haspopup={props.recent.length === 0 ? "dialog" : "menu"}
				aria-expanded={open || browserOpen}
				id={id}
				aria-labelledby={props.labelledBy && `${props.labelledBy} ${id}`}
				disabled={props.disabled || native}
				onClick={() => {
					if (browserOpen) close();
					else if (props.recent.length === 0) openBrowser();
					else setShown(open ? null : [...props.recent]);
				}}
			>
				{native ? (
					<LoaderCircle size={12} class="focus-spin" aria-hidden="true" />
				) : (
					<Folder size={12} aria-hidden="true" />
				)}
				<span class="folder-picker-name">
					{native ? "Choosing in the Mac's panel…" : name || "Choose a folder"}
				</span>
				{props.variant === "field" && props.value && (
					<span class="folder-picker-path">{props.value}</span>
				)}
				<ChevronDown size={12} aria-hidden="true" />
			</button>
			{shown && (
				<div
					ref={menu}
					class="folder-menu"
					role="menu"
					aria-label="Project folder"
					onKeyDown={onMenuKeyDown}
				>
					<div class="folder-menu-heading" aria-hidden="true">
						Recent projects
					</div>
					<div class="folder-menu-recent" data-scrollable>
						{shown.map((path) => (
							<button
								key={path}
								type="button"
								role="menuitemradio"
								aria-checked={path === props.value}
								class="folder-menu-item"
								title={path}
								onClick={() => choose(path)}
							>
								<span class="folder-menu-name">
									{directoryName(path) || path}
								</span>
								<span class="folder-menu-path">{path}</span>
								{path === props.value && <Check size={13} aria-hidden="true" />}
							</button>
						))}
					</div>
					<button
						type="button"
						role="menuitem"
						class="folder-menu-item folder-menu-browse"
						onClick={openBrowser}
					>
						<FolderOpen size={13} aria-hidden="true" />
						<span class="folder-menu-name">Choose folder…</span>
					</button>
				</div>
			)}
			{browserOpen && (
				<FolderBrowser
					target={target}
					start={props.value || null}
					onUse={choose}
					onClose={close}
					onNative={nativeShown ? () => void pickNatively() : undefined}
				/>
			)}
			{shownError && !open && !browserOpen && (
				<div class="folder-picker-error" role="alert">
					<CircleAlert size={12} aria-hidden="true" />
					<span>{shownError}</span>
				</div>
			)}
		</div>
	);
}

/**
 * Browses folders on the machine a session runs on, through the board, so a
 * runner's folders are its own and nothing opens on the board's screen.
 */
function FolderBrowser(props: {
	target: string;
	start: string | null;
	onUse: (path: string) => void;
	onClose: () => void;
	onNative?: () => void;
}): JSX.Element {
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLUListElement>(null);
	const request = useRef<AbortController | null>(null);
	const headingId = useId();
	const [listing, setListing] = useState<FolderListing | null>(null);
	const [typed, setTyped] = useState(props.start ?? "");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	/** Lists a folder; with fallback, the machine's default when it fails. */
	const go = async (path: string | null, fallback = false) => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setLoading(true);
		try {
			let found = await fetchFolders(props.target, path, controller.signal);
			let failed: string | null = null;
			if (!found.ok && fallback && path !== null) {
				failed = found.error;
				found = await fetchFolders(props.target, null, controller.signal);
			}
			if (controller.signal.aborted) return;
			if (found.ok) {
				setListing(found.listing);
				setTyped(found.listing.path);
				setError(failed);
			} else {
				setError(found.error);
				// Keep the field on the folder that "Use this folder" would pick.
				if (listing) setTyped(listing.path);
			}
		} catch {
			// Aborted by a newer request, or by the browser closing.
		} finally {
			if (request.current === controller) setLoading(false);
		}
	};

	useEffect(() => {
		input.current?.focus({ preventScroll: true });
		void go(props.start, true);
		return () => request.current?.abort();
	}, [props.target]);

	const goTo = (path: string | null) => {
		void go(path);
		input.current?.focus({ preventScroll: true });
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			props.onClose();
			return;
		}
		if (event.key === "Enter" && event.target === input.current) {
			// Not the surrounding form's submit: go to the typed folder.
			event.preventDefault();
			event.stopPropagation();
			void go(typed.trim() || null);
			return;
		}
		const step =
			event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
		if (step === 0) return;
		const items = [
			...(list.current?.querySelectorAll<HTMLElement>("button:enabled") ?? []),
		];
		if (event.target === input.current) {
			if (step > 0 && items[0]) {
				event.preventDefault();
				items[0].focus();
			}
			return;
		}
		const at = items.indexOf(event.target as HTMLElement);
		if (at < 0) return;
		event.preventDefault();
		const next = at + step;
		if (next < 0) input.current?.focus();
		else items[Math.min(next, items.length - 1)]?.focus();
	};

	const folders = listing?.folders ?? [];
	return (
		<div
			class="folder-menu folder-browser"
			role="dialog"
			aria-labelledby={headingId}
			onKeyDown={onKeyDown}
		>
			<div class="folder-menu-heading" id={headingId}>
				{listing ? `Folders on ${listing.machine}` : "Folders"}
			</div>
			<div class="folder-browser-bar">
				<input
					ref={input}
					type="text"
					class="folder-browser-path"
					value={typed}
					onInput={(event) => setTyped(event.currentTarget.value)}
					placeholder="~/workspace"
					aria-label="Folder path; press Enter to go there"
					spellcheck={false}
					autocomplete="off"
					autocapitalize="off"
				/>
				<button
					type="button"
					class="focus-button focus-icon-button folder-browser-tool"
					title="Up a folder"
					aria-label="Up a folder"
					disabled={!listing?.parent}
					onClick={() => goTo(listing?.parent ?? null)}
				>
					<CornerLeftUp size={14} aria-hidden="true" />
				</button>
				<button
					type="button"
					class="focus-button focus-icon-button folder-browser-tool"
					title="Home folder"
					aria-label="Home folder"
					disabled={!listing}
					onClick={() => goTo(listing?.home ?? null)}
				>
					<House size={14} aria-hidden="true" />
				</button>
			</div>
			{error && (
				<div class="folder-picker-error folder-browser-error" role="alert">
					<CircleAlert size={12} aria-hidden="true" />
					<span>{error}</span>
				</div>
			)}
			<ul
				ref={list}
				class="folder-menu-recent folder-browser-list"
				aria-label={listing ? `Folders in ${listing.path}` : "Folders"}
				aria-busy={loading}
				data-scrollable
			>
				{loading && !listing && (
					<li class="folder-browser-note">
						<LoaderCircle size={13} class="focus-spin" aria-hidden="true" />
						Looking…
					</li>
				)}
				{listing && !loading && folders.length === 0 && (
					<li class="folder-browser-note">No folders inside</li>
				)}
				{listing &&
					folders.map((folder) => (
						<li key={folder}>
							<button
								type="button"
								class="folder-menu-item"
								title={childPath(listing.path, folder)}
								disabled={loading}
								onClick={() => goTo(childPath(listing.path, folder))}
							>
								<Folder size={13} aria-hidden="true" />
								<span class="folder-menu-name">{folder}</span>
							</button>
						</li>
					))}
			</ul>
			{listing?.truncated && (
				<div class="folder-browser-note">
					Showing the first {folders.length} folders; type a path to go further.
				</div>
			)}
			<div class="folder-browser-actions">
				{props.onNative && (
					<button
						type="button"
						class="focus-button folder-browser-native"
						onClick={props.onNative}
						title="Open the Mac's own folder panel on the board's screen"
					>
						<FolderOpen size={13} aria-hidden="true" />
						Mac panel…
					</button>
				)}
				<button type="button" class="focus-button" onClick={props.onClose}>
					Cancel
				</button>
				<button
					type="button"
					class="focus-button focus-button-primary"
					disabled={!listing || loading}
					title={listing?.path}
					onClick={() => listing && props.onUse(listing.path)}
				>
					Use this folder
				</button>
			</div>
		</div>
	);
}
