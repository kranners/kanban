import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = `${root}src/web/`;
const dist = `${root}dist/`;
const site = `${root}_site/`;
const staticFiles = ["index.html", "favicon.svg", "manifest.webmanifest"];

async function bundle(entry: string, out: string): Promise<void> {
	await rm(out, { recursive: true, force: true });
	await mkdir(out, { recursive: true });
	await esbuild.build({
		entryPoints: [entry],
		outfile: `${out}app.js`,
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
		staticFiles.map((file) => copyFile(`${web}${file}`, `${out}${file}`)),
	);
}

export const build = (): Promise<void> => bundle(`${web}main.tsx`, dist);

export const buildSite = (): Promise<void> =>
	bundle(`${root}src/demo/main.ts`, `${site}demo/`);

if (import.meta.main) {
	await (process.argv[2] === "site" ? buildSite() : build());
}
