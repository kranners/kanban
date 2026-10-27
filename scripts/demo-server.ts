import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { contentTypeFor, staticFile } from "../src/server/http.ts";

const site = fileURLToPath(new URL("../_site", import.meta.url));
const port = Number(process.env.PORT ?? 7421);

const kindOf = async (path: string) => {
	try {
		const found = await stat(path);
		return found.isFile() ? "file" : found.isDirectory() ? "directory" : null;
	} catch {
		return null;
	}
};

const server = createServer(async (req, res) => {
	const path = new URL(req.url ?? "/", "http://localhost").pathname;
	const file = staticFile(
		site,
		path.endsWith("/") ? `${path}index.html` : path,
	);
	const kind = file ? await kindOf(file) : null;
	if (file && kind === "file") {
		res.writeHead(200, { "content-type": contentTypeFor(file) });
		createReadStream(file).pipe(res);
		return;
	}
	if (kind === "directory" || path === "/") {
		res.writeHead(302, { location: path === "/" ? "/demo/" : `${path}/` });
		res.end();
		return;
	}
	res.writeHead(404).end("not found");
});

server.listen(port, "127.0.0.1", () => {
	console.log(`demo board on http://127.0.0.1:${port}/demo/`);
});
