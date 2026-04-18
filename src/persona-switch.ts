// Synthetic agent turn triggered by a `persona_update` frame from Rails.
// Asks the LLM to greet the user briefly in the new persona; the buffered
// reply is pushed back to Primeta as a `{type: "send"}` frame so the new
// persona lands in both the avatar UI and the LLM's conversation history.
// Without this, the LLM's prior assistant turns ("I am Rose") continue to
// anchor the old persona and the user has to nudge it to switch.

import { dispatchTurn, resolveSessionKey } from "./dispatch.js";
import { markEstablished } from "./session-state.js";
import type { PrimetaBridge } from "./primeta-bridge.js";

interface Params {
  bridge: PrimetaBridge;
  personality: string;
  senderId: string;
  personaName?: string;
}

export async function dispatchPersonaSwitchGreeting({
  bridge,
  personality,
  senderId,
  personaName,
}: Params): Promise<void> {
  const body = [
    personality,
    "",
    "--- SYSTEM ---",
    `You have just switched into this persona mid-conversation. Regardless of any prior identity you may have assumed, speak entirely as ${personaName || "this persona"} from now on. Greet the user with one short in-character sentence. Do not mention the switch mechanic itself.`,
  ].join("\n");

  try {
    let buffer = "";
    await dispatchTurn({
      body,
      senderId,
      bridgeName: bridge.bridgeName,
      messageSid: `pm-switch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderName: "System",
      conversationLabel: personaName || "Primeta",
      deliver: (chunk) => { buffer += chunk; },
    });

    if (buffer.trim().length > 0) {
      bridge.sendToServer({
        type: "send",
        text: buffer,
        bridgeName: bridge.bridgeName,
      });
      // Greeting is now in the LLM's history — subsequent user turns can
      // ship raw text without prepending the personality again.
      const sessionKey = resolveSessionKey(senderId);
      markEstablished(sessionKey);
    }
  } catch (err) {
    console.error(`[primeta] persona-switch greeting failed: ${(err as Error).message}`);
  }
}
