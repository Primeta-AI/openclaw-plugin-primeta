// ActionCable WebSocket client that connects the OpenClaw channel plugin
// to the Primeta Rails server. The plugin initiates the connection
// (Primeta runs remotely and can't reach the user's localhost), subscribes
// to the per-user BridgeChannel stream, and routes inbound frames
// (chat_message, persona_update) to the appropriate handlers.

import WebSocket from "ws";
import { setPersonality, updatePersonalityForBridge } from "./session-state.js";
import { resolveSessionKey } from "./dispatch.js";
import { dispatchPersonaSwitchGreeting } from "./persona-switch.js";
import { ReplyOutbox } from "./outbox.js";

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

interface ReplyAckFrame {
  type: "reply_ack";
  messageId: string;
  status: "ok" | "retry" | "rejected";
  reason?: string;
}

const REPLY_ACK_STATUSES = new Set(["ok", "retry", "rejected"]);

export type LogLevel = "info" | "warn" | "error";

export interface PrimetaBridgeOptions {
  serverUrl: string;
  apiKey: string;
  bridgeName: string;
  onChatMessage: (msg: ChatMessageFrame) => void | Promise<void>;
  onConnected?: () => void;
  onDisconnected?: (err?: Error) => void;
  log?: (level: LogLevel, msg: string) => void;
  /**
   * JSON file for the durable reply outbox (see outbox.ts). Omit or pass
   * null for an in-memory outbox (pending replies are lost on restart).
   */
  outboxPath?: string | null;
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

// Reply delivery (F-09). Every correlated reply stays in the outbox until
// the server answers with reply_ack ok/rejected. `retry` (transient save
// failure) resends the same frame after a backoff; no ack within
// REPLY_ACK_TIMEOUT_MS resends too — but only once this process has seen
// the server send a reply_ack at all. A server that predates reply_ack
// never acks, and resending to it would double-post (it turns unmatched
// replies into unsolicited messages), so against such a server an
// unacked reply is treated as delivered after the timeout, exactly like
// the old fire-and-forget behaviour. The outbox is flushed (same
// messageId) after every confirm_subscription.
const REPLY_ACK_TIMEOUT_MS = 15_000;
const REPLY_RETRY_BASE_MS = 1_000;
const REPLY_RETRY_MAX_MS = 30_000;
const MAX_REPLY_ATTEMPTS = 10;
// Unsolicited `{type: "send"}` frames that couldn't be written because the
// socket was down are held in memory and sent after the next subscribe.
const MAX_PENDING_SENDS = 20;

export class PrimetaBridge {
  private ws: WebSocket | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastInboundAt = 0;
  private closed = false;
  private subscribed = false;
  // Bumped on every connect()/close() so an in-flight ticket mint that
  // resolves after the bridge was closed (or re-connected) is discarded.
  private connectAttempt = 0;
  private readonly channelIdentifier: string;
  private readonly outbox: ReplyOutbox;
  // At most one ack-timeout or retry timer per pending messageId.
  private readonly replyTimers = new Map<string, NodeJS.Timeout>();
  private serverAcksReplies = false;
  private pendingSends: string[] = [];

  constructor(private readonly opts: PrimetaBridgeOptions) {
    this.channelIdentifier = JSON.stringify({
      channel: "BridgeChannel",
      bridge_name: opts.bridgeName,
      bridge_type: "openclaw",
    });
    this.outbox = new ReplyOutbox(opts.outboxPath ?? null, (m) => this.log("warn", m));
    if (this.outbox.size > 0) {
      this.log("info", `${this.outbox.size} pending repl${this.outbox.size === 1 ? "y" : "ies"} loaded from outbox`);
    }
  }

  get bridgeName(): string {
    return this.opts.bridgeName;
  }

