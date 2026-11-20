import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { buildDesktopDevicePayload, desktopDevicePublicKeySha256, verifyDesktopDeviceSignature } from "@codeflowai/shared/desktop-device-auth";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { createDesktopUpdateTransport } from "../src/updateTransport.js";
import { createUpdateNetworkRetry } from "../src/updateNetworkRetry.js";

test("download transport bounds inactivity without imposing a total transfer deadline", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-download-timeout-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const server = http.createServer((request, response) => {
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId,
      method: request.method!, url: request.url!, body: Buffer.alloc(0), requestId: String(request.headers["x-codeflow-request-id"]),
      timestamp: Number(request.headers["x-codeflow-timestamp"]), range: request.headers.range ?? null, ifMatch: request.headers["if-match"] ?? null }),
    String(request.headers["x-codeflow-signature"]));
    if (request.url === "/api/software/desktop/headers") return;
    const json = request.url === "/api/software/desktop/json" || request.url === "/api/software/desktop/http-error";
    response.writeHead(request.url === "/api/software/desktop/http-error" ? 503 : request.headers.range ? 206 : 200,
      { etag: '"download"', ...(request.headers.range ? { "content-range": "bytes 1-8/9" } : {}) });
    response.write(json ? '{"ok":true,"padding":"' : "x");
    if (request.url === "/api/software/desktop/stalled") return;
    let chunks = 1;
    const timer = setInterval(() => {
      response.write("x");
      if (++chunks === 8) { clearInterval(timer); response.end(json ? '"}' : ""); }
    }, 50);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const transport = createDesktopUpdateTransport({ dataDir, identity, timeoutMs: 200,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  for (const method of ["request", "requestRaw"] as const) await t.test(`${method} accepts continuous progress beyond the header budget`, async () => {
    const response = await transport[method]({ method: "GET", path: "/api/software/desktop/download", range: "bytes=1-", ifMatch: '"download"', streamResponse: true });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 1-8/9");
    assert.equal(response.headers.get("etag"), '"download"');
    assert.equal(await response.text(), "xxxxxxxx");
  });
  await t.test("waiting for response headers remains bounded", { timeout: 2_000 }, async () => {
    await assert.rejects(transport.requestRaw({ method: "GET", path: "/api/software/desktop/headers", requestId: "header-timeout", streamResponse: true }),
      (error: any) => error.requestId === "header-timeout" && error.cause?.name === "TimeoutError");
  });
  await t.test("a stalled body fails within its inactivity budget", { timeout: 2_000 }, async () => {
    const response = await transport.request({ method: "GET", path: "/api/software/desktop/stalled", requestId: "stalled-download", streamResponse: true });
    await assert.rejects(response.text(), (error: any) => error.name === "TimeoutError" && error.requestId === "stalled-download");
  });
  for (const reason of [new Error("download cancelled by user"), "cancelled-by-user"]) await t.test(`user cancellation preserves its original ${typeof reason} reason during body reads`, async () => {
    const abort = new AbortController();
    const response = await transport.requestRaw({ method: "GET", path: "/api/software/desktop/download", signal: abort.signal, streamResponse: true });
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    const pending = reader.read();
    abort.abort(reason);
    await assert.rejects(pending, error => error === reason || (error as Error).cause === reason);
    reader.releaseLock();
  });
  await t.test("JSON keeps its total timeout even with continuous progress", async () => {
    await assert.rejects(transport.requestJson({ method: "GET", path: "/api/software/desktop/json" }),
      (error: any) => error.code === "DESKTOP_UPDATE_RESPONSE_INVALID" && error.cause?.name === "TimeoutError");
  });
  for (const method of ["request", "requestRaw"] as const) await t.test(`${method} keeps the total timeout unless streaming is explicit`, async () => {
    const response = await transport[method]({ method: "GET", path: "/api/software/desktop/json" });
    await assert.rejects(response.text(), (error: any) => error.name === "TimeoutError");
  });
  await t.test("HTTP error JSON keeps its total timeout even with continuous progress", async () => {
    await assert.rejects(transport.request({ method: "GET", path: "/api/software/desktop/http-error", streamResponse: true }),
      (error: any) => error.code === "DESKTOP_UPDATE_HTTP_FAILED" && error.cause?.name === "TimeoutError");
  });
  await t.test("raw HTTP error JSON keeps its total timeout for explicit downloads", async () => {
    const response = await transport.requestRaw({ method: "GET", path: "/api/software/desktop/http-error", streamResponse: true });
    await assert.rejects(response.text(), (error: any) => error.name === "TimeoutError");
  });
});

