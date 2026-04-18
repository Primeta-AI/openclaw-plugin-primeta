// Per-session personality storage. Populated when a chat_message arrives from
// Primeta (keyed by the sessionKey resolved at dispatch time) and consumed by
// the before_prompt_build hook to inject the personality as a cacheable
// system-prompt prefix. Keeps us from re-sending the personality on every
// LLM turn and prevents it from getting evicted during context compaction.
//
// Also tracks the last sessionKey seen per bridgeName so we can handle
// persona_update frames (sent by Rails when the user switches personas
// mid-conversation in the UI) and refresh the cached personality
// immediately rather than waiting for the next inbound turn.

const personalities = new Map<string, string>();
const sessionByBridge = new Map<string, string>();
const established = new Set<string>();

export function setPersonality(sessionKey: string, personality: string, bridgeName?: string): void {
  if (!sessionKey) return;
  const prev = personalities.get(sessionKey);
  if (!personality || personality.trim().length === 0) {
    personalities.delete(sessionKey);
    established.delete(sessionKey);
  } else {
    personalities.set(sessionKey, personality);
    // If the cached personality just changed (persona switch), the LLM
    // hasn't seen the new one yet — clear the established flag so the next
    // dispatch re-establishes it.
    if (prev !== personality) established.delete(sessionKey);
  }
  if (bridgeName) sessionByBridge.set(bridgeName, sessionKey);
}

export function getPersonality(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  return personalities.get(sessionKey);
}

export function updatePersonalityForBridge(bridgeName: string, personality: string): boolean {
  const sessionKey = sessionByBridge.get(bridgeName);
  if (!sessionKey) return false;
  setPersonality(sessionKey, personality);
  return true;
}

// "Established" means the LLM has seen the current personality at least
// once in its conversation history — either via the first chat_message
// prepending it to the body, or via the synthetic persona-switch greeting.
// While true, subsequent chat_message turns can skip the personality block
// to keep the transcript clean. Cleared whenever the cached personality
// changes (see setPersonality).
export function markEstablished(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  established.add(sessionKey);
}

export function isEstablished(sessionKey: string | undefined): boolean {
  return Boolean(sessionKey && established.has(sessionKey));
}
