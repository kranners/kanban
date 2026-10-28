import "./folderPicker.css";
import {
	Check,
	ChevronDown,
	CircleAlert,
	Folder,
	FolderOpen,
	LoaderCircle,
} from "lucide-preact";
import type { JSX, RefObject } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { FolderPick } from "../shared/types.ts";
import { directoryName } from "./focus/paths.ts";
import { moveMenuFocus } from "./menuFocus.ts";

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

export function FolderPicker(props: {
	value: string;
	recent: readonly string[];
	onPick: (path: string) => void;
	variant: "chip" | "field";
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
	const [browsing, setBrowsing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		const items =
			menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]");
		const checked = menu.current?.querySelector<HTMLElement>(
			"[aria-checked=true]",
		);
		(checked ?? items?.[0])?.focus({ preventScroll: true });
		const closeOutside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setShown(null);
		};
		addEventListener("pointerdown", closeOutside, true);
		return () => removeEventListener("pointerdown", closeOutside, true);
	}, [open]);

	const close = () => {
		setShown(null);
		trigger.current?.focus({ preventScroll: true });
	};

	const choose = (path: string) => {
		setError(null);
		close();
		props.onPick(path);
	};

	const browse = async () => {
		setShown(null);
		setError(null);
		setBrowsing(true);
		const pick = await pickHostFolder();
		setBrowsing(false);
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
				aria-haspopup="menu"
				aria-expanded={open}
				id={id}
				aria-labelledby={props.labelledBy && `${props.labelledBy} ${id}`}
				disabled={props.disabled || browsing}
				onClick={() => {
					if (props.recent.length === 0) void browse();
					else setShown(open ? null : [...props.recent]);
				}}
			>
				{browsing ? (
					<LoaderCircle size={12} class="focus-spin" aria-hidden="true" />
				) : (
					<Folder size={12} aria-hidden="true" />
				)}
				<span class="folder-picker-name">
					{browsing ? "Choosing on the Mac…" : name || "Choose a folder"}
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
						onClick={() => void browse()}
					>
						<FolderOpen size={13} aria-hidden="true" />
						<span class="folder-menu-name">Choose folder…</span>
					</button>
				</div>
			)}
			{error && (
				<div class="folder-picker-error" role="alert">
					<CircleAlert size={12} aria-hidden="true" />
					<span>{error}</span>
				</div>
			)}
		</div>
	);
}
