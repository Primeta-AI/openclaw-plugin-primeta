// ActionCable WebSocket client that connects the OpenClaw channel plugin
// to the Primeta Rails server. The plugin initiates the connection
// (Primeta runs remotely and can't reach the user's localhost), subscribes
// to the per-user BridgeChannel stream, and routes inbound frames
// (chat_message, persona_update) to the appropriate handlers.

import WebSocket from "ws";
import { setPersonality, updatePersonalityForBridge } from "./session-state.js";
import { resolveSessionKey } from "./dispatch.js";
import { dispatchPersonaSwitchGreeting } from "./persona-switch.js";

export interface ChatMessageFrame {
  type: "chat_message";
  messageId: string;
  text: string;
  senderName?: string;
  senderId?: string;
  assistantName?: string;
  personality?: string;
}

interface PersonaUpdateFrame {
  type: "persona_update";
  personality: string;
  personaId?: number;
  personaName?: string;
  senderId?: string;
}

export type LogLevel = "info" | "warn" | "error";

export interface PrimetaBridgeOptions {
  serverUrl: string;
  apiKey: string;
  bridgeName: string;
  onChatMessage: (msg: ChatMessageFrame) => void | Promise<void>;
  onConnected?: () => void;
  onDisconnected?: (err?: Error) => void;
  log?: (level: LogLevel, msg: string) => void;
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class PrimetaBridge {
  private ws: WebSocket | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnecting = false;
  private closed = false;
  private subscribed = false;
  private readonly channelIdentifier: string;

  constructor(private readonly opts: PrimetaBridgeOptions) {
    this.channelIdentifier = JSON.stringify({
      channel: "BridgeChannel",
      bridge_name: opts.bridgeName,
      bridge_type: "openclaw",
    });
  }

  get bridgeName(): string {
    return this.opts.bridgeName;
  }

  isConnected(): boolean {
    return this.subscribed && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closed = false;
    this.reconnecting = false;

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch (err) {
      this.log("error", `WebSocket construction failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.log("info", `Connected to ${this.opts.serverUrl}`);
      ws.send(JSON.stringify({ command: "subscribe", identifier: this.channelIdentifier }));
    });

    ws.on("message", (data: WebSocket.Data) => this.handleFrame(data));

    ws.on("close", () => {
      this.subscribed = false;
      this.log("info", "Disconnected from Primeta");
      this.opts.onDisconnected?.();
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      this.log("error", `WebSocket error: ${err.message}`);
      this.opts.onDisconnected?.(err);
      try { ws.close(); } catch {}
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.subscribed = false;
  }

  sendToServer(msg: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({
      command: "message",
      identifier: this.channelIdentifier,
      data: JSON.stringify(msg),
    }));
    return true;
  }

  private handleFrame(data: WebSocket.Data): void {
    const frame = parseJson(data.toString());
    if (!frame) return;

    // ActionCable protocol frames
    switch (frame.type) {
      case "welcome":
        this.log("info", "ActionCable welcome received");
        return;
      case "ping":
        this.sendToServer({ type: "pong" });
        return;
      case "confirm_subscription":
        this.subscribed = true;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this.log("info", "Subscribed to BridgeChannel");
        this.opts.onConnected?.();
        return;
      case "reject_subscription":
        this.log("error", "Subscription rejected — check apiKey or bridge limit");
        return;
      case "disconnect":
        this.log("warn", `Server disconnect: ${frame.reason ?? "unknown"}`);
        return;
    }

    // Application frames (channel-identifier-wrapped)
    if (frame.identifier && frame.message) {
      const msg = frame.message;
      if (msg?.type === "chat_message" && typeof msg.messageId === "string") {
        this.runOnChatMessage(msg as ChatMessageFrame);
      } else if (msg?.type === "persona_update" && typeof msg.personality === "string") {
        this.handlePersonaUpdate(msg as PersonaUpdateFrame);
      }
    }
  }

  private runOnChatMessage(msg: ChatMessageFrame): void {
    Promise.resolve(this.opts.onChatMessage(msg)).catch((err) => {
      this.log("error", `onChatMessage handler threw: ${(err as Error).message}`);
    });
  }

  private handlePersonaUpdate(msg: PersonaUpdateFrame): void {
    let refreshed = updatePersonalityForBridge(this.bridgeName, msg.personality);

    // Cold cache — no prior chat_message on this bridge has populated
    // the sessionKey map yet. Resolve the sessionKey from the senderId
    // Rails sent along and seed the cache directly.
    if (!refreshed && msg.senderId) {
      try {
        const sessionKey = resolveSessionKey(msg.senderId);
        if (sessionKey) {
          setPersonality(sessionKey, msg.personality, this.bridgeName);
          refreshed = true;
        }
      } catch (err) {
        this.log("warn", `persona_update cold-resolve failed: ${(err as Error).message}`);
      }
    }
    this.log(
      "info",
      `persona_update for bridge ${this.bridgeName} (${refreshed ? "cache refreshed" : "no session to update"})`,
    );

    // Dispatch a synthetic greeting so the LLM adopts the new persona in
    // conversation history rather than continuing as whoever it was.
    if (msg.senderId) {
      dispatchPersonaSwitchGreeting({
        bridge: this,
        personality: msg.personality,
        senderId: msg.senderId,
        personaName: msg.personaName,
      }).catch((err) => {
        this.log("error", `persona-switch greeting dispatch threw: ${(err as Error).message}`);
      });
    }
  }

  private wsUrl(): string {
    const base = this.opts.serverUrl.replace(/\/$/, "").replace(/^http/, "ws");
    return `${base}/cable?bridge_token=${encodeURIComponent(this.opts.apiKey)}`;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    const delay = this.reconnectDelay;
    this.log("info", `Reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnecting = false;
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private log(level: LogLevel, msg: string): void {
    this.opts.log?.(level, `[primeta] ${msg}`);
  }
}

function parseJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
}
