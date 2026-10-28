import {
	imageExtensions,
	maxImageBytes,
	maxPromptImages,
} from "../shared/promptImages.ts";
import type { PromptImage } from "../shared/types.ts";

type Candidate = { name: string; type: string; size: number };

export function dataUrl(image: PromptImage): string {
	return `data:${image.type};base64,${image.data}`;
}

export function imageFiles(files: FileList | null | undefined): File[] {
	return [...(files ?? [])].filter((file) => file.type.startsWith("image/"));
}

export function admit<T extends Candidate>(
	held: number,
	files: T[],
): { accepted: T[]; error: string | null } {
	const supported = (file: T) => Object.hasOwn(imageExtensions, file.type);
	const small = (file: T) => file.size <= maxImageBytes;
	const unsupported = files.find((file) => !supported(file));
	const tooBig = files.find((file) => !small(file));
	const usable = files.filter((file) => supported(file) && small(file));
	const room = Math.max(0, maxPromptImages - held);
	const error = unsupported
		? `${unsupported.name || "That image"} isn't a PNG, JPEG, GIF or WebP`
		: tooBig
			? `${tooBig.name || "That image"} is over ${maxImageBytes / 1024 / 1024} MB`
			: usable.length > room
				? `Attach at most ${maxPromptImages} images`
				: null;
	return { accepted: usable.slice(0, room), error };
}

function read(file: File): Promise<PromptImage> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			resolve({ type: file.type, data: url.slice(url.indexOf(",") + 1) });
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

export function readImages(files: File[]): Promise<PromptImage[]> {
	return Promise.all(files.map(read));
}
