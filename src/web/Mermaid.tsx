import "./Mermaid.css";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { theme } from "./theme.ts";

type MermaidApi = typeof import("mermaid")["default"];

let loading: Promise<MermaidApi> | null = null;
let initialisedDark: boolean | null = null;
let count = 0;

const loadMermaid = (): Promise<MermaidApi> => {
	if (!loading) {
		loading = import("mermaid").then((module) => module.default);
		loading.catch(() => {
			loading = null;
		});
	}
	return loading;
};

const systemDark = matchMedia("(prefers-color-scheme: dark)");

function useDark(): boolean {
	const [prefersDark, setPrefersDark] = useState(systemDark.matches);
	useEffect(() => {
		const update = () => setPrefersDark(systemDark.matches);
		systemDark.addEventListener("change", update);
		return () => systemDark.removeEventListener("change", update);
	}, []);
	return theme.value === "dark" || (theme.value === "system" && prefersDark);
}

const render = async (
	mermaid: MermaidApi,
	code: string,
	dark: boolean,
): Promise<string> => {
	if (initialisedDark !== dark) {
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			suppressErrorRendering: true,
			theme: dark ? "dark" : "default",
			fontFamily: "Inter Variable, Inter, system-ui, sans-serif",
		});
		initialisedDark = dark;
	}
	const { svg } = await mermaid.render(`mermaid-${++count}`, code);
	return svg;
};

type Drawing =
	| { state: "drawing" }
	| { state: "drawn" }
	| { state: "failed"; error: string }
	| { state: "stale" };

function Source(props: { code: string }): JSX.Element {
	return (
		<pre>
			<code class="language-mermaid">{props.code}</code>
		</pre>
	);
}

export function Mermaid(props: { code: string }): JSX.Element {
	const dark = useDark();
	const figure = useRef<HTMLDivElement>(null);
	const [drawing, setDrawing] = useState<Drawing>({ state: "drawing" });

	useEffect(() => {
		let current = true;
		const settle = (next: Drawing) => {
			if (current) setDrawing(next);
		};
		const draw = async () => {
			const mermaid = await loadMermaid().catch(() => null);
			if (!mermaid) return settle({ state: "stale" });
			try {
				const svg = await render(mermaid, props.code, dark);
				if (!current || !figure.current) return;
				figure.current.innerHTML = svg;
				settle({ state: "drawn" });
			} catch (error) {
				settle({
					state: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		void draw();
		return () => {
			current = false;
		};
	}, [props.code, dark]);

	return (
		<div class="mermaid-diagram">
			<div
				ref={figure}
				class="mermaid-figure"
				hidden={drawing.state !== "drawn"}
			/>
			{(drawing.state === "drawing" || drawing.state === "failed") && (
				<Source code={props.code} />
			)}
			{drawing.state === "failed" && (
				<p class="mermaid-error" role="alert">
					Couldn't draw this diagram: {drawing.error}
				</p>
			)}
			{drawing.state === "stale" && (
				<p class="mermaid-error" role="alert">
					Diagrams need a reload: the board was updated since this page loaded.{" "}
					<button type="button" onClick={() => location.reload()}>
						Reload
					</button>
				</p>
			)}
		</div>
	);
}
