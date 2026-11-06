import { signal } from "@preact/signals";
import {
	type FaceSettings,
	faceSettingsKey,
	parseFaceSettings,
} from "./butlerDm.ts";

// How Butler's DM face shows on this board, kept per browser.

function read(): FaceSettings {
	try {
		return parseFaceSettings(localStorage.getItem(faceSettingsKey));
	} catch {
		return parseFaceSettings(null);
	}
}

export const faceSettings = signal<FaceSettings>(read());

export function setFaceSettings(change: Partial<FaceSettings>): void {
	const next = { ...faceSettings.value, ...change };
	faceSettings.value = next;
	try {
		localStorage.setItem(faceSettingsKey, JSON.stringify(next));
	} catch {}
}

/** Whether the DM's panel stays open over a click outside, until unpinned. */
export const dmPanelPinned = signal(false);