  isConnected(): boolean {
    return this.subscribed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** messageIds of replies still waiting for a reply_ack ok/rejected. */
  pendingReplyIds(): string[] {
    return this.outbox.list().map((e) => e.messageId);
  }

  connect(): void {
    this.closed = false;
    this.clearReconnectTimer();
    // A manual connect() while a socket is still attached must not leave
    // two live sockets (and two reconnect loops) behind.
    if (this.ws) this.dropSocket(this.ws, { kill: true, reconnect: false });
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

    // Every handler ignores events from a socket that is no longer current,
    // so a late close/error from a replaced socket can't null out the new
    // one or start a second reconnect loop.
    ws.on("open", () => {
      if (ws !== this.ws) return;
      this.log("info", `Connected to ${this.opts.serverUrl}`);
      this.lastInboundAt = Date.now();
      this.startHeartbeatWatchdog();
      ws.send(JSON.stringify({ command: "subscribe", identifier: this.channelIdentifier }));
    });

    ws.on("message", (data: WebSocket.Data) => {
      if (ws !== this.ws) return;
      this.lastInboundAt = Date.now();
      this.handleFrame(data);
    });

    ws.on("close", () => {
      this.dropSocket(ws, { kill: false, reconnect: true });
    });

    ws.on("error", (err: Error) => {
      if (ws !== this.ws) return;
      this.log("error", `WebSocket error: ${err.message}`);
      this.dropSocket(ws, { err, kill: true, reconnect: true });
    });
  }

  /**
   * Single teardown path for the current socket: detaches every listener
   * first (so terminate()/close() can't re-enter our handlers), then kills
   * it, reports the disconnect once, and schedules at most one reconnect.
   */
  private dropSocket(
    ws: WebSocket,
    { err, kill, reconnect }: { err?: Error; kill: boolean; reconnect: boolean },
  ): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.subscribed = false;
    this.stopHeartbeatWatchdog();
    this.clearReplyTimers();
    detachSocket(ws);
    if (kill) {
      try { ws.terminate?.(); } catch {}
    }
    this.log("info", "Disconnected from Primeta");
    this.opts.onDisconnected?.(err);
    if (reconnect) this.scheduleReconnect();
  }

  close(): void {
    this.closed = true;
    this.connectAttempt++;
    this.clearReconnectTimer();
    this.stopHeartbeatWatchdog();
    this.clearReplyTimers();
    const ws = this.ws;
    this.ws = null;
    this.subscribed = false;
    if (ws) {
      detachSocket(ws);
      try { ws.close(); } catch {}
    }
  }