test("账号 Server 的 HTTP 例外仅允许设备签名登记，不开放更新请求", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-account-registration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options: RequestInit) => {
    calls++;
    assert.equal(String(url), "http://test-server.invalid:39280/api/software/desktop/devices/register");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    const headers = options.headers as Record<string, string>;
    assert.equal(headers.authorization, undefined);
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId,
      method: "POST", url: "/api/software/desktop/devices/register", body: Buffer.from(options.body as Buffer),
      requestId: headers["x-codeflow-request-id"]!, timestamp: Number(headers["x-codeflow-timestamp"]) }), headers["x-codeflow-signature"]!);
    return Response.json({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) });
  });
  const transport = createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: "http://test-server.invalid:39280", allowHttpRegistration: true });
  await transport.register();
  for (const method of ["request", "requestRaw", "requestJson"] as const) {
    await assert.rejects(transport[method]({ method: "GET", path: "/api/software/desktop/release" }), /DESKTOP_UPDATE_ORIGIN_INVALID/u);
    await assert.rejects(transport[method]({ method: "POST", path: "/api/software/desktop/receipts" }), /DESKTOP_UPDATE_ORIGIN_INVALID/u);
  }
  assert.equal(calls, 1);
  assert.throws(() => createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: "http://test-server.invalid:39280" }), /DESKTOP_UPDATE_ORIGIN_INVALID/u);
});

test("raw request returns headers without reading its body or entering transport retry", async t => {
  for (const status of [200, 503]) await t.test(String(status), async t => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-raw-transport-")), identity = await loadOrCreateDeviceIdentity(dataDir);
    let cancelled: unknown;
    const response = new Response(new ReadableStream({
      /** raw 返回响应头时不得提前读取正文。 */
      pull() { assert.fail("RAW_MUST_NOT_READ_BODY"); },
      /** owner 放弃正文时必须把同一取消原因交给上游。 */
      cancel(reason) { cancelled = reason; },
    }, { highWaterMark: 0 }), { status, headers: { "retry-after": "2" } });
    let sent = 0, contexts = 0;
    t.mock.method(response, "json", () => { throw new Error("RAW_MUST_NOT_PARSE_JSON"); });
    t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, options: RequestInit) => {
      sent++; assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
      const headers = options.headers as Record<string, string>;
      assert.equal(headers["x-codeflow-request-id"], "raw-request");
      verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId,
        method: "GET", url: "/api/software/desktop/raw", body: Buffer.alloc(0), requestId: "raw-request", timestamp: Number(headers["x-codeflow-timestamp"]) }), headers["x-codeflow-signature"]!);
      return response;
    });
    const transport = createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: "http://127.0.0.1:39280",
      getNetworkContext: () => { contexts++; throw new Error("RAW_MUST_NOT_ENTER_INTERNAL_RETRY"); } });
    const raw = (transport as unknown as { requestRaw?: (value: unknown) => Promise<Response> }).requestRaw;
    assert.equal(typeof raw, "function", "single-send requestRaw must exist");
    const actual = await raw!({ method: "GET", path: "/api/software/desktop/raw", requestId: "raw-request", streamResponse: true });
    assert.equal(actual.status, status); assert.equal(actual.headers.get("retry-after"), "2");
    assert.equal(actual.bodyUsed, false); assert.equal(sent, 1); assert.equal(contexts, 0);
    const reason = new Error("owner rejected response headers");
    await actual.body!.cancel(reason);
    assert.equal(cancelled, reason); assert.equal(response.body!.locked, false);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
});

