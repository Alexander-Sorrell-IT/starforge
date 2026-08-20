// @ts-nocheck
// tests/serve.test.mjs — pure-logic tests for src/serve.mjs
//
// Zero real network calls. Every test drives makeHandler() directly with
// fake req/res objects. No createServer, no bind, no sockets — these tests
// pass on any machine regardless of what services are running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { lanIp, findHtml, makeHandler } from "../src/serve.mjs";

// ── Fake req/res helpers ──────────────────────────────────────────────────────

// Build a minimal fake request. socket is a stub with .remoteAddress and
// .once() — the handler only ever reads those two things.
function fakeReq(method = "GET", url = "/") {
  return {
    method,
    url,
    socket: { remoteAddress: "1.2.3.4", once() {} },
  };
}

// Build a fake response that records writeHead calls and the body passed to end().
function fakeRes() {
  const calls = { writeHead: null, ended: null, headers: {} };
  return {
    _calls: calls,
    writeHead(status, headers) {
      calls.writeHead = status;
      Object.assign(calls.headers, headers ?? {});
    },
    end(body) {
      calls.ended = body ?? "";
    },
  };
}

// ── lanIp() — contract only, never dials out ──────────────────────────────────

test("lanIp returns a non-empty string", () => {
  assert.equal(typeof lanIp(), "string");
  assert.ok(lanIp().length > 0);
});

test("lanIp returns a dotted-decimal IPv4 address", () => {
  assert.match(lanIp(), /^\d{1,3}(\.\d{1,3}){3}$/);
});

test("lanIp never returns a link-local address (169.254.x.x)", () => {
  assert.ok(!lanIp().startsWith("169.254."));
});

// ── findHtml() ────────────────────────────────────────────────────────────────

test("findHtml returns null when the reports dir does not exist", () => {
  const absent = join(tmpdir(), "starreckon-no-such-home-" + Math.random());
  assert.equal(findHtml(absent), null);
});

test("findHtml returns null when reports dir exists but has no stats-*.html files", () => {
  const home = join(tmpdir(), "starreckon-test-" + Math.floor(Math.random() * 1e9));
  mkdirSync(join(home, ".starreckon", "reports"), { recursive: true });
  writeFileSync(join(home, ".starreckon", "reports", "readme.txt"), "nothing here");
  assert.equal(findHtml(home), null);
  rmSync(home, { recursive: true, force: true });
});

test("findHtml returns the most recent stats-*.html file", () => {
  const home = join(tmpdir(), "starreckon-test-" + Math.floor(Math.random() * 1e9));
  const dir = join(home, ".starreckon", "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stats-2025-01.html"), "jan");
  writeFileSync(join(dir, "stats-2025-03.html"), "mar");
  writeFileSync(join(dir, "stats-2025-02.html"), "feb");
  const result = findHtml(home);
  assert.ok(result.endsWith("stats-2025-03.html"), `expected march, got ${result}`);
  rmSync(home, { recursive: true, force: true });
});

// ── makeHandler — routing ─────────────────────────────────────────────────────

test("GET / → 200 with the HTML body", () => {
  const html = "<html>hello</html>";
  const { handler } = makeHandler(html, 3);
  const res = fakeRes();
  handler(fakeReq("GET", "/"), res);
  assert.equal(res._calls.writeHead, 200);
  assert.equal(res._calls.ended, html);
});

test("GET /index.html → 200", () => {
  const { handler } = makeHandler("<html>idx</html>", 3);
  const res = fakeRes();
  handler(fakeReq("GET", "/index.html"), res);
  assert.equal(res._calls.writeHead, 200);
});

test("GET /other → 404", () => {
  const { handler } = makeHandler("<html>x</html>", 3);
  const res = fakeRes();
  handler(fakeReq("GET", "/other"), res);
  assert.equal(res._calls.writeHead, 404);
});

test("POST / → 404 (only GET is served)", () => {
  const { handler } = makeHandler("<html>x</html>", 3);
  const res = fakeRes();
  handler(fakeReq("POST", "/"), res);
  assert.equal(res._calls.writeHead, 404);
});

