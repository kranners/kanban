import { copyFile, cp, mkdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = `${root}src/web/`;
const dist = `${root}dist/`;
const site = `${root}_site/`;
const staticFiles = ["index.html", "favicon.svg", "manifest.webmanifest"];
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

async function bundle(entry: string, outDir: string): Promise<void> {
	const out = outDir.replace(/\/$/, "");
	const next = `${out}.next/`;
	await rm(next, { recursive: true, force: true });
	await mkdir(next, { recursive: true });
	await esbuild.build({
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
		loader: { ".woff2": "file", ".woff": "file", ".svg": "file" },
		assetNames: "assets/[name]-[hash]",
		legalComments: "linked",
		logLevel: "warning",
	});
	await Promise.all(
		staticFiles.map((file) => copyFile(`${web}${file}`, `${next}${file}`)),
	);
	await swapIn(next, out);
}

export const build = (): Promise<void> => bundle(`${web}main.tsx`, dist);

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