test("transport sends signed requests only to its configured origin and verifies registration acknowledgement", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  let calls = 0;
  let registrationBody: unknown;
  const server = http.createServer(async (req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    if (req.url === "/api/software/desktop/devices/register") {
      registrationBody = JSON.parse(body.toString("utf8"));
    }
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId,
      method: req.method!, url: req.url!, body, requestId: String(req.headers["x-codeflow-request-id"]),
      timestamp: Number(req.headers["x-codeflow-timestamp"]), range: req.headers.range ?? null, ifMatch: req.headers["if-match"] ?? null }),
    String(req.headers["x-codeflow-signature"]));
    if (req.url === "/api/software/desktop/redirect") { res.writeHead(302, { location: "/elsewhere" }); res.end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, deviceId: identity.deviceId,
      publicKeySha256: crypto.createHash("sha256").update(Buffer.from(identity.publicKeyBase64, "base64")).digest("hex") }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const transport = createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: origin });
    await transport.register();
    assert.deepEqual(registrationBody, { deviceId: identity.deviceId, publicKeyBase64: identity.publicKeyBase64,
      platform: process.platform, arch: process.arch,
      shellVersion: "unknown", webVersion: "unknown", clientVersion: "unknown", releaseId: "unknown" });
    await transport.request({ method: "GET", path: "/api/software/desktop/check?arch=x64", range: "bytes=1-", ifMatch: '"digest"' });
    await assert.rejects(() => transport.request({ method: "GET", path: "/api/software/desktop/redirect" }));
    assert.equal(calls, 3);
    for (const invalid of ["https://other.invalid/api/software/desktop/check", "//other.invalid/check", "/api/software/desktop/../elsewhere"]) {
      await assert.rejects(() => transport.request({ method: "GET", path: invalid }));
    }
    assert.equal(calls, 3);
    assert.throws(() => createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: "http://public.invalid" }));
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(() => transport.request({ method: "GET", path: "/api/software/desktop/check", signal: cancelled.signal }));
    assert.equal(calls, 3);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("registration reads the current shell platform at request time and rejects unsupported pairs before signing or HTTP", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-platform-boundary-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  let calls = 0;
  const registrations: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    registrations.push(JSON.parse(body.toString("utf8")));
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId, method: request.method!,
      url: request.url!, body, requestId: String(request.headers["x-codeflow-request-id"]), timestamp: Number(request.headers["x-codeflow-timestamp"]) }),
    String(request.headers["x-codeflow-signature"]));
    response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId,
      publicKeySha256: crypto.createHash("sha256").update(Buffer.from(identity.publicKeyBase64, "base64")).digest("hex") }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const configuredServerOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const validTransport = createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin });
    for (const [platform, arch] of [["win32", "x64"], ["darwin", "x64"], ["darwin", "arm64"]]) {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
      Object.defineProperty(process, "arch", { ...originalArch, value: arch });
      await validTransport.register();
      assert.deepEqual(registrations.at(-1), { deviceId: identity.deviceId, publicKeyBase64: identity.publicKeyBase64, platform, arch,
        shellVersion: "unknown", webVersion: "unknown", clientVersion: "unknown", releaseId: "unknown" });
    }
    for (const [platform, arch] of [["linux", "x64"], ["win32", "arm64"], ["darwin", "ia32"]]) {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
      Object.defineProperty(process, "arch", { ...originalArch, value: arch });
      const transport = createDesktopUpdateTransport({ dataDir: path.join(dataDir, "missing-identity"), identity, configuredServerOrigin });
      await assert.rejects(() => transport.register(), { code: "DESKTOP_DEVICE_AUTH_INVALID" });
    }
    assert.equal(calls, 3);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    Object.defineProperty(process, "arch", originalArch);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("JSON business rejection, wrong registration acknowledgement and timeout never become success", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-errors-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const server = http.createServer((req, res) => {
    if (req.url === "/api/software/desktop/hang") return;
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/software/desktop/malformed") { res.end("private-response-fragment"); return; }
    if (req.url === "/api/software/desktop/devices/register") res.end(JSON.stringify({ ok: true, deviceId: "00000000-0000-4000-8000-000000000000",
      publicKeySha256: crypto.createHash("sha256").update(Buffer.from(identity.publicKeyBase64, "base64")).digest("hex") }));
    else res.end(JSON.stringify({ ok: false, code: "CONFLICT", message: "receipt conflict" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const transport = createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, timeoutMs: 100 });
    await assert.rejects(() => transport.register({ requestId: "review-register-ack" }),
      { code: "DESKTOP_DEVICE_REGISTRATION_ACK_INVALID", requestId: "review-register-ack" });
    await assert.rejects(() => transport.requestJson({ method: "POST", path: "/api/software/desktop/receipts", body: { attemptId: "attempt-1" } }), { code: "CONFLICT" });
    await assert.rejects(() => transport.requestJson({ method: "GET", path: "/api/software/desktop/malformed", requestId: "malformed-response" }), (error: any) => {
      assert.equal(error.code, "DESKTOP_UPDATE_RESPONSE_INVALID");
      assert.equal(error.requestId, "malformed-response");
      assert.doesNotMatch(String(error) + String(error.cause), /private-response-fragment/u);
      return true;
    });
    await assert.rejects(() => transport.request({ method: "GET", path: "/api/software/desktop/hang", requestId: "timeout-request" }), { requestId: "timeout-request" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("invalid JSON response shape retains its request identifier and fixed error code", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-json-shape-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ unknown: true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const transport = createDesktopUpdateTransport({ dataDir, identity,
      configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    await assert.rejects(() => transport.requestJson({ method: "GET", path: "/api/software/desktop/check", requestId: "review-invalid-json" }),
      { code: "DESKTOP_UPDATE_RESPONSE_INVALID", requestId: "review-invalid-json" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("HTTP failure retains structured diagnostics without remote message text", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-private-error-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const server = http.createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, code: "DESKTOP_UPDATE_UNAVAILABLE", message: "Bearer PRIVATE_TOKEN 中文私密正文" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const transport = createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  await assert.rejects(() => transport.request({ method: "GET", path: "/api/software/desktop/check", requestId: "private-http-error" }), (error: any) => {
    assert.equal(error.message, "DESKTOP_UPDATE_HTTP_FAILED");
    assert.equal(error.code, "DESKTOP_UPDATE_UNAVAILABLE");
    assert.equal(error.status, 503);
    assert.equal(error.requestId, "private-http-error");
    assert.doesNotMatch(String(error) + String(error.cause), /PRIVATE_TOKEN|私密正文/u);
    return true;
  });
});

test("HTTP failures retain raw Retry-After across error bodies without retrying or leaking response text", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-retry-after-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const cases = [429, 503].flatMap(status => ["60", "Wed, 21 Oct 2037 07:28:00 GMT", null, "invalid-delay-token"].flatMap(retryAfter =>
    ["json", "non-json", "empty", "interrupted"].map(body => ({ status, retryAfter, body }))));
  const requests: { path: string; requestId: string }[] = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url!, requestId: String(request.headers["x-codeflow-request-id"]) });
    if (request.url === "/api/software/desktop/business-rejection") {
      response.writeHead(200, { "content-type": "application/json", "retry-after": "60" });
      response.end(JSON.stringify({ ok: false, code: "CONFLICT", message: "PRIVATE_TOKEN" })); return;
    }
    const fixture = cases[Number(request.url!.split("/").at(-1))];
    response.setHeader("content-type", "application/json");
    if (fixture.retryAfter !== null) response.setHeader("retry-after", fixture.retryAfter);
    response.writeHead(fixture.status);
    if (fixture.body === "interrupted") {
      response.write('{"message":"Bearer PRIVATE_TOKEN 中文私密正文');
      setTimeout(() => response.destroy(), 30); return;
    }
    response.end(fixture.body === "json" ? JSON.stringify({ ok: false,
      code: fixture.status === 429 ? "DESKTOP_UPDATE_THROTTLED" : "DESKTOP_UPDATE_UNAVAILABLE",
      requestId: "remote-forged-request-id", message: "Bearer PRIVATE_TOKEN 中文私密正文" })
      : fixture.body === "non-json" ? "Bearer PRIVATE_TOKEN 中文私密正文" : "");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const transport = createDesktopUpdateTransport({ dataDir, identity,
      configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    for (const [index, fixture] of cases.entries()) {
      await t.test(`${fixture.status} ${fixture.retryAfter ?? "missing"} ${fixture.body}`, async () => {
        const requestPath = `/api/software/desktop/retry-after/${index}`;
        const requestId = index % 2 === 0 ? `retry-after-${index}` : undefined;
        const previousCalls = requests.length;
        await assert.rejects(() => transport.request({ method: "GET", path: requestPath, requestId }), (error: any) => {
          assert.equal(error.message, "DESKTOP_UPDATE_HTTP_FAILED");
          assert.equal(error.code, fixture.body === "json"
            ? fixture.status === 429 ? "DESKTOP_UPDATE_THROTTLED" : "DESKTOP_UPDATE_UNAVAILABLE" : "DESKTOP_UPDATE_HTTP_FAILED");
          assert.equal(error.status, fixture.status);
          assert.equal(error.requestId, requests.at(-1)!.requestId);
          assert.ok(error.requestId);
          if (requestId) assert.equal(error.requestId, requestId);
          assert.equal(error.retryAfter, fixture.retryAfter);
          if (fixture.body === "interrupted") {
            assert.ok(error.cause instanceof TypeError);
            assert.equal(error.cause.cause?.code, "UND_ERR_SOCKET");
          } else if (fixture.body !== "json") assert.equal(error.cause?.message, "DESKTOP_UPDATE_RESPONSE_INVALID");
          assert.doesNotMatch(String(error) + String(error.cause) + JSON.stringify(error), /PRIVATE_TOKEN|私密正文|remote-forged-request-id/u);
          return true;
        });
        assert.equal(requests.length, previousCalls + 1);
        assert.equal(requests.at(-1)!.path, requestPath);
      });
    }
    await t.test("HTTP 200 business rejection has no HTTP failure metadata", async () => {
      const previousCalls = requests.length;
      await assert.rejects(() => transport.requestJson({ method: "POST", path: "/api/software/desktop/business-rejection",
        requestId: "business-rejection" }), (error: any) => {
        assert.equal(error.code, "CONFLICT");
        assert.equal(error.requestId, requests.at(-1)!.requestId);
        assert.equal(error.requestId, "business-rejection");
        assert.equal(Object.hasOwn(error, "status"), false);
        assert.equal(Object.hasOwn(error, "retryAfter"), false);
        assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE_TOKEN/u);
        return true;
      });
      assert.equal(requests.length, previousCalls + 1);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("remote error codes require a bounded token shape", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-code-boundary-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const tooLong = "A".repeat(129);
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/too-long")) {
      response.writeHead(503); response.end(JSON.stringify({ ok: false, code: tooLong })); return;
    }
    if (request.url?.endsWith("/with-space")) {
      response.end(JSON.stringify({ ok: false, code: "BAD CODE" })); return;
    }
    response.writeHead(503); response.end(JSON.stringify({ ok: false, code: "BAD CODE" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const transport = createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  await assert.rejects(() => transport.request({ method: "GET", path: "/api/software/desktop/too-long", requestId: "too-long-code" }),
    { code: "DESKTOP_UPDATE_HTTP_FAILED", requestId: "too-long-code" });
  await assert.rejects(() => transport.requestJson({ method: "GET", path: "/api/software/desktop/with-space", requestId: "space-code" }),
    { code: "DESKTOP_UPDATE_REQUEST_FAILED", requestId: "space-code" });
  await assert.rejects(() => transport.register({ requestId: "register-code" }),
    { code: "DESKTOP_UPDATE_HTTP_FAILED", requestId: "register-code" });
});

/** 测试内构造临时自签证书，不依赖 OpenSSL、系统证书库或持久密钥文件。 */
function temporaryTlsCertificate() {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  /** 只编码本测试固定证书字段的 DER TLV。 */
  const der = (tag: number, ...values: Buffer[]): Buffer => {
    const bytes = Buffer.concat(values);
    const hex = bytes.length.toString(16).padStart(bytes.length > 255 ? 4 : 2, "0");
    const length = bytes.length < 128 ? Buffer.from([bytes.length]) : Buffer.concat([Buffer.from([0x80 | hex.length / 2]), Buffer.from(hex, "hex")]);
    return Buffer.concat([Buffer.from([tag]), length, bytes]);
  };
  const algorithm = Buffer.from("300d06092a864886f70d01010b0500", "hex");
  const name = der(0x30, der(0x31, der(0x30, Buffer.from("0603550403", "hex"), der(0x0c, Buffer.from("localhost")))));
  const validity = der(0x30, der(0x17, Buffer.from("250101000000Z")), der(0x17, Buffer.from("350101000000Z")));
  const tbs = der(0x30, der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algorithm, name, validity, name,
    pair.publicKey.export({ format: "der", type: "spki" }));
  const certificate = der(0x30, tbs, algorithm, der(0x03, Buffer.from([0]), crypto.sign("sha256", tbs, pair.privateKey)));
  return { key: pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/gu)!.join("\n")}\n-----END CERTIFICATE-----\n` };
}

test("real HTTPS rejects an untrusted self-signed certificate before sending signed HTTP data", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-tls-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  let requests = 0;
  const server = https.createServer(temporaryTlsCertificate(), (_req, res) => { requests++; res.end("unexpected"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const transport = createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: `https://127.0.0.1:${(server.address() as { port: number }).port}` });
    await assert.rejects(() => transport.register(), (error: any) => error.cause?.cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
    assert.equal(requests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("network context surrounds the complete signed JSON action without nesting request retry", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-network-context-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  let calls = 0, runs = 0;
  const requestIds: string[] = [];
  const server = http.createServer((request, response) => {
    calls++;
    requestIds.push(String(request.headers["x-codeflow-request-id"]));
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId,
      method: request.method!, url: request.url!, body: Buffer.alloc(0), requestId: requestIds.at(-1)!,
      timestamp: Number(request.headers["x-codeflow-timestamp"]) }), String(request.headers["x-codeflow-signature"]));
    response.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) { response.write('{"ok":'); setTimeout(() => response.destroy(), 20); }
    else response.end(JSON.stringify({ ok: true, value: "complete" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true }); });
  const signal = new AbortController().signal;
  const retry = {
    /** 只替换重试调度，真实 JSON 读取必须属于同一个完整动作。 */
    async run<T>(operation: () => Promise<T>): Promise<T> {
      runs++;
      assert.equal(runs, 1);
      await assert.rejects(operation, { code: "DESKTOP_UPDATE_RESPONSE_INVALID" });
      return await operation();
    },
  };
  const transport = createDesktopUpdateTransport({ dataDir, identity,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    getNetworkContext: () => ({ signal, retry }) });
  assert.deepEqual(await transport.requestJson({ method: "GET", path: "/api/software/desktop/check", requestId: "complete-json-attempt" }),
    { ok: true, value: "complete" });
  assert.equal(runs, 1);
  assert.equal(calls, 2);
  assert.deepEqual(requestIds, ["complete-json-attempt", "complete-json-attempt"]);
});

test("real signed registration, JSON read and raw requests share one three-retry budget", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-shared-budget-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const attempts = new Map<string, number>();
  const retries: Array<{ retry: number; delayMs: number; error: unknown }> = [];
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry: event => { retries.push(event); } });
  const signal = new AbortController().signal;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const requestId = String(request.headers["x-codeflow-request-id"]);
    const path = request.url!;
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId,
      method: request.method!, url: path, body, requestId, timestamp: Number(request.headers["x-codeflow-timestamp"]) }),
    String(request.headers["x-codeflow-signature"]));
    const call = (attempts.get(path) ?? 0) + 1; attempts.set(path, call);
    response.setHeader("content-type", "application/json");
    if (path.endsWith("/register")) {
      assert.equal(requestId, "register-round");
      if (call === 1) { response.writeHead(503, { "retry-after": "0" }); response.end("{}"); }
      else response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId,
        publicKeySha256: crypto.createHash("sha256").update(Buffer.from(identity.publicKeyBase64, "base64")).digest("hex") }));
    } else if (path.endsWith("/json")) {
      assert.equal(requestId, "json-round");
      if (call === 1) { response.write('{"ok":'); setTimeout(() => response.destroy(), 20); }
      else response.end(JSON.stringify({ ok: true }));
    } else {
      assert.equal(requestId, "raw-round");
      response.writeHead(502, { "retry-after": "0" }); response.end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true }); });
  const transport = createDesktopUpdateTransport({ dataDir, identity,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, getNetworkContext: () => ({ signal, retry }) });
  await transport.register({ requestId: "register-round" });
  assert.deepEqual(await transport.requestJson({ method: "GET", path: "/api/software/desktop/json", requestId: "json-round" }), { ok: true });
  await assert.rejects(() => transport.request({ method: "GET", path: "/api/software/desktop/raw", requestId: "raw-round" }),
    { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 502, requestId: "raw-round" });
  assert.deepEqual([...attempts.values()], [2, 2, 2]);
  assert.deepEqual(retries.map(event => [event.retry, event.delayMs]), [[1, 0], [2, 2000], [3, 0]]);
  assert.deepEqual(retries.map(event => (event.error as { requestId: string }).requestId), ["register-round", "json-round", "raw-round"]);
});