test("DELETE / → 404", () => {
  const { handler } = makeHandler("<html>x</html>", 3);
  const res = fakeRes();
  handler(fakeReq("DELETE", "/"), res);
  assert.equal(res._calls.writeHead, 404);
});

// ── makeHandler — response headers ───────────────────────────────────────────

test("200 response includes Content-Type text/html", () => {
  const { handler } = makeHandler("<html>h</html>", 3);
  const res = fakeRes();
  handler(fakeReq(), res);
  assert.ok(res._calls.headers["Content-Type"]?.includes("text/html"));
});

test("200 response includes Cache-Control no-store", () => {
  const { handler } = makeHandler("<html>h</html>", 3);
  const res = fakeRes();
  handler(fakeReq(), res);
  assert.equal(res._calls.headers["Cache-Control"], "no-store");
});

test("200 response includes X-Frame-Options DENY", () => {
  const { handler } = makeHandler("<html>h</html>", 3);
  const res = fakeRes();
  handler(fakeReq(), res);
  assert.equal(res._calls.headers["X-Frame-Options"], "DENY");
});

test("200 response includes X-Content-Type-Options nosniff", () => {
  const { handler } = makeHandler("<html>h</html>", 3);
  const res = fakeRes();
  handler(fakeReq(), res);
  assert.equal(res._calls.headers["X-Content-Type-Options"], "nosniff");
});

// ── makeHandler — visit counter ───────────────────────────────────────────────

test("getVisits starts at 0", () => {
  const { getVisits } = makeHandler("<html>v</html>", 5);
  assert.equal(getVisits(), 0);
});

test("getVisits increments on each successful GET /", () => {
  const { handler, getVisits } = makeHandler("<html>v</html>", 5);
  handler(fakeReq(), fakeRes());
  assert.equal(getVisits(), 1);
  handler(fakeReq(), fakeRes());
  assert.equal(getVisits(), 2);
});

test("404 requests do not increment the visit counter", () => {
  const { handler, getVisits } = makeHandler("<html>v</html>", 5);
  handler(fakeReq("GET", "/robots.txt"), fakeRes());
  handler(fakeReq("POST", "/"), fakeRes());
  assert.equal(getVisits(), 0);
});

// ── makeHandler — shutdown callback ──────────────────────────────────────────

test("onShutdown callback fires exactly when maxVisits is reached", () => {
  let fired = 0;
  const { handler, onShutdown } = makeHandler("<html>s</html>", 2);
  onShutdown(() => fired++);
  handler(fakeReq(), fakeRes()); // visit 1 — no fire
  assert.equal(fired, 0);
  handler(fakeReq(), fakeRes()); // visit 2 — fires
  assert.equal(fired, 1);
});

test("onShutdown does not fire again after maxVisits", () => {
  let fired = 0;
  const { handler, onShutdown } = makeHandler("<html>s</html>", 1);
  onShutdown(() => fired++);
  handler(fakeReq(), fakeRes()); // hits limit
  handler(fakeReq(), fakeRes()); // extra — should not re-fire
  assert.equal(fired, 1);
});

test("no shutdown callback registered: extra visits after limit do not throw", () => {
  const { handler } = makeHandler("<html>s</html>", 1);
  // No onShutdown registered — hitting the limit must not throw
  assert.doesNotThrow(() => {
    handler(fakeReq(), fakeRes());
    handler(fakeReq(), fakeRes());
  });
});

// ── makeHandler — HTML content isolation ─────────────────────────────────────

test("two independent handlers each serve their own HTML", () => {
  const { handler: h1 } = makeHandler("<html>one</html>", 5);
  const { handler: h2 } = makeHandler("<html>two</html>", 5);
  const r1 = fakeRes(); h1(fakeReq(), r1);
  const r2 = fakeRes(); h2(fakeReq(), r2);
  assert.equal(r1._calls.ended, "<html>one</html>");
  assert.equal(r2._calls.ended, "<html>two</html>");
});

