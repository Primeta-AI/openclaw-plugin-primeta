// F-09/F-13: reply outbox + reply_ack handling, and the single reconnect
// timer / socket-detach behaviour. Runs against dist/ (`npm test` builds).
// fetch and WebSocket are mocked; the outbox file lives in a temp dir.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrimetaBridge } from "../dist/primeta-bridge.js";
import { ReplyOutbox, defaultOutboxPath } from "../dist/outbox.js";

class FakeWebSocket extends EventEmitter {
  static instances = [];
  readyState = 0;
  sent = [];
  terminated = false;
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  terminate() { this.terminated = true; this.close(); }
}

const IDENT = JSON.stringify({ channel: "BridgeChannel", bridge_name: "test", bridge_type: "openclaw" });
const flush = () => new Promise((r) => setImmediate(r));

let dir;
beforeEach(() => {
  FakeWebSocket.instances = [];
  dir = mkdtempSync(join(tmpdir(), "primeta-outbox-"));
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
});
afterEach(() => {
  mock.timers.reset();
  rmSync(dir, { recursive: true, force: true });
});

function makeBridge(extra = {}) {
  const logs = [];
  const disconnects = [];
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return new Response(JSON.stringify({ ticket: `t${n}` }), { status: 201 });
  };
  fetchImpl.count = () => n;
  const bridge = new PrimetaBridge({
    serverUrl: "https://primeta.example",
    apiKey: "k",
    bridgeName: "test",
    onChatMessage: () => {},
    onDisconnected: (err) => disconnects.push(err),
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    fetchImpl,
    webSocketImpl: FakeWebSocket,
    outboxPath: join(dir, "outbox.json"),
    ...extra,
  });
  return { bridge, logs, disconnects, fetchImpl };
}

const lastWs = () => FakeWebSocket.instances.at(-1);

/** Mint → open → confirm_subscription on the newest socket. */
async function subscribe() {
  await flush();
  const ws = lastWs();
  ws.readyState = 1;
  ws.emit("open");
  ws.emit("message", Buffer.from(JSON.stringify({ type: "confirm_subscription", identifier: IDENT })));
  return ws;
}

function frames(ws) {
  return ws.sent
    .map((s) => JSON.parse(s))
    .filter((f) => f.command === "message")
    .map((f) => JSON.parse(f.data))
    .filter((d) => d.type !== "pong");
}

function serverSays(ws, message) {
  ws.emit("message", Buffer.from(JSON.stringify({ identifier: IDENT, message })));
}

function ack(ws, messageId, status, reason) {
  serverSays(ws, { type: "reply_ack", messageId, status, ...(reason ? { reason } : {}) });
}

function persisted() {
  const p = join(dir, "outbox.json");
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8")).replies.map((r) => r.messageId);
}

/** Server drop, then advance past the backoff and resubscribe. */
async function dropAndReconnect(ws, delay = 1_000) {
  ws.close();
  mock.timers.tick(delay);
  return subscribe();
}

test("reply produced while disconnected is persisted and replayed after confirm_subscription", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  await flush(); // socket exists but is not subscribed yet

  bridge.sendReply("42", "hello");
  assert.deepEqual(frames(lastWs()), [], "must not write before subscription is confirmed");
  assert.deepEqual(persisted(), ["42"]);

  const ws = await subscribe();
  assert.deepEqual(frames(ws), [{ type: "reply", messageId: "42", text: "hello" }]);

  ack(ws, "42", "ok");
  assert.deepEqual(bridge.pendingReplyIds(), []);
  assert.deepEqual(persisted(), []);
  bridge.close();
});

test("reply lost to a disconnect is resent with the same messageId on reconnect", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws1 = await subscribe();
  bridge.sendReply("7", "first try");
  assert.equal(frames(ws1).length, 1);

  const ws2 = await dropAndReconnect(ws1);
  assert.notEqual(ws1, ws2);
  assert.deepEqual(frames(ws2), [{ type: "reply", messageId: "7", text: "first try" }]);

  ack(ws2, "7", "ok");
  const ws3 = await dropAndReconnect(ws2);
  assert.deepEqual(frames(ws3), [], "acked reply must not be replayed again");
  bridge.close();
});

