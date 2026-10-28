import "./focus.css";
import { CircleAlert, LoaderCircle, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { FolderPicker } from "../FolderPicker.tsx";
import { createSession } from "../spawns.ts";
import { needsTrust } from "./paths.ts";
import { commandKey } from "./platform.ts";

function Failure(props: { error: string; cwd: string }): JSX.Element {
	return (
		<div class="focus-form-error" role="alert">
			<CircleAlert size={14} />
			<div>
				<p>{props.error}</p>
				{needsTrust(props.error) && (
					<p class="focus-muted">
						Claude needs to trust this folder first. Run <code>claude</code>{" "}
						once in <code>{props.cwd}</code>, accept the trust prompt, then try
						again.
					</p>
				)}
			</div>
		</div>
	);
}

export function NewSession(props: {
	cwds: string[];
	onCreated: (short: string) => void;
	onClose: () => void;
}): JSX.Element {
	const dialog = useRef<HTMLDialogElement>(null);
	const folder = useRef<HTMLButtonElement>(null);
	const pressedBackdrop = useRef(false);
	const listId = useId();
	const [cwd, setCwd] = useState("");
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		dialog.current?.showModal();
		folder.current?.focus();
	}, []);

	const ready = cwd !== "" && prompt.trim() !== "" && !busy;

	const submit = async (event?: Event) => {
		event?.preventDefault();
		if (!ready) return;
		setBusy(true);
		setError(null);
		const result = await createSession({
			cwd,
			...(name.trim() ? { name: name.trim() } : {}),
			prompt: prompt.trim(),
		});
		setBusy(false);
		if (result.ok) props.onCreated(result.short);
		else setError(result.error);
	};

	const submitOnShortcut = (event: KeyboardEvent) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
			void submit(event);
	};

	const closeOnBackdrop = (event: MouseEvent) => {
		const onBackdrop = event.target === event.currentTarget;
		if (onBackdrop && pressedBackdrop.current && !busy) props.onClose();
	};

	return (
		<dialog
			class="focus-dialog"
			ref={dialog}
			onCancel={(event) => {
				if (busy) event.preventDefault();
			}}
			onClose={() => {
				if (busy) dialog.current?.showModal();
				else props.onClose();
			}}
			onPointerDown={(event) => {
				pressedBackdrop.current = event.target === event.currentTarget;
			}}
			onClick={closeOnBackdrop}
			onKeyDown={submitOnShortcut}
			aria-labelledby={`${listId}-title`}
		>
			<form class="focus-form" onSubmit={submit}>
				<header class="focus-form-header">
					<h2 id={`${listId}-title`}>New session</h2>
					<button
						type="button"
						class="focus-button focus-icon-button"
						onClick={props.onClose}
						aria-label="Close"
						disabled={busy}
					>
						<X size={16} />
					</button>
				</header>

				<div class="focus-field">
					<span id={`${listId}-folder`}>Folder</span>
					<FolderPicker
						variant="field"
						value={cwd}
						recent={props.cwds}
						onPick={setCwd}
						labelledBy={`${listId}-folder`}
						disabled={busy}
						trigger={folder}
					/>
				</div>

				<label class="focus-field">
					<span>Name</span>
					<input
						type="text"
						value={name}
						onInput={(event) => setName(event.currentTarget.value)}
						placeholder="Optional; Claude Code names it otherwise"
						spellcheck={false}
						autocomplete="off"
					/>
				</label>

				<label class="focus-field">
					<span>First prompt</span>
					<textarea
						rows={5}
						value={prompt}
						onInput={(event) => setPrompt(event.currentTarget.value)}
						placeholder="What should Claude work on?"
						required
					/>
				</label>

				{error && <Failure error={error} cwd={cwd} />}

				<footer class="focus-form-footer">
					<span class="focus-muted focus-form-shortcut">
						<kbd>{commandKey}Enter</kbd> to start
					</span>
					<button
						type="button"
						class="focus-button"
						onClick={props.onClose}
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
						{busy ? "Starting…" : "Start session"}
					</button>
				</footer>
			</form>
		</dialog>
	);
}
