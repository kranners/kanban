import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { DocViewer } from "./DocViewer.tsx";
import { closeDoc, docStores, openDoc } from "./docState.ts";

export function DocOverlays(): JSX.Element | null {
	const open = openDoc.value;
	const viewing = open
		? docStores.value.find((store) => store.id === open.store)
		: undefined;

	useEffect(() => {
		if (open && !viewing) closeDoc();
	}, [open, viewing]);

	return open && viewing ? (
		<DocViewer key={viewing.id} store={viewing} open={open} />
	) : null;
}