test("pending replies survive a process restart via the outbox file", async () => {
  const first = makeBridge();
  first.bridge.sendReply("99", "persist me");
  first.bridge.close();

  const second = makeBridge();
  assert.deepEqual(second.bridge.pendingReplyIds(), ["99"]);
  second.bridge.connect();
  const ws = await subscribe();
  assert.deepEqual(frames(ws), [{ type: "reply", messageId: "99", text: "persist me" }]);
  second.bridge.close();
});

test("reply_ack retry (server save failed) resends the same reply until ok", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws = await subscribe();
  bridge.sendReply("5", "body");

  ack(ws, "5", "retry", "save_failed");
  assert.equal(frames(ws).length, 1, "retry is delayed, not a hot loop");
  mock.timers.tick(1_000);
  assert.deepEqual(frames(ws), [
    { type: "reply", messageId: "5", text: "body" },
    { type: "reply", messageId: "5", text: "body" },
  ]);

  ack(ws, "5", "retry");
  mock.timers.tick(2_000); // backoff doubles
  assert.equal(frames(ws).length, 3);
  assert.ok(frames(ws).every((f) => f.type === "reply" && f.messageId === "5"));

  ack(ws, "5", "ok");
  mock.timers.tick(60_000);
  assert.equal(frames(ws).length, 3, "nothing more after ok");
  assert.deepEqual(persisted(), []);
  bridge.close();
});

test("reply_ack rejected drops the reply and never turns it into an unsolicited send", async () => {
  const { bridge, logs } = makeBridge();
  bridge.connect();
  const ws = await subscribe();
  bridge.sendReply("11", "too late");

  ack(ws, "11", "rejected", "expired");
  assert.deepEqual(bridge.pendingReplyIds(), []);
  assert.deepEqual(persisted(), []);
  assert.ok(logs.some((l) => l.includes("rejected") && l.includes("expired")));

  mock.timers.tick(60_000);
  const ws2 = await dropAndReconnect(ws);
  const all = [...frames(ws), ...frames(ws2)];
  assert.deepEqual(all, [{ type: "reply", messageId: "11", text: "too late" }]);
  assert.ok(!all.some((f) => f.type === "send"), "rejected reply must not become type: send");
  bridge.close();
});

test("no ack from an ack-capable server resends the same reply after the timeout", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws = await subscribe();
  bridge.sendReply("1", "a");
  ack(ws, "1", "ok"); // server has shown it acks replies

  bridge.sendReply("2", "b");
  mock.timers.tick(15_000);
  const replies = frames(ws).filter((f) => f.messageId === "2");
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[1], { type: "reply", messageId: "2", text: "b" });
  bridge.close();
});

test("a server that never sends reply_ack is not double-posted", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws = await subscribe();
  bridge.sendReply("3", "legacy");
  mock.timers.tick(15_000);
  assert.deepEqual(bridge.pendingReplyIds(), []);
  mock.timers.tick(120_000);
  assert.equal(frames(ws).length, 1);
  bridge.close();
});

test("duplicate sendReply for one messageId sends once (first wins)", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws = await subscribe();
  bridge.sendReply("8", "one");
  bridge.sendReply("8", "two");
  assert.deepEqual(frames(ws), [{ type: "reply", messageId: "8", text: "one" }]);
  bridge.close();
});

test("unsolicited send while offline is retried after reconnect as type: send", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws1 = await subscribe();
  ws1.close();
  assert.equal(bridge.sendMessage("greeting"), false);

  mock.timers.tick(1_000);
  const ws2 = await subscribe();
  assert.deepEqual(frames(ws2), [{ type: "send", text: "greeting", bridgeName: "test" }]);
  bridge.close();
});

