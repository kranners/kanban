const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };

export function moveMenuFocus(menu: HTMLElement, event: KeyboardEvent): void {
	const step = steps[event.key];
	if (step === undefined) return;
	const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
	if (items.length === 0) return;
	event.preventDefault();
	const index = items.indexOf(document.activeElement as HTMLElement);
	const from = index < 0 && step < 0 ? 0 : index;
	items[(from + step + items.length) % items.length]?.focus();
}
