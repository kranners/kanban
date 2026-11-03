import { signal } from "@preact/signals";
import type { RunnerView } from "../shared/runners.ts";

export const runners = signal<RunnerView[]>([]);