test("watchdog: detaches before terminate and schedules exactly one reconnect", async () => {
  const { bridge, logs, disconnects, fetchImpl } = makeBridge();
  bridge.connect();
  const ws1 = await subscribe();
  const terminateSawListeners = [];
  const origTerminate = ws1.terminate.bind(ws1);
  ws1.terminate = () => {
    terminateSawListeners.push(ws1.listenerCount("close") + ws1.listenerCount("message"));
    origTerminate();
  };

  mock.timers.tick(20_000); // > 15s with no inbound frames
  assert.deepEqual(terminateSawListeners, [0], "listeners must be removed before terminate");
  assert.equal(ws1.terminated, true);
  assert.equal(disconnects.length, 1);

  // Late events from the dead socket must not schedule another reconnect.
  ws1.emit("close");
  ws1.emit("error", new Error("late"));
  assert.equal(logs.filter((l) => l.includes("Reconnecting in")).length, 1);

  mock.timers.tick(1_000);
  const ws2 = await subscribe();
  assert.equal(fetchImpl.count(), 2, "exactly one reconnect mint");
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(bridge.isConnected(), true);

  ws1.emit("close"); // stale socket again, after reconnect
  assert.equal(bridge.isConnected(), true, "stale close must not drop the new socket");
  mock.timers.tick(60_000);
  // ws2 keeps receiving nothing → its own watchdog fires once more; still one socket at a time.
  assert.ok(FakeWebSocket.instances.filter((w) => w.readyState !== 3).length <= 1);
  assert.equal(ws2.terminated, true);
  bridge.close();
});

test("error followed by close yields one disconnect and one reconnect timer", async () => {
  const { bridge, logs, disconnects, fetchImpl } = makeBridge();
  bridge.connect();
  const ws = await subscribe();
  ws.emit("error", new Error("ECONNRESET"));
  ws.emit("close");
  assert.equal(disconnects.length, 1);
  assert.equal(disconnects[0].message, "ECONNRESET");
  assert.equal(logs.filter((l) => l.includes("Reconnecting in")).length, 1);
  mock.timers.tick(1_000);
  await flush();
  assert.equal(fetchImpl.count(), 2);
  assert.equal(FakeWebSocket.instances.length, 2);
  bridge.close();
});

test("close() detaches the socket and cancels the pending reconnect", async () => {
  const { bridge, fetchImpl, disconnects } = makeBridge();
  bridge.connect();
  const ws = await subscribe();
  ws.emit("error", new Error("boom")); // schedules a reconnect
  bridge.close();
  mock.timers.tick(60_000);
  await flush();
  assert.equal(fetchImpl.count(), 1);
  assert.equal(disconnects.length, 1);
});

test("ReplyOutbox ignores a corrupt file and keeps working when writes fail", () => {
  const errors = [];
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  const box = new ReplyOutbox(bad, (m) => errors.push(m));
  assert.equal(box.size, 0);
  assert.ok(errors.some((e) => e.includes("not valid JSON")));

  writeFileSync(join(dir, "file"), "x");
  const unwritable = new ReplyOutbox(join(dir, "file", "outbox.json"), (m) => errors.push(m));
  assert.equal(unwritable.add("1", "t"), true);
  assert.equal(unwritable.has("1"), true, "in-memory outbox still holds the reply");
  assert.ok(errors.some((e) => e.includes("outbox write failed")));
});

test("ReplyOutbox drops entries older than 24h on load", () => {
  const p = join(dir, "old.json");
  const now = Date.now();
  writeFileSync(p, JSON.stringify({
    version: 1,
    replies: [
      { messageId: "old", text: "x", createdAt: now - 25 * 3600_000, attempts: 1 },
      { messageId: "new", text: "y", createdAt: now, attempts: 0 },
      { messageId: 5, text: "bad id" },
    ],
  }));
  assert.deepEqual(new ReplyOutbox(p).list().map((e) => e.messageId), ["new"]);
});

test("defaultOutboxPath sits under ~/.openclaw/primeta and sanitizes the account id", () => {
  const p = defaultOutboxPath("../evil/id");
  assert.match(p, /\.openclaw[\\/]primeta[\\/]outbox-\.\._evil_id\.json$/);
});
