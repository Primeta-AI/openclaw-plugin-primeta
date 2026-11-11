// Unit tests for PrimetaBridge's cable-ticket handshake (F-04).
// Runs against the compiled output in dist/ — `npm test` builds first.
// HTTP (fetch) and WebSocket are fully mocked; no network is touched.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PrimetaBridge } from "../dist/primeta-bridge.js";

const API_KEY = "pk_live_SECRET-api-key/with+chars";
const SERVER = "https://primeta.example/";

class FakeWebSocket extends EventEmitter {
  static instances = [];
  readyState = 0;
  sent = [];
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
  terminate() { this.close(); }
}

function jsonResponse(status, body) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetch(responders) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const responder = responders[Math.min(calls.length - 1, responders.length - 1)];
    return responder(calls.length);
  };
  fn.calls = calls;
  return fn;
}

function makeBridge(fetchImpl, extra = {}) {
  const logs = [];
  const disconnects = [];
  const bridge = new PrimetaBridge({
    serverUrl: SERVER,
    apiKey: API_KEY,
    bridgeName: "test",
    onChatMessage: () => {},
    onDisconnected: (err) => disconnects.push(err),
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    fetchImpl,
    webSocketImpl: FakeWebSocket,
    ...extra,
  });
  return { bridge, logs, disconnects };
}

// Let pending promise chains (fetch → json → openSocket) settle.
const flush = () => new Promise((r) => setImmediate(r));

function assertNoKeyLeak(fetchImpl, logs) {
  for (const ws of FakeWebSocket.instances) {
    assert.ok(!ws.url.includes(API_KEY), `ws URL leaked apiKey: ${ws.url}`);
    assert.ok(!ws.url.includes(encodeURIComponent(API_KEY)), `ws URL leaked encoded apiKey: ${ws.url}`);
    assert.ok(!ws.url.includes("bridge_token"), `ws URL used legacy bridge_token: ${ws.url}`);
  }
  for (const call of fetchImpl.calls) {
    assert.ok(!call.url.includes(API_KEY), `fetch URL leaked apiKey: ${call.url}`);
    assert.ok(!call.url.includes(encodeURIComponent(API_KEY)));
  }
  for (const line of logs) {
    assert.ok(!line.includes(API_KEY), `log leaked apiKey: ${line}`);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
});

afterEach(() => {
  mock.timers.reset();
});

test("mints a ticket with the bearer apiKey, then connects with ?ticket= only", async () => {
  const fetchImpl = makeFetch([() => jsonResponse(201, { ticket: "tkt/1+=", expires_in: 60 })]);
  const { bridge, logs } = makeBridge(fetchImpl);

  bridge.connect();
  await flush();

  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "https://primeta.example/cable/tickets");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(init.redirect, "error", "must not follow redirects with the bearer token");

  assert.equal(FakeWebSocket.instances.length, 1);
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, `wss://primeta.example/cable?ticket=${encodeURIComponent("tkt/1+=")}`);
  assert.deepEqual(ws.options.headers, { Origin: "https://primeta.example" });
  assertNoKeyLeak(fetchImpl, logs);

  bridge.close();
});

test("http serverUrl maps to ws:// cable URL", async () => {
  const fetchImpl = makeFetch([() => jsonResponse(201, { ticket: "t", expires_in: 60 })]);
  const { bridge } = makeBridge(fetchImpl, { serverUrl: "http://localhost:3000" });

  bridge.connect();
  await flush();

  assert.equal(fetchImpl.calls[0].url, "http://localhost:3000/cable/tickets");
  assert.equal(FakeWebSocket.instances[0].url, "ws://localhost:3000/cable?ticket=t");
  assert.equal(FakeWebSocket.instances[0].options.headers.Origin, "http://localhost:3000");
  bridge.close();
});

test("mint 401 does not open any socket, reports the error, and never falls back to bridge_token", async () => {
  const fetchImpl = makeFetch([() => jsonResponse(401, { error: "Unauthorized" })]);
  const { bridge, logs, disconnects } = makeBridge(fetchImpl);

  bridge.connect();
  await flush();

  assert.equal(FakeWebSocket.instances.length, 0, "no WebSocket may be opened when mint fails");
  assert.equal(disconnects.length, 1);
  assert.match(disconnects[0].message, /unauthorized \(HTTP 401\)/);
  assert.equal(disconnects[0].status, 401);
  assert.ok(logs.some((l) => l.startsWith("error:") && l.includes("Cable ticket mint failed")));

  // Backoff retry mints again (still failing) — still never opens a socket.
  mock.timers.tick(1_000);
  await flush();
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(FakeWebSocket.instances.length, 0);
  assertNoKeyLeak(fetchImpl, logs);

  bridge.close();
});

