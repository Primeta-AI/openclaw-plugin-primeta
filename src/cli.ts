#!/usr/bin/env node
// Standalone entry for `npx openclaw-plugin-primeta init` (or the
// `openclaw-primeta` bin from a global install). The exact same setup
// logic is also exposed via `openclaw primeta init` when the plugin is
// loaded — see `index.ts` and `setup-runtime.ts`.

import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  BridgeAlreadyExistsError,
  DEFAULT_CONFIG,
  DEFAULT_SERVER,
  PACKAGE_NAME,
  formatSetupSummary,
  runSetup,
  type SetupOptions,
} from "./setup-runtime.js";

interface Args extends Partial<SetupOptions> {
  command?: "init" | "print";
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift()!;
    switch (a) {
      case "--server": args.server = rest.shift(); break;
      case "--token":  args.token  = rest.shift(); break;
      case "--name":   args.name   = rest.shift(); break;
      case "--config": args.config = rest.shift(); break;
      case "--path":   args.path   = rest.shift(); break;
      case "--dry-run": args.write = false; break;
      case "--force":   args.force = true; break;
      case "-h": case "--help": args.help = true; break;
      default:
        if (!args.command && (a === "init" || a === "print")) {
          args.command = a;
        } else {
          console.error(`Unknown argument: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
Primeta OpenClaw channel — setup helper

Usage:
  npx ${PACKAGE_NAME} init [options]
  npx ${PACKAGE_NAME} print [options]

Commands:
  init    Merge the Primeta channel into your OpenClaw config (backs up the
          existing file before writing).
  print   Print the merged config to stdout without writing anything.

Options:
  --token <token>   Primeta bridge API token. Required. Also accepts $PRIMETA_API_KEY.
  --server <url>    Primeta server URL.         Default: ${DEFAULT_SERVER}
  --name <name>     Bridge name (conversation label in Primeta).
                                                Default: current directory name.
  --config <path>   OpenClaw config file.       Default: ${DEFAULT_CONFIG}
  --path <dir>      Load the plugin from a local directory instead of npm.
                    Useful for local development before publishing.
  --dry-run         Show the merged result, do not write.
  --force           Overwrite without prompting if the Primeta channel
                    already exists in the target config.
  -h, --help        Show this help.

Also available from within OpenClaw once the plugin is loaded:

  openclaw primeta init [options]

Get your token from https://primeta.ai/bridge/setup → Settings → Connections.
`.trim());
}

async function promptToken(): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("Primeta bridge API token: ")).trim();
    if (!answer) throw new Error("Token is required");
    return answer;
  } finally {
    rl.close();
  }
}

async function confirmOverwrite(configPath: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(
      `A Primeta channel already exists in ${configPath}. Overwrite serverUrl/apiKey/bridgeName? [y/N] `,
    )).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const token = args.token ?? process.env.PRIMETA_API_KEY ?? (await promptToken());
  const opts: SetupOptions = {
    token,
    server: args.server ?? DEFAULT_SERVER,
    name: args.name ?? (basename(process.cwd()) || "default"),
    config: args.config ?? DEFAULT_CONFIG,
    path: args.path,
    force: args.force ?? false,
    write: args.command === "init" && args.write !== false,
  };

  try {
    const result = await runSetup(opts);
    if (args.command === "print") {
      process.stdout.write(result.mergedJson);
      return;
    }
    console.log(formatSetupSummary(result));
  } catch (err) {
    if (err instanceof BridgeAlreadyExistsError) {
      const ok = await confirmOverwrite(err.configPath);
      if (!ok) {
        console.log("Aborted.");
        process.exit(1);
      }
      const result = await runSetup({ ...opts, force: true });
      console.log(formatSetupSummary(result));
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
