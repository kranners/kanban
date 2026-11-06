import { Settings } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import "./boardSettings.css";
import type { FaceMode } from "./butlerDm.ts";
import { faceSettings, setFaceSettings } from "./butlerFaceSettings.ts";

// The board's settings, kept per browser: for now how Butler's DM face shows.

const faceModes: { mode: FaceMode; label: string; hint: string }[] = [
	{
		mode: "active",
		label: "Show only when active",
		hint: "Up while Butler works on the board or a DM reply arrives, hidden 4 seconds after",
	},
	{ mode: "always", label: "Always show", hint: "Kept on the board" },
	{
		mode: "never",
		label: "Never show",
		hint: "Only the Butler button, unless hidden below",
	},
];

function SettingsPanel(props: { onClose: () => void }): JSX.Element {
	const settings = faceSettings.value;
	const panel = useRef<HTMLDivElement>(null);

	useEffect(() => {
		panel.current
			?.querySelector<HTMLInputElement>("input:checked")
			?.focus({ preventScroll: true });
	}, []);

	return (
		<div
			class="board-settings-panel"
			role="dialog"
			aria-label="Board settings"
			data-no-pan
			ref={panel}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					props.onClose();
				}
			}}
		>
			<fieldset class="board-settings-group">
				<legend>Butler face</legend>
				<p class="board-settings-note">
					Snappy motion: quick moves, no floating.
				</p>
				{faceModes.map((choice) => (
					<label key={choice.mode} class="board-settings-choice">
						<input
							type="radio"
							name="butler-face"
							value={choice.mode}
							checked={settings.mode === choice.mode}
							onChange={() => setFaceSettings({ mode: choice.mode })}
						/>
						<span>
							{choice.label}
							<span class="board-settings-hint">{choice.hint}</span>
						</span>
					</label>
				))}
				<label class="board-settings-choice">
					<input
						type="checkbox"
						checked={settings.hideButton}
						onChange={(event) =>
							setFaceSettings({ hideButton: event.currentTarget.checked })
						}
					/>
					<span>
						Hide the Butler button
						<span class="board-settings-hint">
							The small face in the corner; B still opens the DM
						</span>
					</span>
				</label>
			</fieldset>
		</div>
	);
}

export function BoardSettingsButton(): JSX.Element {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		const closeOutside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		addEventListener("pointerdown", closeOutside, true);
		return () => removeEventListener("pointerdown", closeOutside, true);
	}, [open]);

	return (
		<div class="board-settings" ref={root}>
			<button
				type="button"
				ref={trigger}
				class="icon-button"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label="Board settings"
				title="Board settings"
				onClick={() => setOpen(!open)}
			>
				<Settings size={16} />
			</button>
			{open && (
				<SettingsPanel
					onClose={() => {
						setOpen(false);
						trigger.current?.focus({ preventScroll: true });
					}}
				/>
			)}
		</div>
	);
}
