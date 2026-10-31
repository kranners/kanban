import "./folderPicker.css";
import { BookOpen, Check, ChevronDown } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
	docStoreChoices,
	docsLabel,
	pickedStores,
	toggledStore,
} from "./docsPicker.ts";
import { moveMenuFocus } from "./menuFocus.ts";
import { annotations } from "./state.ts";

export const pickedDocStores = (value: readonly string[]): string[] =>
	pickedStores(value, docStoreChoices(annotations.value));

export function DocsPicker(props: {
	value: readonly string[];
	onChange: (next: string[]) => void;
	variant: "chip" | "field";
	disabled?: boolean;
	labelledBy?: string;
}): JSX.Element | null {
	const trigger = useRef<HTMLButtonElement>(null);
	const root = useRef<HTMLDivElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const id = useId();
	const [open, setOpen] = useState(false);
	const choices = docStoreChoices(annotations.value);
	const picked = pickedStores(props.value, choices);
	const label = docsLabel(picked, choices);

	useEffect(() => {
		if (!open) return;
		menu.current
			?.querySelector<HTMLElement>("[role=menuitemcheckbox]")
			?.focus({ preventScroll: true });
		const closeOutside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		addEventListener("pointerdown", closeOutside, true);
		return () => removeEventListener("pointerdown", closeOutside, true);
	}, [open]);

	if (choices.length === 0) return null;

	const onMenuKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			trigger.current?.focus({ preventScroll: true });
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
				title="Doc stores to link this session to"
				aria-haspopup="menu"
				aria-expanded={open}
				id={id}
				aria-label={props.labelledBy ? undefined : `Doc stores: ${label}`}
				aria-labelledby={props.labelledBy && `${props.labelledBy} ${id}`}
				disabled={props.disabled}
				onClick={() => setOpen(!open)}
			>
				<BookOpen size={12} aria-hidden="true" />
				<span class="folder-picker-name">{label}</span>
				<ChevronDown size={12} aria-hidden="true" />
			</button>
			{open && (
				<div
					ref={menu}
					class="folder-menu"
					role="menu"
					aria-label="Doc stores"
					onKeyDown={onMenuKeyDown}
				>
					{choices.map((store) => {
						const checked = picked.includes(store.id);
						return (
							<button
								key={store.id}
								type="button"
								role="menuitemcheckbox"
								aria-checked={checked}
								class="folder-menu-item"
								onClick={() =>
									props.onChange(toggledStore(picked, store.id, choices))
								}
							>
								<BookOpen size={13} aria-hidden="true" />
								<span class="folder-menu-name">{store.title}</span>
								{checked && <Check size={13} aria-hidden="true" />}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
