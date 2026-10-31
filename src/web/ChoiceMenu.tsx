import "./folderPicker.css";
import { Check, ChevronDown, type LucideIcon } from "lucide-preact";
import type { JSX } from "preact";
import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "preact/hooks";
import { moveMenuFocus } from "./menuFocus.ts";
import { fitPadding } from "./viewport.ts";

export type Choice<Value extends string> = {
	value: Value;
	label: string;
	detail?: string;
	/** Short text that never truncates, shown after the detail. */
	meta?: string;
	metaClass?: string;
	/** Tooltip; defaults to the detail and meta. */
	title?: string;
	icon?: LucideIcon;
	blocked?: string | null;
};

export function ChoiceMenu<Value extends string>(props: {
	choices: readonly Choice<Value>[];
	value: Value;
	onPick: (value: Value) => void;
	label: string;
	title: string;
	variant: "chip" | "field";
	labelledBy?: string;
	disabled?: boolean;
	onOpen?: () => void;
}): JSX.Element {
	const trigger = useRef<HTMLButtonElement>(null);
	const root = useRef<HTMLDivElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const id = useId();
	const [open, setOpen] = useState(false);
	const current = props.choices.find(({ value }) => value === props.value);
	const Icon = current?.icon;

	// Keep the open menu inside the board (or the window), so a wide menu
	// near the edge shifts over instead of the board panning to reach it.
	useLayoutEffect(() => {
		const element = menu.current;
		const anchor = root.current;
		if (!open || !element || !anchor) return;
		const board = anchor.closest(".viewport")?.getBoundingClientRect();
		const margin = board ? fitPadding : 8;
		const from = (board?.left ?? 0) + margin;
		const to = (board?.right ?? innerWidth) - margin;
		// Measure from the anchor, since the menu's opening animation scales it.
		const at = anchor.getBoundingClientRect();
		const scale = at.width / (anchor.offsetWidth || at.width) || 1;
		element.style.translate = "";
		element.style.maxWidth = "";
		const room = (to - from) / scale;
		if (element.offsetWidth > room) element.style.maxWidth = `${room}px`;
		const left = at.left + element.offsetLeft * scale;
		const right = left + element.offsetWidth * scale;
		let shift = Math.min(0, to - right);
		if (left + shift < from) shift = from - left;
		if (shift !== 0) element.style.translate = `${shift / scale}px 0`;
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const checked = menu.current?.querySelector<HTMLElement>(
			"[aria-checked=true]",
		);
		checked?.focus({ preventScroll: true });
		const closeOutside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		addEventListener("pointerdown", closeOutside, true);
		return () => removeEventListener("pointerdown", closeOutside, true);
	}, [open]);

	const close = () => {
		setOpen(false);
		trigger.current?.focus({ preventScroll: true });
	};

	const onMenuKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
		} else if (event.key === "Tab") setOpen(false);
		else if (menu.current) moveMenuFocus(menu.current, event);
	};

	return (
		<div
			ref={root}
			class={`folder-picker folder-picker-${props.variant} choice-menu`}
			data-no-pan
		>
			<button
				type="button"
				ref={trigger}
				class="folder-picker-trigger"
				title={props.title}
				aria-haspopup="menu"
				aria-expanded={open}
				id={id}
				aria-label={props.labelledBy ? undefined : props.label}
				aria-labelledby={props.labelledBy && `${props.labelledBy} ${id}`}
				disabled={props.disabled}
				onClick={() => {
					if (!open) props.onOpen?.();
					setOpen(!open);
				}}
			>
				{Icon && <Icon size={12} aria-hidden="true" />}
				<span class="folder-picker-name">{current?.label}</span>
				<ChevronDown size={12} aria-hidden="true" />
			</button>
			{open && (
				<div
					ref={menu}
					class="folder-menu"
					role="menu"
					aria-label={props.label}
					onKeyDown={onMenuKeyDown}
				>
					{props.choices.map((choice) => {
						const ChoiceIcon = choice.icon;
						return (
							<button
								key={choice.value}
								type="button"
								role="menuitemradio"
								aria-checked={choice.value === props.value}
								class="folder-menu-item"
								title={
									choice.blocked ??
									choice.title ??
									[choice.detail, choice.meta].filter(Boolean).join(" · ")
								}
								disabled={Boolean(choice.blocked)}
								onClick={() => {
									close();
									props.onPick(choice.value);
								}}
							>
								{ChoiceIcon && <ChoiceIcon size={13} aria-hidden="true" />}
								<span class="folder-menu-name">{choice.label}</span>
								<span class="folder-menu-path">
									{choice.blocked ?? choice.detail}
								</span>
								{choice.meta && !choice.blocked && (
									<span
										class={`folder-menu-meta${choice.metaClass ? ` ${choice.metaClass}` : ""}`}
									>
										{choice.meta}
									</span>
								)}
								{choice.value === props.value ? (
									<Check size={13} aria-hidden="true" />
								) : (
									choice.meta && <span class="folder-menu-check" />
								)}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
