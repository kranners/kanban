import type { Annotations, DocStore } from "../shared/types.ts";

export const docStoreChoices = (annotations: Annotations): DocStore[] =>
	Object.values(annotations)
		.filter((annotation): annotation is DocStore => annotation.kind === "docs")
		.sort(
			(a, b) =>
				a.title.localeCompare(b.title) ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);

export const pickedStores = (
	value: readonly string[],
	choices: readonly DocStore[],
): string[] => value.filter((id) => choices.some((store) => store.id === id));

export const docsLabel = (
	value: readonly string[],
	choices: readonly DocStore[],
): string => {
	const picked = pickedStores(value, choices);
	if (picked.length === 0) return "No docs";
	if (picked.length > 1) return `${picked.length} doc stores`;
	return choices.find((store) => store.id === picked[0])?.title ?? "No docs";
};

export const toggledStore = (
	value: readonly string[],
	id: string,
	choices: readonly DocStore[],
): string[] => {
	const picked = pickedStores(value, choices);
	return picked.includes(id)
		? picked.filter((other) => other !== id)
		: [...picked, id];
};
