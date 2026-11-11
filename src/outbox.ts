// Durable outbox for correlated `{type: "reply"}` frames (F-09).
//
// A reply to a Primeta chat_message is only done once the server acks it
// with `{type: "reply_ack", messageId, status: "ok" | "rejected"}`. Until
// then it lives here, keyed (and deduplicated) by messageId, so a reply
// produced while the socket is down, or lost in a disconnect, is resent
// with the same messageId after the next confirm_subscription.
//
// Persisted as a small JSON file (default
// `~/.openclaw/primeta/outbox-<accountId>.json`, next to OpenClaw's own
// `~/.openclaw/openclaw.json`) so pending replies survive a gateway
// restart. The file holds reply text, so it is written 0600. Persistence
// is best-effort: if the file can't be read or written the outbox keeps
// working in memory and logs the failure.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OutboxEntry {
  messageId: string;
  text: string;
  createdAt: number;
  /** Number of times the frame has been written to a socket. */
  attempts: number;
}

/** Entries older than this are dropped — the server expires the turn long before. */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Upper bound on queued replies; the oldest is dropped beyond this. */
export const OUTBOX_MAX_ENTRIES = 100;

export function defaultOutboxPath(accountId: string): string {
  const safe = accountId.replace(/[^A-Za-z0-9_.-]/g, "_") || "default";
  return join(homedir(), ".openclaw", "primeta", `outbox-${safe}.json`);
}

export class ReplyOutbox {
  private readonly entries = new Map<string, OutboxEntry>();

  /**
   * @param path JSON file to persist to, or null for an in-memory outbox.
   * @param onError called with a message when persistence fails.
   */
  constructor(
    private readonly path: string | null,
    private readonly onError: (msg: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  get size(): number {
    return this.entries.size;
  }

  has(messageId: string): boolean {
    return this.entries.has(messageId);
  }

  get(messageId: string): OutboxEntry | undefined {
    return this.entries.get(messageId);
  }

  /** Oldest first. */
  list(): OutboxEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Queues a reply. Returns false (and keeps the existing entry) if a reply
   * for this messageId is already pending — first reply wins, matching the
   * server's exactly-once finalize.
   */
  add(messageId: string, text: string): boolean {
    if (this.entries.has(messageId)) return false;
    this.entries.set(messageId, { messageId, text, createdAt: this.now(), attempts: 0 });
    while (this.entries.size > OUTBOX_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.onError(`outbox full — dropped oldest pending reply ${oldest}`);
    }
    this.save();
    return true;
  }

  markAttempt(messageId: string): void {
    const entry = this.entries.get(messageId);
    if (!entry) return;
    entry.attempts += 1;
    this.save();
  }

  remove(messageId: string): boolean {
    const removed = this.entries.delete(messageId);
    if (removed) this.save();
    return removed;
  }

  private load(): void {
    if (!this.path) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.onError(`outbox read failed: ${(err as Error).message}`);
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.onError("outbox file is not valid JSON — ignoring it");
      return;
    }
    const list = (parsed as { replies?: unknown } | null)?.replies;
    if (!Array.isArray(list)) return;
    const cutoff = this.now() - OUTBOX_MAX_AGE_MS;
    for (const e of list) {
      if (!e || typeof e !== "object") continue;
      const { messageId, text, createdAt, attempts } = e as Record<string, unknown>;
      if (typeof messageId !== "string" || messageId.length === 0) continue;
      if (typeof text !== "string") continue;
      const created = typeof createdAt === "number" ? createdAt : this.now();
      if (created < cutoff) continue;
      if (this.entries.has(messageId)) continue;
      this.entries.set(messageId, {
        messageId,
        text,
        createdAt: created,
        attempts: typeof attempts === "number" ? attempts : 0,
      });
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, replies: this.list() }), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      this.onError(`outbox write failed: ${(err as Error).message}`);
    }
  }
}
