import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setPrimetaRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getPrimetaRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Primeta runtime not initialized");
  }
  return runtime;
}
