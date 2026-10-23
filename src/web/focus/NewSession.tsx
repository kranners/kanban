import "./focus.css";
import { CircleAlert, LoaderCircle, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type {
	NewSessionRequest,
	NewSessionResult,
} from "../../shared/types.ts";
import { directoryName, isAbsoluteDirectory, needsTrust } from "./paths.ts";
import { commandKey } from "./platform.ts";

async function createSession(
	request: NewSessionRequest,
): Promise<NewSessionResult> {
	try {
		const response = await fetch("/api/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
		const text = await response.text();
		try {
			return JSON.parse(text) as NewSessionResult;
		} catch {
			return { ok: false, error: text || `HTTP ${response.status}` };
		}
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

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
	const directory = useRef<HTMLInputElement>(null);
	const pressedBackdrop = useRef(false);
	const listId = useId();
	const [cwd, setCwd] = useState("");
	const [name, setName] = useState("");
	const [nameEdited, setNameEdited] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		dialog.current?.showModal();
		directory.current?.focus();
	}, []);

	const shownName = nameEdited ? name : directoryName(cwd);
	const cwdInvalid = cwd !== "" && !isAbsoluteDirectory(cwd);
	const ready =
		isAbsoluteDirectory(cwd) &&
		shownName.trim() !== "" &&
		prompt.trim() !== "" &&
		!busy;

	const submit = async (event?: Event) => {
		event?.preventDefault();
		if (!ready) return;
		setBusy(true);
		setError(null);
		const result = await createSession({
			cwd: cwd.trim(),
			name: shownName.trim(),
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

				<label class="focus-field">
					<span>Directory</span>
					<input
						type="text"
						ref={directory}
						list={`${listId}-cwds`}
						value={cwd}
						onInput={(event) => setCwd(event.currentTarget.value)}
						placeholder="/Users/you/dev/project"
						spellcheck={false}
						autocomplete="off"
						aria-invalid={cwdInvalid}
						required
					/>
					<datalist id={`${listId}-cwds`}>
						{props.cwds.map((option) => (
							<option key={option} value={option} />
						))}
					</datalist>
					{cwdInvalid && (
						<small class="focus-field-hint focus-field-hint-error">
							Use an absolute path starting with /
						</small>
					)}
				</label>

				<label class="focus-field">
					<span>Name</span>
					<input
						type="text"
						value={shownName}
						onInput={(event) => {
							setNameEdited(true);
							setName(event.currentTarget.value);
						}}
						spellcheck={false}
						autocomplete="off"
						required
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
