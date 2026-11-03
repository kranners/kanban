// The board's service worker caches the app shell alone, so an installed
// board opens to an offline page rather than a browser error when the Mac
// can't be reached. It never touches the API, the feed or anything else that
// carries the board's data, which always goes to the network. The build
// stamps the version, so every build installs a fresh shell and drops the
// old one.
const version = "__BUILD__";
const shell = `kanban-shell-${version}`;
const precache = [
	"offline.html",
	"manifest.webmanifest",
	"favicon.svg",
	"icon-180.png",
	"icon-192.png",
	"icon-512.png",
];
const shellFiles = new Set(["/", "/index.html", "/app.js", "/app.css"]);
const hashed = /^\/(?:chunks|assets)\//;

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(shell)
			.then((cache) => cache.addAll(precache))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names
						.filter(
							(name) => name.startsWith("kanban-shell-") && name !== shell,
						)
						.map((name) => caches.delete(name)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

const fromNetwork = async (request, store) => {
	const response = await fetch(request);
	if (store && response.ok && response.type === "basic") {
		const cache = await caches.open(shell);
		await cache.put(request, response.clone());
	}
	return response;
};

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	const path = url.pathname;
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request).catch(async () => {
				const cache = await caches.open(shell);
				return (await cache.match("offline.html")) ?? Response.error();
			}),
		);
		return;
	}
	if (hashed.test(path)) {
		event.respondWith(
			caches
				.match(request)
				.then((cached) => cached ?? fromNetwork(request, true)),
		);
		return;
	}
	if (shellFiles.has(path) || precache.includes(path.slice(1))) {
		event.respondWith(
			fromNetwork(request, true).catch(async () => {
				const cached = await caches.match(request);
				return cached ?? Response.error();
			}),
		);
	}
});
