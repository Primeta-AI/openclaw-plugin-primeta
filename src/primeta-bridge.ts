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
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to the `ws` WebSocket client. */
  webSocketImpl?: WebSocketFactory;
}

export type WebSocketFactory = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

/** Error raised when the server refuses to mint a cable ticket. */
export class CableTicketError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CableTicketError";
  }
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

// Heartbeat watchdog — Rails ActionCable pings every ~3s. If we don't see
// any inbound frame for this long, we assume the underlying TCP connection
// is silently dead (laptop sleep, NAT drop, WiFi switch) and force a
// reconnect. Without this, ws.readyState stays OPEN forever even though
// no bytes are flowing, and the user has to manually restart.
const HEARTBEAT_TIMEOUT_MS = 15_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 5_000;

// Cable tickets (POST /cable/tickets) are one-time and live for 60s, so we
// mint one immediately before every WebSocket open and never reuse them.
// The long-lived apiKey only ever travels in the Authorization header of
// that POST — never in the cable URL, where it would land in proxy and
// server access logs.
const TICKET_MINT_TIMEOUT_MS = 10_000;

export class PrimetaBridge {
  private ws: WebSocket | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastInboundAt = 0;
  private reconnecting = false;
  private closed = false;
  private subscribed = false;
  // Bumped on every connect()/close() so an in-flight ticket mint that
  // resolves after the bridge was closed (or re-connected) is discarded.
  private connectAttempt = 0;
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
    const attempt = ++this.connectAttempt;
    void this.openWithFreshTicket(attempt);
  }

  private async openWithFreshTicket(attempt: number): Promise<void> {
    let ticket: string;
    try {
      ticket = await this.mintTicket();
    } catch (err) {
      if (this.isStale(attempt)) return;
      const error = err instanceof Error ? err : new Error(String(err));
      // Deliberately no fallback to ?bridge_token= — the apiKey must never
      // appear in a URL. Back off and mint again on the next attempt.
      this.log("error", `Cable ticket mint failed: ${error.message}`);
      this.opts.onDisconnected?.(error);
      this.scheduleReconnect();
      return;
    }
    if (this.isStale(attempt)) return;
    this.openSocket(ticket);
  }

  private isStale(attempt: number): boolean {
    return this.closed || attempt !== this.connectAttempt;
  }

  private async mintTicket(): Promise<string> {
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new CableTicketError("global fetch is unavailable (Node >= 18 required)");
    }

    const url = this.ticketUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TICKET_MINT_TIMEOUT_MS);
    timer.unref?.();

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          Accept: "application/json",
        },
        // Never follow redirects with the bearer token attached.
        redirect: "error",
        signal: controller.signal,
      });
    } catch (err) {
      const reason = controller.signal.aborted ? "timed out" : (err as Error).message;
      throw new CableTicketError(`request failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new CableTicketError(`unauthorized (HTTP ${res.status}) — check apiKey`, res.status);
    }
    if (!res.ok) {
      throw new CableTicketError(`unexpected HTTP ${res.status}`, res.status);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new CableTicketError("response was not valid JSON", res.status);
    }
    const ticket = (body as { ticket?: unknown } | null)?.ticket;
    if (typeof ticket !== "string" || ticket.length === 0) {
      throw new CableTicketError("response did not include a ticket", res.status);
    }
    return ticket;
  }

  private openSocket(ticket: string): void {
    const WebSocketImpl = this.opts.webSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new WebSocketImpl(this.wsUrl(ticket), { headers: { Origin: this.origin() } });
    } catch (err) {
      this.log("error", `WebSocket construction failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.log("info", `Connected to ${this.opts.serverUrl}`);
      this.lastInboundAt = Date.now();
      this.startHeartbeatWatchdog();
      ws.send(JSON.stringify({ command: "subscribe", identifier: this.channelIdentifier }));
    });

    ws.on("message", (data: WebSocket.Data) => {
      this.lastInboundAt = Date.now();
      this.handleFrame(data);
    });

    ws.on("close", () => {
      this.subscribed = false;
      this.log("info", "Disconnected from Primeta");
      this.stopHeartbeatWatchdog();
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
    this.connectAttempt++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeatWatchdog();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.subscribed = false;
  }

  private startHeartbeatWatchdog(): void {
    this.stopHeartbeatWatchdog();
    this.heartbeatTimer = setInterval(() => {
      const idle = Date.now() - this.lastInboundAt;
      if (idle <= HEARTBEAT_TIMEOUT_MS) return;
      this.log("warn", `No frames for ${Math.round(idle / 1000)}s — connection is dead, forcing reconnect`);
      this.stopHeartbeatWatchdog();
      if (this.ws) {
        try { this.ws.terminate?.(); } catch {}
        try { this.ws.close(); } catch {}
        this.ws = null;
      }
      if (!this.closed) this.scheduleReconnect();
    }, HEARTBEAT_CHECK_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeatWatchdog(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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

  private ticketUrl(): string {
    return `${this.httpBase()}/cable/tickets`;
  }

  private wsUrl(ticket: string): string {
    const base = this.httpBase().replace(/^http/i, "ws");
    return `${base}/cable?ticket=${encodeURIComponent(ticket)}`;
  }

  // Only http(s) server URLs are accepted; anything else would make the
  // ws-scheme rewrite below meaningless and could send the bearer token
  // somewhere unexpected.
  private httpBase(): string {
    const base = this.opts.serverUrl.replace(/\/$/, "");
    if (!/^https?:\/\//i.test(base)) {
      // Report only the scheme — the URL itself may embed credentials.
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(base)?.[1] ?? "none";
      throw new CableTicketError(`serverUrl must start with http:// or https:// (got scheme "${scheme}")`);
    }
    return base;
  }

  // Rails' ActionCable enforces `allowed_request_origins` in production.
  // Node's `ws` client does not set an `Origin` header by default, which
  // Rails treats as a CSRF failure and rejects with 404. Send an origin
  // derived from `serverUrl` so same-origin handshakes succeed.
  private origin(): string {
    return this.opts.serverUrl.replace(/\/$/, "");
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
