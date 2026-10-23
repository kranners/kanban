import "./focus/focus.css";
import "./actions.css";
import { TriangleAlert, X } from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";

export function ConfirmDialog(props: {
	title: string;
	confirmLabel: string;
	danger?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
	children: ComponentChildren;
}): JSX.Element {
	const dialog = useRef<HTMLDialogElement>(null);
	const accept = useRef<HTMLButtonElement>(null);
	const pressedBackdrop = useRef(false);
	const id = useId();

	useEffect(() => {
		dialog.current?.showModal();
		accept.current?.focus();
	}, []);

	const acceptOnEnter = (event: KeyboardEvent) => {
		if (event.key !== "Enter" || event.isComposing) return;
		if ((event.target as Element).closest("[data-cancel]")) return;
		event.preventDefault();
		props.onConfirm();
	};

	return (
		<dialog
			class={`focus-dialog confirm-dialog${props.danger ? " danger" : ""}`}
			ref={dialog}
			onClose={props.onCancel}
			onKeyDown={acceptOnEnter}
			onPointerDown={(event) => {
				pressedBackdrop.current = event.target === event.currentTarget;
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget && pressedBackdrop.current)
					props.onCancel();
			}}
			aria-labelledby={`${id}-title`}
			aria-describedby={`${id}-body`}
		>
			<div class="focus-form">
				<header class="focus-form-header">
					<h2 id={`${id}-title`} class="confirm-title">
						{props.danger && (
							<TriangleAlert
								size={16}
								class="confirm-warning"
								aria-hidden="true"
							/>
						)}
						{props.title}
					</h2>
					<button
						type="button"
						class="focus-button focus-icon-button"
						onClick={props.onCancel}
						aria-label="Close"
						data-cancel
					>
						<X size={16} />
					</button>
				</header>
				<div id={`${id}-body`} class="confirm-body">
					{props.children}
				</div>
				<footer class="focus-form-footer">
					<span class="focus-muted focus-form-shortcut">
						<kbd>Enter</kbd> to confirm · <kbd>Esc</kbd> to cancel
					</span>
					<button
						type="button"
						class="focus-button"
						onClick={props.onCancel}
						data-cancel
					>
						Cancel
					</button>
					<button
						type="button"
						ref={accept}
						class={`focus-button ${props.danger ? "confirm-danger" : "focus-button-primary"}`}
						onClick={props.onConfirm}
					>
						{props.confirmLabel}
					</button>
				</footer>
			</div>
		</dialog>
	);
}