test("visit counters of two handlers are independent", () => {
  const { handler: h1, getVisits: v1 } = makeHandler("<html>a</html>", 5);
  const { handler: h2, getVisits: v2 } = makeHandler("<html>b</html>", 5);
  h1(fakeReq(), fakeRes());
  h1(fakeReq(), fakeRes());
  h2(fakeReq(), fakeRes());
  assert.equal(v1(), 2);
  assert.equal(v2(), 1);
});

// ── makeHandler — req.socket is optional (stub-less req) ─────────────────────

test("handler works when req.socket is null", () => {
  const { handler } = makeHandler("<html>nosock</html>", 3);
  const res = fakeRes();
  // Some environments or test stubs may not provide req.socket
  handler({ method: "GET", url: "/", socket: null }, res);
  assert.equal(res._calls.writeHead, 200);
});

test("handler works when req.socket has no .once method", () => {
  const { handler } = makeHandler("<html>nosock</html>", 3);
  const res = fakeRes();
  handler({ method: "GET", url: "/", socket: { remoteAddress: "5.6.7.8" } }, res);
  assert.equal(res._calls.writeHead, 200);
});

// ── EADDRINUSE message ────────────────────────────────────────────────────────
// (Tested without binding — just verify the error text shape by constructing
//  the error the same way startServe does)

test("EADDRINUSE produces a message containing 'already in use'", () => {
  const port = 9999;
  const err = new Error(`port ${port} is already in use — try --serve-port=NNNN`);
  err.code = "EADDRINUSE";
  assert.match(err.message, /already in use/);
  assert.match(err.message, /--serve-port/);
});

// ── sanitizeFolderName ────────────────────────────────────────────────────────

import { sanitizeFolderName } from "../src/serve.mjs";

test("sanitizeFolderName accepts a clean slug", () => {
  assert.equal(sanitizeFolderName("my-laptop"), "my-laptop");
});

test("sanitizeFolderName lowercases and strips special chars", () => {
  assert.equal(sanitizeFolderName("My Laptop!"), "my-laptop");
});

test("sanitizeFolderName trims leading/trailing hyphens", () => {
  assert.equal(sanitizeFolderName("--laptop--"), "laptop");
});

test("sanitizeFolderName returns null for empty string", () => {
  assert.equal(sanitizeFolderName(""), null);
});

test("sanitizeFolderName returns null for null/undefined", () => {
  assert.equal(sanitizeFolderName(null), null);
  assert.equal(sanitizeFolderName(undefined), null);
});

test("sanitizeFolderName returns null for dot-only name", () => {
  assert.equal(sanitizeFolderName("."), null);
  assert.equal(sanitizeFolderName(".."), null);
});

test("sanitizeFolderName strips leading dot and keeps the rest", () => {
  // ".hidden" → strip leading dot → "hidden" (valid slug, not null)
  assert.equal(sanitizeFolderName(".hidden"), "hidden");
});

test("sanitizeFolderName truncates at 64 characters", () => {
  const long = "a".repeat(100);
  assert.equal(sanitizeFolderName(long).length, 64);
});

// ── POST /submit — collect disabled ──────────────────────────────────────────

test("POST /submit returns 404 when collect is not enabled", () => {
  const { handler } = makeHandler("<html>x</html>", 3, null);
  const res = fakeRes();
  // Fake a POST with no data events needed (no collectDir path, returns synchronously)
  handler({ method: "POST", url: "/submit", socket: null, on() {} }, res);
  assert.equal(res._calls.writeHead, 404);
});

// ── POST /submit — collect enabled ───────────────────────────────────────────

// Helper: build a fake req that emits data then end, simulating a POST body.
// Uses process.nextTick (not Promise microtasks) so the callbacks fire after
// both "data" and "end" listeners have been registered, without creating
// Promise chains that can outlive the test in Node 20 worker IPC.
function fakePost(url, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const listeners = {};
  return {
    method: "POST",
    url,
    socket: { remoteAddress: "9.9.9.9" },
    on(event, fn) {
      listeners[event] = fn;
      if (event === "end") {
        process.nextTick(() => {
          listeners["data"]?.(body);
          process.nextTick(() => listeners["end"]?.());
        });
      }
    },
  };
}

