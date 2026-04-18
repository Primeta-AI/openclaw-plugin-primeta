// OpenClaw ChannelPlugin definition for Primeta. Handles account
// resolution from the user's `channels.primeta` config block, opens the
// per-account ActionCable connection inside `gateway.startAccount`, and
// routes `outbound.sendText` calls from the agent through the bridge as
// `{type: "send"}` frames.

import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { PrimetaBridge } from "./primeta-bridge.js";
import { registerBridge, unregisterBridge, getBridge } from "./bridge-registry.js";
import { handleChatMessage } from "./inbound.js";

interface PrimetaConfig {
  enabled?: boolean;
  serverUrl?: string;
  apiKey?: string;
  bridgeName?: string;
}

interface ResolvedAccount {
  accountId: string;
  config: PrimetaConfig;
  enabled: boolean;
  configured: boolean;
}

/**
 * Reads the Primeta channel config from one of three possible input
 * shapes the SDK may pass:
 *   - Full gateway config: `{ channels: { primeta: {...} } }`
 *   - A ResolvedAccount: `{ accountId, config: {...} }`
 *   - The channel config block directly: `{ serverUrl, apiKey, ... }`
 */
function readConfig(input: unknown): PrimetaConfig {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, any>;
  if (o.channels?.primeta) return o.channels.primeta as PrimetaConfig;
  if (o.config && (o.config.serverUrl || o.config.apiKey)) return o.config as PrimetaConfig;
  if (o.serverUrl || o.apiKey) return o as PrimetaConfig;
  return {};
}

function hasCredentials(c: PrimetaConfig): boolean {
  return Boolean(c.serverUrl && c.apiKey);
}

export const primetaPlugin: ChannelPlugin<ResolvedAccount> = {
  id: "primeta",
  meta: {
    id: "primeta",
    label: "Primeta",
    selectionLabel: "Primeta (Avatar)",
    blurb: "Route OpenClaw agent conversations through a Primeta avatar.",
    aliases: ["pm"],
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  config: {
    listAccountIds: (cfg: unknown): string[] =>
      hasCredentials(readConfig(cfg)) ? ["default"] : [],
    resolveAccount: (cfg: unknown, accountId?: string | null): ResolvedAccount => {
      const config = readConfig(cfg);
      return {
        accountId: accountId || "default",
        config,
        enabled: config.enabled !== false,
        configured: hasCredentials(config),
      };
    },
    defaultAccountId: (): string => "default",
    isConfigured: (cfg: unknown): boolean => hasCredentials(readConfig(cfg)),
    describeAccount: (account: ResolvedAccount) => ({
      accountId: account.accountId,
      name: "Primeta",
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text, accountId }: { text: string; accountId?: string }) => {
      const id = accountId || "default";
      const messageId = `pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const bridge = getBridge(id);
      if (!bridge || !bridge.isConnected()) {
        console.error(`[primeta] outbound.sendText: no connected bridge for account ${id}`);
        return { channel: "primeta", messageId };
      }
      bridge.sendToServer({ type: "send", text, bridgeName: bridge.bridgeName });
      return { channel: "primeta", messageId };
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const config = readConfig(ctx.account ?? ctx.cfg);
      const accountId = ctx.account?.accountId ?? ctx.accountId ?? "default";
      const { serverUrl, apiKey, bridgeName = "default" } = config;

      if (!serverUrl || !apiKey) {
        ctx.log?.warn?.("[primeta] account missing serverUrl or apiKey — not connecting");
        ctx.setStatus?.({ accountId, running: false, lastError: "Missing serverUrl or apiKey" });
        return;
      }

      const bridge: PrimetaBridge = new PrimetaBridge({
        serverUrl,
        apiKey,
        bridgeName,
        onChatMessage: (msg) => handleChatMessage(msg, { bridge, account: { accountId } }),
        onConnected: () => ctx.setStatus?.({ accountId, running: true, lastStartAt: Date.now() }),
        onDisconnected: (err) =>
          ctx.setStatus?.({ accountId, running: false, lastError: err?.message }),
        log: (level, msg) => ctx.log?.[level]?.(msg),
      });

      registerBridge(accountId, bridge);
      bridge.connect();

      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) return resolve();
        ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });

      bridge.close();
      unregisterBridge(accountId);
      ctx.setStatus?.({ accountId, running: false, lastStopAt: Date.now() });
    },
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: true,
      running: snapshot?.running ?? false,
    }),
    probeAccount: async ({ account }: any) => {
      const bridge = getBridge(account?.accountId ?? "default");
      return { ok: bridge?.isConnected() ?? false };
    },
    buildAccountSnapshot: ({ account, runtime }: any) => ({
      accountId: account?.accountId ?? "default",
      running: runtime?.running ?? false,
    }),
  },
};
