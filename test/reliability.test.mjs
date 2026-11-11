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

/** F-09 server's post-subscribe capability frame. */
function hello(ws, features = ["reply_ack"]) {
  serverSays(ws, { type: "bridge_hello", features });
}

/** ActionCable heartbeat (bare protocol frame). */
function ping(ws) {
  ws.emit("message", Buffer.from(JSON.stringify({ type: "ping", message: Date.now() })));
}

/** Simulate a live socket for `ms`: a ping every 3s, like ActionCable. */
function pingFor(ws, ms) {
  for (let t = 0; t < ms; t += 3_000) {
    mock.timers.tick(3_000);
    ping(ws);
  }
}

function replyFrames(...sockets) {
  return sockets.flatMap(frames).filter((f) => f.type === "reply");
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

test("reply lost to a disconnect is resent (same messageId) only once the new subscription proves reply_ack", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws1 = await subscribe();
  bridge.sendReply("7", "first try");
  assert.equal(frames(ws1).length, 1);

  const ws2 = await dropAndReconnect(ws1);
  assert.notEqual(ws1, ws2);
  assert.deepEqual(frames(ws2), [], "already-attempted reply is held until the server proves it acks");
  assert.deepEqual(bridge.pendingReplyIds(), ["7"]);

  hello(ws2);
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

test("a live server that never sends hello/reply_ack is not double-posted (no-ack 15s)", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws = await subscribe();
  bridge.sendReply("3", "legacy");
  pingFor(ws, 15_000);
  assert.deepEqual(bridge.pendingReplyIds(), [], "settled as delivered on a live pre-F-09 subscription");
  assert.deepEqual(persisted(), []);
  pingFor(ws, 120_000);
  assert.equal(bridge.isConnected(), true);
  assert.deepEqual(frames(ws), [{ type: "reply", messageId: "3", text: "legacy" }]);
  bridge.close();
});

test("pre-F-09 server (confirm + pings, no hello, no ack) gets exactly one reply across reconnects and a restart", async () => {
  const first = makeBridge();
  first.bridge.connect();
  const ws1 = await subscribe();
  first.bridge.sendReply("50", "once");
  // Socket dies before any ping proves the server live.
  const ws2 = await dropAndReconnect(ws1);
  assert.deepEqual(frames(ws2), [], "no resend without proof of reply_ack");
  ping(ws2); // inside the hello grace window — not yet proof of a legacy server
  const ws3 = await dropAndReconnect(ws2, 2_000);
  assert.deepEqual(frames(ws3), []);
  assert.deepEqual(first.bridge.pendingReplyIds(), ["50"]);
  first.bridge.close();

  // Process restart: the attempted entry is reloaded from disk...
  const second = makeBridge();
  assert.deepEqual(second.bridge.pendingReplyIds(), ["50"]);
  second.bridge.connect();
  const ws4 = await subscribe();
  assert.deepEqual(frames(ws4), [], "attempted entry is not blindly resent after restart");
  // ...and settled as delivered once the legacy server is shown to be live.
  pingFor(ws4, 30_000);
  assert.deepEqual(second.bridge.pendingReplyIds(), []);
  assert.deepEqual(persisted(), []);

  const ws5 = await dropAndReconnect(ws4);
  pingFor(ws5, 30_000);
  const all = replyFrames(ws1, ws2, ws3, ws4, ws5);
  assert.deepEqual(all, [{ type: "reply", messageId: "50", text: "once" }]);
  assert.ok(![ws1, ws2, ws3, ws4, ws5].flatMap(frames).some((f) => f.type === "send"), "never converted to send");
  second.bridge.close();
});

test("first reply on a socket that dies before hello/ack stays pending and is resent after a hello-capable subscribe", async () => {
  const { bridge, disconnects } = makeBridge();
  bridge.connect();
  const ws1 = await subscribe();
  bridge.sendReply("60", "dead socket");
  mock.timers.tick(15_000); // ack timeout, no frames at all
  assert.deepEqual(bridge.pendingReplyIds(), ["60"], "not settled as delivered on a possibly-dead socket");
  mock.timers.tick(5_000); // watchdog fires
  assert.equal(disconnects.length, 1);
  assert.deepEqual(bridge.pendingReplyIds(), ["60"]);
  assert.deepEqual(persisted(), ["60"]);

  mock.timers.tick(1_000);
  const ws2 = await subscribe();
  assert.deepEqual(frames(ws2), []);
  hello(ws2);
  assert.deepEqual(frames(ws2), [{ type: "reply", messageId: "60", text: "dead socket" }]);
  ack(ws2, "60", "ok");
  assert.deepEqual(bridge.pendingReplyIds(), []);
  bridge.close();
});

test("a ping racing ahead of the hello broadcast does not settle a pending reply", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws1 = await subscribe();
  bridge.sendReply("70", "race");
  const ws2 = await dropAndReconnect(ws1);
  mock.timers.tick(500);
  ping(ws2); // arrives before the hello broadcast
  hello(ws2);
  assert.deepEqual(frames(ws2), [{ type: "reply", messageId: "70", text: "race" }]);
  pingFor(ws2, 30_000);
  assert.deepEqual(bridge.pendingReplyIds(), ["70"], "ack-capable: still waiting for the ack");
  bridge.close();
});

