import { createHash, randomBytes } from "node:crypto";
import {
	copyFile,
	cp,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = `${root}src/web/`;
const dist = `${root}dist/`;
const site = `${root}_site/`;
const staticFiles = [
	"index.html",
	"offline.html",
	"favicon.svg",
	"manifest.webmanifest",
	"icon-180.png",
	"icon-192.png",
	"icon-512.png",
];
const modules = `${root}node_modules/`;
const siteFiles = {
	"index.html": `${root}site/index.html`,
	"style.css": `${root}site/style.css`,
	"favicon.svg": `${web}favicon.svg`,
	"fonts/inter.woff2": `${modules}@fontsource-variable/inter/files/inter-latin-wght-normal.woff2`,
	"fonts/jetbrains-mono.woff2": `${modules}@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2`,
	media: `${root}docs/media`,
};

// Swap a finished build in place of `out`, so a failed build leaves the
// served copy alone.
export async function swapIn(next: string, out: string): Promise<void> {
	const old = `${out}.old`;
	await rm(old, { recursive: true, force: true });
	try {
		await rename(out, old);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await rename(next, out);
	await rm(old, { recursive: true, force: true });
}

// The runner as one dependency-free file, so a machine needs only Node to
// run it: `node dist/runner.js --hub URL`. The board serves it too, so a
// machine with the token can fetch it from the hub.
export const runnerBuildOptions = (outfile: string): esbuild.BuildOptions => ({
	entryPoints: [`${root}src/runner/main.ts`],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	banner: { js: "#!/usr/bin/env node" },
	legalComments: "none",
	logLevel: "warning",
});

// The service worker's version is a hash of the shell it caches, so a build
// that changes the app makes installed copies fetch the new shell.
export const shellVersion = (files: Buffer[]): string => {
	const hash = createHash("sha256");
	for (const file of files) hash.update(file);
	return hash.digest("hex").slice(0, 16);
};

async function writeServiceWorker(next: string): Promise<void> {
	const shell = await Promise.all(
		["app.js", "app.css", ...staticFiles].map((file) =>
			readFile(`${next}${file}`).catch(() => Buffer.alloc(0)),
		),
	);
	const worker = await readFile(`${web}sw.js`, "utf8");
	await writeFile(
		`${next}sw.js`,
		worker.replace("__BUILD__", shellVersion(shell)),
	);
}

// Each build gets its own id, which the page carries and the server reports
// from `build-id`, so an open page can tell it is older than the server's.
export const newBuildId = (): string =>
	`${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

async function bundle(
	entry: string,
	outDir: string,
	extra: (next: string) => Promise<unknown> = async () => {},
): Promise<void> {
	const out = outDir.replace(/\/$/, "");
	const next = `${out}.next/`;
	await rm(next, { recursive: true, force: true });
	await mkdir(next, { recursive: true });
	const buildId = newBuildId();
	await esbuild.build({
		define: { __KANBAN_BUILD__: JSON.stringify(buildId) },
		entryPoints: { app: entry },
		outdir: next,
		splitting: true,
		chunkNames: "chunks/[name]-[hash]",
		bundle: true,
		format: "esm",
		minify: true,
		sourcemap: true,
		target: "es2022",
		jsx: "automatic",
		jsxImportSource: "preact",
		loader: {
			".woff2": "file",
			".woff": "file",
			".svg": "file",
			".webp": "file",
		},
		assetNames: "assets/[name]-[hash]",
		legalComments: "linked",
		logLevel: "warning",
	});
	await Promise.all(
		staticFiles.map((file) => copyFile(`${web}${file}`, `${next}${file}`)),
	);
	await writeServiceWorker(next);
	await writeFile(`${next}build-id`, `${buildId}\n`);
	await extra(next);
	await swapIn(next, out);
}

export const sheetMarker =
	'<script id="sheet-data" type="application/json">{}</script>';

// Inline text must not close the element it sits in.
const inlineSafe = (text: string, tag: "script" | "style"): string =>
	text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");

/**
 * The card sheet as one page with its script, styles and fonts inside it,
 * so a renderer can draw the board's cards with nothing else to load.
 */
export async function buildSheet(outfile: string): Promise<void> {
	const result = await esbuild.build({
		entryPoints: [`${root}src/sheet/main.tsx`],
		outdir: dirname(outfile),
		write: false,
		bundle: true,
		format: "esm",
		minify: true,
		target: "es2022",
		jsx: "automatic",
		jsxImportSource: "preact",
		loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
		legalComments: "none",
		logLevel: "warning",
	});
	const output = (ext: string) =>
		result.outputFiles.find((file) => file.path.endsWith(ext))?.text ?? "";
	const page = await readFile(`${root}src/sheet/index.html`, "utf8");
	await writeFile(
		outfile,
		page
			.replace("/*__SHEET_CSS__*/", () => inlineSafe(output(".css"), "style"))
			.replace("/*__SHEET_JS__*/", () => inlineSafe(output(".js"), "script")),
	);
}

/** The board's faces as one stylesheet of data: URIs, for pages that link the tokens and load nothing else. */
export async function buildFonts(outfile: string): Promise<void> {
	await esbuild.build({
		entryPoints: [`${root}src/sheet/fonts.css`],
		outfile,
		bundle: true,
		minify: true,
		loader: { ".woff2": "dataurl" },
		legalComments: "none",
		logLevel: "warning",
	});
}

export const build = (): Promise<void> =>
	bundle(`${web}main.tsx`, dist, (next) =>
		Promise.all([
			esbuild.build(runnerBuildOptions(`${next}runner.js`)),
			buildSheet(`${next}sheet.html`),
			copyFile(`${web}tokens.css`, `${next}tokens.css`),
			buildFonts(`${next}fonts.css`),
		]),
	);

export const buildSite = async (): Promise<void> => {
	await rm(site, { recursive: true, force: true });
	await bundle(`${root}src/demo/main.ts`, `${site}demo/`);
	await Promise.all(
		Object.entries(siteFiles).map(([to, from]) =>
			cp(from, `${site}${to}`, { recursive: true }),
		),
	);
};

if (import.meta.main) {
	await (process.argv[2] === "site" ? buildSite() : build());
}