  private startHeartbeatWatchdog(): void {
    this.stopHeartbeatWatchdog();
    this.heartbeatTimer = setInterval(() => {
      const idle = Date.now() - this.lastInboundAt;
      if (idle <= HEARTBEAT_TIMEOUT_MS) return;
      this.log("warn", `No frames for ${Math.round(idle / 1000)}s — connection is dead, forcing reconnect`);
      this.stopHeartbeatWatchdog();
      if (this.ws) {
        this.dropSocket(this.ws, { err: new Error("heartbeat timeout"), kill: true, reconnect: true });
      } else {
        this.scheduleReconnect();
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeatWatchdog(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Low-level: writes one channel message if the socket is open. */
  sendToServer(msg: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({
        command: "message",
        identifier: this.channelIdentifier,
        data: JSON.stringify(msg),
      }));
    } catch (err) {
      this.log("warn", `send failed: ${(err as Error).message}`);
      return false;
    }
    return true;
  }

  /**
   * Queues the correlated reply for a chat_message and sends it now if
   * subscribed. It stays queued (and persisted) until the server acks it
   * ok/rejected. A second reply for the same messageId is ignored.
   */
  sendReply(messageId: string, text: string): void {
    if (!this.outbox.add(messageId, text)) {
      this.log("warn", `reply for ${messageId} already pending — ignoring duplicate`);
      return;
    }
    this.transmitReply(messageId);
  }

  /**
   * Sends an unsolicited assistant message (`{type: "send"}`). If the
   * socket is down it is held in memory and sent after the next subscribe.
   * Never used for replies — a rejected reply is dropped, not re-sent here.
   */
  sendMessage(text: string): boolean {
    if (this.isConnected() && this.writeSend(text)) return true;
    this.pendingSends.push(text);
    if (this.pendingSends.length > MAX_PENDING_SENDS) {
      this.pendingSends.shift();
      this.log("warn", "pending send queue full — dropped oldest message");
    }
    return false;
  }

  private writeSend(text: string): boolean {
    return this.sendToServer({ type: "send", text, bridgeName: this.bridgeName });
  }

  private transmitReply(messageId: string): void {
    this.clearReplyTimer(messageId);
    const entry = this.outbox.get(messageId);
    if (!entry || !this.isConnected()) return; // flushed on next subscribe
    if (entry.attempts >= MAX_REPLY_ATTEMPTS) {
      this.log("error", `reply ${messageId} not acknowledged after ${entry.attempts} attempts — dropping`);
      this.outbox.remove(messageId);
      return;
    }
    if (!this.sendToServer({ type: "reply", messageId, text: entry.text })) return;
    this.outbox.markAttempt(messageId);
    this.setReplyTimer(messageId, REPLY_ACK_TIMEOUT_MS, () => this.onReplyAckTimeout(messageId));
  }

  private onReplyAckTimeout(messageId: string): void {
    if (!this.outbox.has(messageId)) return;
    if (!this.serverAcksReplies) {
      // Pre-F-09 server: never acks, and would double-post a resend.
      this.log("warn", `no reply_ack for ${messageId} (server does not ack replies) — treating as delivered`);
      this.outbox.remove(messageId);
      return;
    }
    this.log("warn", `no reply_ack for ${messageId} — resending`);
    this.transmitReply(messageId);
  }

  private handleReplyAck(ack: ReplyAckFrame): void {
    this.serverAcksReplies = true;
    const entry = this.outbox.get(ack.messageId);
    if (!entry) return; // already settled (duplicate ack)
    this.clearReplyTimer(ack.messageId);
    switch (ack.status) {
      case "ok":
        this.outbox.remove(ack.messageId);
        return;
      case "rejected":
        // Terminal: expired, duplicate, unknown, or wrong bridge. Never
        // re-send it as an unsolicited `send`.
        this.log("warn", `reply ${ack.messageId} rejected by server${ack.reason ? `: ${ack.reason}` : ""}`);
        this.outbox.remove(ack.messageId);
        return;
      case "retry": {
        const delay = Math.min(REPLY_RETRY_BASE_MS * 2 ** Math.max(entry.attempts - 1, 0), REPLY_RETRY_MAX_MS);
        this.log("warn", `server asked to retry reply ${ack.messageId} — resending in ${Math.round(delay / 1000)}s`);
        this.setReplyTimer(ack.messageId, delay, () => this.transmitReply(ack.messageId));
        return;
      }
    }
  }

  /** After (re)subscribing: resend every unacked reply, then held sends. */
  private flushOutbound(): void {
    for (const { messageId } of this.outbox.list()) this.transmitReply(messageId);
    const sends = this.pendingSends;
    this.pendingSends = [];
    for (let i = 0; i < sends.length; i++) {
      if (!this.isConnected() || !this.writeSend(sends[i])) {
        this.pendingSends = sends.slice(i).concat(this.pendingSends);
        return;
      }
    }
  }

  private setReplyTimer(messageId: string, delay: number, fn: () => void): void {
    this.clearReplyTimer(messageId);
    const timer = setTimeout(() => {
      this.replyTimers.delete(messageId);
      fn();
    }, delay);
    timer.unref?.();
    this.replyTimers.set(messageId, timer);
  }

  private clearReplyTimer(messageId: string): void {
    const timer = this.replyTimers.get(messageId);
    if (timer) clearTimeout(timer);
    this.replyTimers.delete(messageId);
  }

  private clearReplyTimers(): void {
    for (const timer of this.replyTimers.values()) clearTimeout(timer);
    this.replyTimers.clear();
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
        this.flushOutbound();
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
      } else if (
        msg?.type === "reply_ack" &&
        typeof msg.messageId === "string" &&
        REPLY_ACK_STATUSES.has(msg.status)
      ) {
        this.handleReplyAck(msg as ReplyAckFrame);
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

  // At most one reconnect timer exists at any time: watchdog, close, error
  // and mint failure all funnel through here.
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.log("info", `Reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private log(level: LogLevel, msg: string): void {
    this.opts.log?.(level, `[primeta] ${msg}`);
  }
}

// Removes our listeners and leaves a no-op error handler, so terminating a
// socket (which may emit "error" while still CONNECTING) can't throw an
// unhandled error or re-enter the bridge.
function detachSocket(ws: WebSocket): void {
  try {
    ws.removeAllListeners();
    ws.on("error", () => {});
  } catch {}
}

function parseJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
}
