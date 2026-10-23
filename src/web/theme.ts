import { signal } from "@preact/signals";

export type ThemeChoice = "system" | "light" | "dark";

const storageKey = "kanban.theme";

function readChoice(): ThemeChoice {
	try {
		const stored = localStorage.getItem(storageKey);
		if (stored === "light" || stored === "dark") return stored;
	} catch {}
	return "system";
}

export const theme = signal<ThemeChoice>(readChoice());

function apply(choice: ThemeChoice): void {
	if (choice === "system") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = choice;
}

apply(theme.value);

const order: ThemeChoice[] = ["system", "light", "dark"];

export function cycleTheme(): void {
	const next =
		order[(order.indexOf(theme.value) + 1) % order.length] ?? "system";
	theme.value = next;
	apply(next);
	try {
		if (next === "system") localStorage.removeItem(storageKey);
		else localStorage.setItem(storageKey, next);
	} catch {}
}