test("HTTP 503 业务错误保留错误码并按传输预算重试", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-business-retry-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const requests: string[] = [];
  let retries = 0;
  const signal = new AbortController().signal;
  const retry = createUpdateNetworkRetry({ signal, onRetry: event => {
    retries++;
    assert.equal((event.error as { code: string }).code, "DESKTOP_UPDATE_UNAVAILABLE");
  } });
  const server = http.createServer((request, response) => {
    requests.push(String(request.headers["x-codeflow-request-id"]));
    if (requests.length === 1) {
      response.writeHead(503, { "retry-after": "0" });
      response.end(JSON.stringify({ ok: false, code: "DESKTOP_UPDATE_UNAVAILABLE" }));
    } else response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const transport = createDesktopUpdateTransport({ dataDir, identity,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, getNetworkContext: () => ({ signal, retry }) });
  assert.deepEqual(await transport.requestJson({ method: "GET", path: "/api/software/desktop/check", requestId: "same-retry-request" }), { ok: true });
  assert.deepEqual(requests, ["same-retry-request", "same-retry-request"]);
  assert.equal(retries, 1);
});

test("network context never retries explicit business failure, invalid JSON or registration acknowledgement", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-strict-retry-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  let requests = 0, retries = 0;
  const signal = new AbortController().signal;
  const retry = createUpdateNetworkRetry({ signal, onRetry: () => { retries++; } });
  const server = http.createServer((request, response) => {
    requests++; response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/business")) response.end(JSON.stringify({ ok: false, code: "DESKTOP_UPDATE_UNAVAILABLE" }));
    else if (request.url?.endsWith("/json")) response.end("malformed");
    else response.end(JSON.stringify({ ok: true, deviceId: "wrong", publicKeySha256: "wrong" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true }); });
  const transport = createDesktopUpdateTransport({ dataDir, identity,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, getNetworkContext: () => ({ signal, retry }) });
  await assert.rejects(() => transport.requestJson({ method: "GET", path: "/api/software/desktop/business" }), { code: "DESKTOP_UPDATE_UNAVAILABLE" });
  await assert.rejects(() => transport.requestJson({ method: "GET", path: "/api/software/desktop/json" }), { code: "DESKTOP_UPDATE_RESPONSE_INVALID" });
  await assert.rejects(() => transport.register(), { code: "DESKTOP_DEVICE_REGISTRATION_ACK_INVALID" });
  assert.equal(requests, 3); assert.equal(retries, 0);
});

test("cancelling a JSON body through the network context preserves its exact round reason", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-body-cancel-"));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const abort = new AbortController();
  const reason = new Error("round exit");
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let retries = 0;
  const retry = createUpdateNetworkRetry({ signal: abort.signal, onRetry: () => { retries++; } });
  const server = http.createServer((_request, response) => { response.writeHead(200); response.write('{"ok":'); started(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true }); });
  const transport = createDesktopUpdateTransport({ dataDir, identity,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    getNetworkContext: () => ({ signal: abort.signal, retry }) });
  const pending = transport.requestJson({ method: "GET", path: "/api/software/desktop/json", requestId: "cancel-json" });
  await ready; await new Promise<void>(resolve => setImmediate(resolve)); abort.abort(reason);
  await assert.rejects(pending, (error: any) => error === reason || error.cause === reason);
  assert.equal(retries, 0);
});

