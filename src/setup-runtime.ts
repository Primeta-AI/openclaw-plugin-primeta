// Pure setup logic — no argv parsing, no interactive prompts. Callers
// (the standalone `openclaw-primeta` bin and the OpenClaw-registered
// `openclaw primeta` subcommand) provide resolved options and get back
// a result object describing what was written.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export const PACKAGE_NAME = "@primeta.ai/openclaw-plugin-primeta";
export const CHANNEL_ID = "primeta";
export const DEFAULT_SERVER = "https://primeta.ai";
export const DEFAULT_CONFIG = "~/.openclaw/openclaw.json";

export interface SetupOptions {
  token: string;
  server: string;
  name: string;
  config: string;
  path?: string;
  force?: boolean;
  write?: boolean;
}

export interface SetupResult {
  configPath: string;
  backupPath: string | null;
  replacedExistingBridge: boolean;
  wrote: boolean;
  bridgeName: string;
  server: string;
  pluginPath: string | null;
  mergedJson: string;
}

export class BridgeAlreadyExistsError extends Error {
  constructor(public readonly configPath: string) {
    super(`A Primeta channel already exists in ${configPath}`);
    this.name = "BridgeAlreadyExistsError";
  }
}

/** Resolves a path that may start with `~` to an absolute path. */
export function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(p[1] === "/" ? 2 : 1)) : resolve(p);
}

type Json = Record<string, unknown>;

function readExistingConfig(path: string): Json {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Existing config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function mergeConfig(existing: Json, opts: SetupOptions): { merged: Json; replacedExistingBridge: boolean } {
  const out: Json = JSON.parse(JSON.stringify(existing ?? {}));

  const channels = (out.channels ??= {}) as Json;
  const replacedExistingBridge = Boolean(channels[CHANNEL_ID]);
  channels[CHANNEL_ID] = {
    enabled: true,
    serverUrl: opts.server,
    apiKey: opts.token,
    bridgeName: opts.name,
  };

  const plugins = (out.plugins ??= {}) as Json;
  const allow = (plugins.allow as unknown[]) ?? [];
  const allowSet = new Set([...allow.filter((x): x is string => typeof x === "string"), CHANNEL_ID]);
  plugins.allow = [...allowSet];

  const entries = (plugins.entries ??= {}) as Json;
  entries[CHANNEL_ID] = { enabled: true };

  if (opts.path) {
    const load = (plugins.load ??= {}) as Json;
    const paths = (load.paths as unknown[]) ?? [];
    const pathsSet = new Set([
      ...paths.filter((x): x is string => typeof x === "string"),
      resolve(expandHome(opts.path)),
    ]);
    load.paths = [...pathsSet];
  }

  return { merged: out, replacedExistingBridge };
}

/**
 * Merges the Primeta channel config into the user's OpenClaw config.
 * Throws `BridgeAlreadyExistsError` when a Primeta block already exists
 * and `force` is false — callers handle the prompt-or-abort decision.
 * When `write: false`, skips disk I/O and returns the would-be result.
 */
export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const configPath = expandHome(opts.config);
  const existing = readExistingConfig(configPath);
  const { merged, replacedExistingBridge } = mergeConfig(existing, opts);
  const mergedJson = JSON.stringify(merged, null, 2) + "\n";
  const pluginPath = opts.path ? resolve(expandHome(opts.path)) : null;

  const base: Omit<SetupResult, "wrote" | "backupPath"> = {
    configPath,
    replacedExistingBridge,
    bridgeName: opts.name,
    server: opts.server,
    pluginPath,
    mergedJson,
  };

  if (!opts.write) {
    return { ...base, wrote: false, backupPath: null };
  }

  if (replacedExistingBridge && !opts.force) {
    throw new BridgeAlreadyExistsError(configPath);
  }

  mkdirSync(dirname(configPath), { recursive: true });

  let backupPath: string | null = null;
  if (existsSync(configPath)) {
    backupPath = `${configPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(configPath, backupPath);
  }
  writeFileSync(configPath, mergedJson, "utf8");

  return { ...base, wrote: true, backupPath };
}

/** Human-readable summary of a SetupResult for console output. */
export function formatSetupSummary(result: SetupResult): string {
  const lines: string[] = [];
  if (result.wrote) {
    lines.push(`✓ Wrote ${result.configPath}`);
    if (result.backupPath) lines.push(`  Backup:      ${result.backupPath}`);
  } else {
    lines.push(`(dry run — no changes written)`);
    lines.push(`  Target:      ${result.configPath}`);
  }
  lines.push(`  Bridge name: ${result.bridgeName}`);
  lines.push(`  Server:      ${result.server}`);
  if (result.pluginPath) lines.push(`  Plugin path: ${result.pluginPath}`);
  lines.push("");
  lines.push("Next: restart the OpenClaw gateway. A bridge card will appear on");
  lines.push("your Primeta dashboard when the plugin connects.");
  return lines.join("\n");
}