test("reply_ack capability is per subscription, not carried across reconnects or restarts", async () => {
  const first = makeBridge();
  first.bridge.connect();
  const ws1 = await subscribe();
  hello(ws1);
  first.bridge.sendReply("80", "x");
  const ws2 = await dropAndReconnect(ws1);
  // Now a pre-F-09 server answers (e.g. rollback): no hello, just pings.
  pingFor(ws2, 6_000);
  assert.deepEqual(frames(ws2), [], "hello on an earlier socket does not authorize a resend");
  assert.deepEqual(first.bridge.pendingReplyIds(), []);
  first.bridge.close();

  // Restart with an attempted entry on disk and a hello without reply_ack.
  writeFileSync(join(dir, "outbox.json"), JSON.stringify({
    version: 1,
    replies: [{ messageId: "81", text: "y", createdAt: Date.now(), attempts: 1 }],
  }));
  const second = makeBridge();
  second.bridge.connect();
  const ws3 = await subscribe();
  hello(ws3, []);
  pingFor(ws3, 6_000);
  assert.deepEqual(frames(ws3), []);
  assert.deepEqual(second.bridge.pendingReplyIds(), []);
  second.bridge.close();
});

test("bridge_hello / reply_ack arriving before confirm_subscription is latched and releases held replies on confirm", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws1 = await subscribe();
  bridge.sendReply("95", "attempted");
  ws1.close();
  mock.timers.tick(1_000);
  await flush();

  // Server transmits hello from `subscribed` before ActionCable's confirm.
  const ws2 = lastWs();
  ws2.readyState = 1;
  ws2.emit("open");
  hello(ws2);
  assert.deepEqual(frames(ws2), [], "nothing is written before confirm_subscription");
  ws2.emit("message", Buffer.from(JSON.stringify({ type: "confirm_subscription", identifier: IDENT })));
  assert.deepEqual(frames(ws2), [{ type: "reply", messageId: "95", text: "attempted" }]);
  ack(ws2, "95", "ok");
  assert.deepEqual(bridge.pendingReplyIds(), []);

  // An early reply_ack (for an unknown id) latches too.
  bridge.sendReply("96", "attempted again");
  const ws3 = await dropAndReconnect(ws2);
  assert.deepEqual(frames(ws3), [], "latch reset on drop: held until proven");
  ws3.close();
  mock.timers.tick(2_000);
  await flush();
  const ws4 = lastWs();
  ws4.readyState = 1;
  ws4.emit("open");
  ack(ws4, "unknown", "rejected");
  ws4.emit("message", Buffer.from(JSON.stringify({ type: "confirm_subscription", identifier: IDENT })));
  assert.deepEqual(frames(ws4), [{ type: "reply", messageId: "96", text: "attempted again" }]);

  // A latch on a socket that is dropped before confirm does not carry over.
  bridge.sendReply("97", "third");
  ws4.close();
  mock.timers.tick(4_000);
  await flush();
  const ws5 = lastWs();
  ws5.readyState = 1;
  ws5.emit("open");
  hello(ws5);
  ws5.close();
  mock.timers.tick(8_000);
  const ws6 = await subscribe();
  assert.deepEqual(frames(ws6), [], "pre-confirm hello on a dropped socket must not authorize a resend");
  bridge.close();
});

test("a reply_ack frame alone proves capability and releases held replies", async () => {
  const { bridge } = makeBridge();
  bridge.connect();
  const ws1 = await subscribe();
  bridge.sendReply("90", "held");
  const ws2 = await dropAndReconnect(ws1);
  bridge.sendReply("91", "fresh");
  assert.deepEqual(frames(ws2), [{ type: "reply", messageId: "91", text: "fresh" }]);
  ack(ws2, "91", "ok");
  assert.deepEqual(frames(ws2), [
    { type: "reply", messageId: "91", text: "fresh" },
    { type: "reply", messageId: "90", text: "held" },
  ]);
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
