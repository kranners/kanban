import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = `${root}src/web/`;
const dist = `${root}dist/`;
const staticFiles = ["index.html", "favicon.svg", "manifest.webmanifest"];

export async function build(): Promise<void> {
	await rm(dist, { recursive: true, force: true });
	await mkdir(dist, { recursive: true });
	await esbuild.build({
		entryPoints: [`${web}main.tsx`],
		outfile: `${dist}app.js`,
		bundle: true,
		format: "esm",
		minify: true,
		sourcemap: true,
		target: "es2022",
		jsx: "automatic",
		jsxImportSource: "preact",
		loader: { ".woff2": "file", ".woff": "file" },
		assetNames: "fonts/[name]-[hash]",
		legalComments: "none",
		logLevel: "warning",
	});
	await Promise.all(
		staticFiles.map((file) => copyFile(`${web}${file}`, `${dist}${file}`)),
	);
}

if (import.meta.main) await build();
