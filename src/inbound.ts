// Handles an incoming `chat_message` frame from Primeta: prepends the
// persona's personality on the first turn of a session (so the LLM's
// history anchors to it), dispatches the turn, and ships the buffered
// reply back as a single `{type: "reply"}` frame. Subsequent turns in
// the same session ship raw user text — the `before_prompt_build` hook
// in index.ts re-injects the personality as a cacheable system prefix,
// and the LLM's own history keeps the character established.

import { dispatchTurn, resolveSessionKey } from "./dispatch.js";
import { setPersonality, isEstablished, markEstablished } from "./session-state.js";
import type { PrimetaBridge, ChatMessageFrame } from "./primeta-bridge.js";

interface HandleCtx {
  bridge: PrimetaBridge;
  account: { accountId: string };
}

export async function handleChatMessage(
  msg: ChatMessageFrame,
  { bridge, account }: HandleCtx,
): Promise<void> {
  const senderId = msg.senderId || "primeta-user";
  const sessionKey = resolveSessionKey(senderId, account.accountId);

  // Stash the personality so persona_update frames can diff against it and
  // the before_prompt_build hook can inject it as a system-prompt prefix.
  if (msg.personality && sessionKey) {
    setPersonality(sessionKey, msg.personality, bridge.bridgeName);
  }

  // Prepend the personality to the user body only on the first turn of the
  // session (or right after a persona switch where the synthetic greeting
  // hasn't yet established the new persona). Once established, we ship raw
  // user text — keeps the OpenClaw-side transcript clean.
  const shouldPrepend = msg.personality && !isEstablished(sessionKey);
  const body = shouldPrepend
    ? `${msg.personality}\n\n--- USER MESSAGE ---\n${msg.text}`
    : msg.text;

  let buffer = "";
  try {
    await dispatchTurn({
      body,
      senderId,
      bridgeName: bridge.bridgeName,
      messageSid: msg.messageId,
      accountId: account.accountId,
      senderName: msg.senderName || "User",
      conversationLabel: msg.assistantName || "Primeta",
      deliver: (chunk) => { buffer += chunk; },
    });

    bridge.sendToServer({
      type: "reply",
      messageId: msg.messageId,
      text: buffer,
    });

    // Turn succeeded — the LLM has seen this personality either via the
    // body prepend (this turn) or via prior history. Mark established so
    // the next turn can skip the prepend.
    if (msg.personality) markEstablished(sessionKey);
  } catch (err) {
    console.error("[primeta] chat_message dispatch failed:", err);
    bridge.sendToServer({
      type: "reply",
      messageId: msg.messageId,
      text: `[OpenClaw error: ${(err as Error).message}]`,
    });
  }
}
