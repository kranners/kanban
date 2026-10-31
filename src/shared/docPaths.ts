export const maxDocBytes = 10 * 1024 * 1024;
export const maxDocTextBytes = 1024 * 1024;
export const maxDocFiles = 1000;
export const maxDocPathLength = 240;
const maxDocDepth = 8;

export const docTypes: Readonly<Record<string, string>> = {
	".md": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const textExtensions = new Set([".md", ".txt", ".json", ".csv", ".svg"]);
const segmentPattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const schemePattern = /^[a-z][a-z0-9+.-]*:/i;

export const extensionOf = (path: string): string => {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

export const isDocPath = (path: string): boolean => {
	if (path.length === 0 || path.length > maxDocPathLength) return false;
	const segments = path.split("/");
	return (
		segments.length <= maxDocDepth &&
		segments.every((segment) => segmentPattern.test(segment)) &&
		Object.hasOwn(docTypes, extensionOf(path))
	);
};

export const docContentType = (path: string): string =>
	docTypes[extensionOf(path)] ?? "application/octet-stream";

export const isMarkdownPath = (path: string): boolean =>
	extensionOf(path) === ".md";

export const isImagePath = (path: string): boolean =>
	docContentType(path).startsWith("image/");

export const isTextPath = (path: string): boolean =>
	textExtensions.has(extensionOf(path));

export const resolveDocPath = (from: string, href: string): string | null => {
	const target = href.split(/[?#]/, 1)[0] ?? "";
	if (target === "" || target.startsWith("//") || schemePattern.test(target)) {
		return null;
	}
	const parts = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
	for (const segment of target.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment !== "..") parts.push(segment);
		else if (parts.pop() === undefined) return null;
	}
	try {
		const path = decodeURIComponent(parts.join("/"));
		return isDocPath(path) ? path : null;
	} catch {
		return null;
	}
};

export const docFileUrl = (
	store: string,
	path: string,
	version?: number,
): string => {
	const file = path.split("/").map(encodeURIComponent).join("/");
	const query = version === undefined ? "" : `?v=${version}`;
	return `/api/docs/${encodeURIComponent(store)}/files/${file}${query}`;
};
