import { useEffect } from "preact/hooks";

function focusable(element: Element | null): element is HTMLElement {
	return (
		element instanceof HTMLElement &&
		element.isConnected &&
		!element.matches(":disabled")
	);
}

function returnTo(previous: Element | null): HTMLElement | null {
	if (focusable(previous)) return previous;
	const frame = previous?.closest("[data-node]")?.querySelector(".frame");
	return focusable(frame ?? null) ? (frame as HTMLElement) : null;
}

export function useRestoreFocus(active = true): void {
	useEffect(() => {
		if (!active) return;
		const previous = document.activeElement;
		return () => {
			setTimeout(() => {
				const current = document.activeElement;
				if (current && current !== document.body) return;
				returnTo(previous)?.focus({ preventScroll: true });
			}, 0);
		};
	}, [active]);
}