for (const [name, responder, pattern] of [
  ["HTTP 500", () => jsonResponse(500, { error: "boom" }), /unexpected HTTP 500/],
  ["non-JSON body", () => new Response("<html>", { status: 201 }), /not valid JSON/],
  ["missing ticket", () => jsonResponse(201, { expires_in: 60 }), /did not include a ticket/],
  ["empty ticket", () => jsonResponse(201, { ticket: "", expires_in: 60 }), /did not include a ticket/],
  ["non-string ticket", () => jsonResponse(201, { ticket: 123 }), /did not include a ticket/],
  ["JSON null body", () => jsonResponse(201, "null"), /did not include a ticket/],
  ["network error", () => { throw new TypeError("fetch failed"); }, /request failed: fetch failed/],
]) {
  test(`mint failure (${name}) opens no socket and schedules a retry`, async () => {
    const fetchImpl = makeFetch([responder]);
    const { bridge, logs, disconnects } = makeBridge(fetchImpl);

    bridge.connect();
    await flush();

    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(disconnects.length, 1);
    assert.match(disconnects[0].message, pattern);
    assert.ok(logs.some((l) => l.includes("Reconnecting in")));
    assertNoKeyLeak(fetchImpl, logs);
    bridge.close();
  });
}

test("mint request times out instead of hanging forever", async () => {
  const fetchImpl = makeFetch([
    (_n) => new Promise((_resolve, reject) => {
      const init = fetchImpl.calls.at(-1).init;
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  ]);
  const { bridge, disconnects } = makeBridge(fetchImpl);

  bridge.connect();
  await flush();
  assert.equal(disconnects.length, 0);

  mock.timers.tick(10_000);
  await flush();
  assert.equal(disconnects.length, 1);
  assert.match(disconnects[0].message, /timed out/);
  assert.equal(FakeWebSocket.instances.length, 0);
  bridge.close();
});

test("reconnect after socket close mints a fresh ticket (tickets are never reused)", async () => {
  const fetchImpl = makeFetch([(n) => jsonResponse(201, { ticket: `tkt-${n}`, expires_in: 60 })]);
  const { bridge, logs } = makeBridge(fetchImpl);

  bridge.connect();
  await flush();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.instances[0].url, "wss://primeta.example/cable?ticket=tkt-1");

  FakeWebSocket.instances[0].close(); // server drop
  mock.timers.tick(1_000);
  await flush();

  assert.equal(fetchImpl.calls.length, 2, "reconnect must mint a new ticket");
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(FakeWebSocket.instances[1].url, "wss://primeta.example/cable?ticket=tkt-2");
  assertNoKeyLeak(fetchImpl, logs);
  bridge.close();
});

test("recovers after a failed mint: next attempt mints and connects", async () => {
  const fetchImpl = makeFetch([
    () => jsonResponse(503, {}),
    () => jsonResponse(201, { ticket: "after-retry", expires_in: 60 }),
  ]);
  const { bridge, logs } = makeBridge(fetchImpl);

  bridge.connect();
  await flush();
  assert.equal(FakeWebSocket.instances.length, 0);

  mock.timers.tick(1_000);
  await flush();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.instances[0].url, "wss://primeta.example/cable?ticket=after-retry");
  assertNoKeyLeak(fetchImpl, logs);
  bridge.close();
});

test("close() during an in-flight mint does not open a socket afterwards", async () => {
  let release;
  const fetchImpl = makeFetch([
    () => new Promise((resolve) => { release = () => resolve(jsonResponse(201, { ticket: "late", expires_in: 60 })); }),
  ]);
  const { bridge } = makeBridge(fetchImpl);

  bridge.connect();
  await flush();
  bridge.close();
  release();
  await flush();

  assert.equal(FakeWebSocket.instances.length, 0);
  mock.timers.tick(60_000);
  await flush();
  assert.equal(fetchImpl.calls.length, 1, "closed bridge must not retry");
});

test("non-http(s) serverUrl is rejected before any request carries the apiKey", async () => {
  const fetchImpl = makeFetch([() => jsonResponse(201, { ticket: "t" })]);
  const { bridge, logs, disconnects } = makeBridge(fetchImpl, {
    serverUrl: `ftp://user:${API_KEY}@primeta.example/?token=${API_KEY}`,
  });

  bridge.connect();
  await flush();

  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.match(disconnects[0].message, /serverUrl must start with http/);
  assertNoKeyLeak(fetchImpl, logs);
  assert.ok(!disconnects[0].message.includes(API_KEY));
  bridge.close();
});

test("subscribes over the ticketed socket once open", async () => {
  const fetchImpl = makeFetch([() => jsonResponse(201, { ticket: "t", expires_in: 60 })]);
  const { bridge } = makeBridge(fetchImpl);

  bridge.connect();
  await flush();
  const ws = FakeWebSocket.instances[0];
  ws.readyState = 1;
  ws.emit("open");
  assert.equal(ws.sent.length, 1);
  assert.equal(JSON.parse(ws.sent[0]).command, "subscribe");

  ws.emit("message", Buffer.from(JSON.stringify({ type: "confirm_subscription" })));
  assert.equal(bridge.isConnected(), true);
  bridge.close();
});
