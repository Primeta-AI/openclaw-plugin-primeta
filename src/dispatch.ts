// Shared scaffolding for dispatching an agent turn on the Primeta channel.
// Used by inbound chat_message handling, the synthetic persona-switch
// greeting, and the local /primeta HTTP webhook. Each caller supplies its
// own `deliver` callback; the rest (route resolution, inbound-context
// finalisation, buffered dispatch) is identical.

import { getPrimetaRuntime } from "./runtime.js";

export interface DispatchTurnParams {
  body: string;
  senderId: string;
  bridgeName: string;
  messageSid: string;
  accountId?: string;
  senderName?: string;
  conversationLabel?: string;
  deliver: (chunk: string) => void | Promise<void>;
}

/**
 * Dispatches one agent turn through OpenClaw's reply pipeline, piping any
 * produced text (markdown/text/string payloads) into the caller's
 * `deliver` callback. Empty chunks are filtered. Resolves once the agent
 * run is complete; throws on dispatch errors.
 */
export async function dispatchTurn(params: DispatchTurnParams): Promise<void> {
  const {
    body,
    senderId,
    bridgeName,
    messageSid,
    accountId = "default",
    senderName = "User",
    conversationLabel = "Primeta",
    deliver,
  } = params;

  const rt: any = getPrimetaRuntime();
  const peerTag = `primeta:${senderId}`;
  const route = rt.channel.routing.resolveAgentRoute({
    cfg: rt.config,
    channel: "primeta",
    accountId,
    peer: { kind: "direct", id: senderId },
  });

  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: body,
    CommandBody: body,
    From: peerTag,
    To: `primeta:${bridgeName}`,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: "direct",
    ConversationLabel: conversationLabel,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "primeta",
    Surface: "primeta",
    MessageSid: messageSid,
    OriginatingChannel: "primeta",
    OriginatingTo: peerTag,
  });

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg: rt.config,
    dispatcherOptions: {
      responsePrefix: "",
      deliver: async (payload: any) => {
        const chunk = payload?.markdown || payload?.text || (typeof payload === "string" ? payload : "");
        if (typeof chunk === "string" && chunk.length > 0) await deliver(chunk);
      },
    },
    replyOptions: {},
  });
}

/**
 * Resolves the sessionKey for a given senderId without running a turn.
 * Used when the plugin wants to pre-populate session state (e.g., for a
 * `persona_update` frame that arrives before any `chat_message`).
 */
export function resolveSessionKey(senderId: string, accountId = "default"): string | undefined {
  const rt: any = getPrimetaRuntime();
  const route = rt.channel.routing.resolveAgentRoute({
    cfg: rt.config,
    channel: "primeta",
    accountId,
    peer: { kind: "direct", id: senderId },
  });
  return route?.sessionKey;
}
