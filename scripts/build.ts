import { copyFile, cp, mkdir, rm } from "node:fs/promises";
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
