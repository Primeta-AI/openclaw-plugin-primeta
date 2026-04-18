// Entry point: registers Primeta's OpenClaw channel plugin with the
// gateway. Wiring is intentionally thin — the channel definition,
// ActionCable client, and inbound dispatch live in their own modules.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { primetaPlugin } from "./channel.js";
import { handlePrimetaWebhookRequest } from "./webhook-handler.js";
import { setPrimetaRuntime } from "./runtime.js";
import { getPersonality } from "./session-state.js";
import {
  BridgeAlreadyExistsError,
  DEFAULT_CONFIG,
  DEFAULT_SERVER,
  formatSetupSummary,
  runSetup,
} from "./setup-runtime.js";

const plugin = {
  id: "primeta",
  name: "Primeta",
  description: "Bridge OpenClaw agent conversations into the Primeta avatar UI",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi): void {
    setPrimetaRuntime(api.runtime);
    api.registerChannel({ plugin: primetaPlugin });
    api.registerHttpRoute({
      path: "/primeta",
      auth: "plugin",
      match: "prefix",
      handler: handlePrimetaWebhookRequest,
    });

    // Inject the Primeta persona as a cacheable system-prompt prefix.
    // The personality is stashed by sessionKey when a chat_message arrives
    // (see inbound.ts); this hook re-reads it each turn so the LLM
    // provider can cache identical prefixes across turns without us
    // re-shipping the full personality body every time.
    api.registerHook(
      "before_prompt_build",
      (_event: unknown, ctx: { sessionKey?: string }) => {
        const personality = getPersonality(ctx?.sessionKey);
        return personality ? { prependSystemContext: personality } : undefined;
      },
      {
        name: "primeta-personality",
        description: "Inject the current Primeta persona as a cacheable system-prompt prefix",
      },
    );

    // Expose `openclaw primeta init` / `openclaw primeta print` so users who
    // installed via ClawHub (which only drops the plugin — no `npx` bin on
    // $PATH) can still run the config-merge helper. The standalone npm bin
    // at `cli.ts` uses the same setup-runtime internally.
    api.registerCli(
      (ctx: any) => {
        const primeta = ctx.program
          .command("primeta")
          .description("Primeta avatar channel: setup and maintenance");

        primeta
          .command("init")
          .description("Merge the Primeta channel into your OpenClaw config")
          .requiredOption("--token <token>", "Primeta bridge API token (also $PRIMETA_API_KEY)")
          .option("--server <url>", "Primeta server URL", DEFAULT_SERVER)
          .option("--name <name>", "Bridge name (conversation label in Primeta)")
          .option("--config <path>", "OpenClaw config file", DEFAULT_CONFIG)
          .option("--path <dir>", "Load the plugin from a local directory")
          .option("--force", "Overwrite an existing Primeta block without prompting")
          .action(async (opts: Record<string, string | boolean | undefined>) => {
            await cliRunSetup({ ...opts, write: true }, ctx.logger);
          });

        primeta
          .command("print")
          .description("Print the merged config to stdout without writing")
          .option("--token <token>", "Primeta bridge API token (also $PRIMETA_API_KEY)")
          .option("--server <url>", "Primeta server URL", DEFAULT_SERVER)
          .option("--name <name>", "Bridge name")
          .option("--config <path>", "OpenClaw config file", DEFAULT_CONFIG)
          .option("--path <dir>", "Local plugin path")
          .action(async (opts: Record<string, string | boolean | undefined>) => {
            await cliRunSetup({ ...opts, write: false }, ctx.logger);
          });
      },
      {
        commands: ["primeta"],
        descriptors: [
          {
            name: "primeta",
            description: "Primeta avatar channel: setup and maintenance",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
};

/** Shared adapter between the `openclaw primeta` command actions and
 * the runSetup runtime. Reads `$PRIMETA_API_KEY` as a fallback, handles
 * the "bridge already exists" prompt-or-abort decision inline, and
 * writes the human summary. */
async function cliRunSetup(
  raw: Record<string, string | boolean | undefined>,
  logger: { info: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void },
): Promise<void> {
  const token = (raw.token as string | undefined) ?? process.env.PRIMETA_API_KEY;
  if (!token) {
    logger.error?.("Primeta bridge API token required (--token or $PRIMETA_API_KEY)");
    throw new Error("missing token");
  }
  const name =
    (raw.name as string | undefined) ||
    (await import("node:path")).basename(process.cwd()) ||
    "default";
  try {
    const result = await runSetup({
      token,
      server: (raw.server as string) ?? DEFAULT_SERVER,
      name,
      config: (raw.config as string) ?? DEFAULT_CONFIG,
      path: raw.path as string | undefined,
      force: Boolean(raw.force),
      write: raw.write !== false,
    });
    if (!result.wrote && raw.write !== false) {
      // `print` subcommand path: raw mode.
      process.stdout.write(result.mergedJson);
      return;
    }
    if (raw.write === false) {
      process.stdout.write(result.mergedJson);
      return;
    }
    logger.info(formatSetupSummary(result));
  } catch (err) {
    if (err instanceof BridgeAlreadyExistsError) {
      logger.error?.(
        `${err.message}. Re-run with --force to overwrite.`,
      );
      throw err;
    }
    throw err;
  }
}

export default plugin;
