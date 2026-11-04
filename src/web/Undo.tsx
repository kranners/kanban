import "./undo.css";
import { RotateCcw, TriangleAlert } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { apple } from "./focus/platform.ts";
import { blocked, isTyping } from "./Spawning.tsx";
import { step, undoKey, undoNotice } from "./undo.ts";

export function useUndoShortcut(): void {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.isComposing || isTyping(event.target) || blocked()) return;
			const direction = undoKey(event, apple);
			if (!direction) return;
			event.preventDefault();
			void step(direction);
		};
		addEventListener("keydown", onKeyDown);
		return () => removeEventListener("keydown", onKeyDown);
	}, []);
}

export function UndoToast(): JSX.Element | null {
	const notice = undoNotice.value;
	if (!notice) return null;
	const Icon = notice.failed ? TriangleAlert : RotateCcw;
	return (
		<div
			key={notice.id}
			class={`undo-toast${notice.failed ? " failed" : ""}`}
			role="status"
			aria-live="polite"
			data-no-pan
		>
			<Icon size={14} aria-hidden="true" />
			<span>{notice.text}</span>
		</div>
	);
}