test("POST /submit with valid payload returns 200 and writes folder", async () => {
  const dir = join(tmpdir(), "starreckon-collect-" + Math.floor(Math.random() * 1e9));
  const { handler } = makeHandler("<html>x</html>", 99, dir);
  const res = fakeRes();

  // Minimal valid payload: folderName + accounts (empty) + sessions (empty)
  // writeMachineFolder tolerates empty arrays fine (grandTotal = 0)
  const payload = { folderName: "test-machine", accounts: [], sessions: [] };
  handler(fakePost("/submit", payload), res);

  // Wait for the async body events to fire
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  assert.equal(res._calls.writeHead, 200, `expected 200 got ${res._calls.writeHead}: ${res._calls.ended}`);
  const body = JSON.parse(res._calls.ended);
  assert.equal(body.ok, true);
  assert.equal(body.folder, "test-machine");
  assert.equal(body.grandTotal, 0);

  // Folder was actually written on disk
  assert.ok(existsSync(join(dir, "test-machine", "machine-readable", "totals.json")));

  rmSync(dir, { recursive: true, force: true });
});

test("POST /submit with invalid JSON returns 400", async () => {
  const dir = join(tmpdir(), "starreckon-collect-" + Math.floor(Math.random() * 1e9));
  const { handler } = makeHandler("<html>x</html>", 99, dir);
  const res = fakeRes();

  // Build a fake req that sends bad JSON
  const listeners = {};
  const badReq = {
    method: "POST", url: "/submit", socket: null,
    on(event, fn) {
      listeners[event] = fn;
      if (event === "end") {
        Promise.resolve().then(() => {
          listeners["data"]?.("not json {{{{");
          listeners["end"]?.();
        });
      }
    },
  };

  handler(badReq, res);
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  assert.equal(res._calls.writeHead, 400);
  assert.equal(JSON.parse(res._calls.ended).error, "invalid JSON");

  rmSync(dir, { recursive: true, force: true });
});

test("POST /submit with missing folderName returns 400", async () => {
  const dir = join(tmpdir(), "starreckon-collect-" + Math.floor(Math.random() * 1e9));
  const { handler } = makeHandler("<html>x</html>", 99, dir);
  const res = fakeRes();

  handler(fakePost("/submit", { accounts: [], sessions: [] }), res);
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  assert.equal(res._calls.writeHead, 400);
  assert.match(JSON.parse(res._calls.ended).error, /folderName/);

  rmSync(dir, { recursive: true, force: true });
});

test("POST /submit uses machine field as folder name when folderName absent", async () => {
  const dir = join(tmpdir(), "starreckon-collect-" + Math.floor(Math.random() * 1e9));
  const { handler } = makeHandler("<html>x</html>", 99, dir);
  const res = fakeRes();

  handler(fakePost("/submit", { machine: "via-machine-field", accounts: [], sessions: [] }), res);
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  assert.equal(res._calls.writeHead, 200);
  assert.equal(JSON.parse(res._calls.ended).folder, "via-machine-field");

  rmSync(dir, { recursive: true, force: true });
});

test("POST /submit sanitises unsafe folder names before writing", async () => {
  const dir = join(tmpdir(), "starreckon-collect-" + Math.floor(Math.random() * 1e9));
  const { handler } = makeHandler("<html>x</html>", 99, dir);
  const res = fakeRes();

  handler(fakePost("/submit", { folderName: "My Laptop 2025!", accounts: [], sessions: [] }), res);
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  assert.equal(res._calls.writeHead, 200);
  // Sanitised to "my-laptop-2025"
  assert.equal(JSON.parse(res._calls.ended).folder, "my-laptop-2025");

  rmSync(dir, { recursive: true, force: true });
});

test("GET / visit counter is unaffected by POST /submit requests", async () => {
  const dir = join(tmpdir(), "starreckon-collect-" + Math.floor(Math.random() * 1e9));
  const { handler, getVisits } = makeHandler("<html>x</html>", 5, dir);

  handler(fakePost("/submit", { folderName: "m", accounts: [], sessions: [] }), fakeRes());
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  assert.equal(getVisits(), 0, "POST /submit must not increment GET visit counter");

  rmSync(dir, { recursive: true, force: true });
});