test("native AbortError translation keeps the round reason and never replaces aggregate cleanup failures", async t => {
  for (const phase of ["fetch", "json", "aggregate"]) await t.test(phase, async subtest => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-transport-native-abort-"));
    const identity = await loadOrCreateDeviceIdentity(dataDir);
    const abort = new AbortController();
    const reason = new Error("round exit");
    const failure = phase === "aggregate" ? new AggregateError([new DOMException("aborted", "AbortError"), new Error("cleanup failed")])
      : new DOMException("aborted", "AbortError");
    subtest.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    subtest.mock.method(globalThis, "fetch", async () => {
      if (phase !== "json") { abort.abort(reason); throw failure; }
      const response = new Response('{"ok":true}');
      subtest.mock.method(response, "json", async () => { abort.abort(reason); throw failure; });
      return response;
    });
    const retry = createUpdateNetworkRetry({ signal: abort.signal, onRetry: () => { assert.fail("unexpected retry"); } });
    const transport = createDesktopUpdateTransport({ dataDir, identity, configuredServerOrigin: "http://127.0.0.1:39499",
      getNetworkContext: () => ({ signal: abort.signal, retry }) });
    await assert.rejects(() => transport.requestJson({ method: "GET", path: "/api/software/desktop/json" }), (error: any) =>
      error.cause === (phase === "aggregate" ? failure : reason));
  });
});
