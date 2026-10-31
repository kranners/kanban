import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { confirmDocDeletion, current } from "./annotations.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { DocViewer } from "./DocViewer.tsx";
import {
	closeDoc,
	type DocDeletion,
	docDeletion,
	openDoc,
} from "./docState.ts";
import { plural } from "./docTree.ts";

function deletionQuestion({ stores }: DocDeletion): string {
	const files = stores.reduce((total, store) => total + store.files, 0);
	const [only] = stores;
	return only && stores.length === 1
		? `Delete "${only.title}" and its ${plural(files, "file")}?`
		: `Delete ${stores.length} doc stores and their ${plural(files, "file")}?`;
}

export function DocOverlays(): JSX.Element | null {
	const open = openDoc.value;
	const store = open ? current.value[open.store] : undefined;
	const deletion = docDeletion.value;
	const viewing = open && store?.kind === "docs" ? store : null;

	useEffect(() => {
		if (open && !viewing) closeDoc();
	}, [open, viewing]);

	return (
		<>
			{open && viewing && (
				<DocViewer key={viewing.id} store={viewing} open={open} />
			)}
			{deletion && (
				<ConfirmDialog
					title="Delete doc store"
					confirmLabel="Delete"
					danger
					onConfirm={confirmDocDeletion}
					onCancel={() => {
						docDeletion.value = null;
					}}
				>
					<p>{deletionQuestion(deletion)}</p>
				</ConfirmDialog>
			)}
		</>
	);
}
