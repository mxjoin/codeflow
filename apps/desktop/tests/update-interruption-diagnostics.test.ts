import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDesktopDevicePayload, desktopDevicePublicKeySha256, readDesktopDeviceHeaders, verifyDesktopDeviceSignature } from "@codeflowai/shared/desktop-device-auth";
import { signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { assertDesktopUpdateFailureRecord, type DesktopUpdateFailureRecord } from "@codeflowai/shared/desktop-update-failure";
import type { ClientRuntime } from "../src/clientRuntime.js";
import { createDesktopApplication, type DesktopHost } from "../src/desktopApplication.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { readActivePointer } from "../src/releaseBundleCoordinator.js";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
import { createUpdateReceiptJournal } from "../src/updateReceiptJournal.js";

const privateBody = "PRIVATE_D11_PARTIAL_BODY";

/** 使用真实签名、HTTP 和日志，仅替换窗口与 Client，不创建有效更新包。 */
async function fixture(t: test.TestContext, phase: "discovery" | "download", badAck: "lost" | "mismatch") {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-interruption-diagnostics-"));
  let application: ReturnType<typeof createDesktopApplication> | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  // 先结算宿主与连接，再删临时数据；任一清理失败均交给测试报告。
  t.after(async () => {
    const resources = await Promise.allSettled([application?.exit(), closeServer?.()]);
    const files = await Promise.allSettled([fs.rm(dataDir, { recursive: true, force: true })]);
    const failures = [...resources, ...files].filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "D11_FIXTURE_CLEANUP_FAILED");
  });
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "interrupted-release", version: "2.0.0",
    webVersion: "2.0.0", clientVersion: "2.0.0", protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 88,
    platform: process.platform as "win32" | "darwin", arch: process.arch as "x64" | "arm64", keyId: "fixture",
    archiveSha256: "a".repeat(64), archiveSize: 4096, webSha256: "b".repeat(64), clientSha256: "c".repeat(64), packageSha256: "d".repeat(64),
    files: [{ path: "client/dist/index.cjs", size: 6, sha256: "e".repeat(64) }, { path: "web/index.html", size: 3, sha256: "f".repeat(64) }],
    createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2099-10-24T00:00:00.000Z" }, privateKey);
  const routes: string[] = [], uploads: Buffer[] = [], handlerFailures: unknown[] = [];
  const handlers = new Set<Promise<void>>();
  /** 受控截断和坏 ACK 只改变远端传输；每个请求仍校验实际签名字节。 */
  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), metadata = readDesktopDeviceHeaders(request.rawHeaders);
    assert.equal(metadata.deviceId, identity.deviceId);
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ ...metadata,
      method: request.method!, url: request.url!, body: bytes }), metadata.signature);
    routes.push(request.url!);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/software/desktop/devices/register") {
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
    } else if (request.url === "/api/software/desktop/release" && phase === "download") {
      response.end(JSON.stringify(manifest));
    } else if (request.url === (phase === "discovery" ? "/api/software/desktop/release" : "/api/software/desktop/releases/interrupted-release/archive")) {
      response.writeHead(200, { "content-length": 4096, connection: "close", ...(phase === "download"
        ? { "content-type": "application/octet-stream", etag: `"${manifest.archiveSha256}"` } : {}) });
      response.end(privateBody);
    } else {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/software/desktop/update-failures");
      const record: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      assertDesktopUpdateFailureRecord(record);
      assert.equal(metadata.requestId, record.errorId);
      uploads.push(bytes);
      if (uploads.length === 1 && badAck === "lost") { response.destroy(); return; }
      response.end(JSON.stringify({ ok: true, deviceId: record.deviceId, errorId: record.errorId,
        payloadSha256: uploads.length === 1 ? "0".repeat(64) : record.payloadSha256 }));
    }
  };
  const server = http.createServer((request, response) => {
    const task = handle(request, response);
    handlers.add(task);
    void task.then(() => handlers.delete(task), cause => {
      handlerFailures.push(cause); handlers.delete(task); response.destroy();
    });
  });
  closeServer = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all(handlers);
    assert.deepEqual(handlerFailures, []);
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const actions: string[] = [];
  const runtime: ClientRuntime = {
    start: async () => { actions.push("start"); }, waitReady: async () => { actions.push("ready"); },
    stop: async () => { actions.push("stop"); }, drain: async () => { actions.push("drain"); },
    request: async () => { assert.fail("failed download must not control Client sessions"); },
    onEvent: () => () => {},
    snapshot: () => ({ status: "ready", requestId: null, releaseId: null, errorCode: null, pid: 123,
      health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } }),
  };
  const window = Object.assign(new EventEmitter(), { show() {}, focus() {}, hide() {}, destroy() {} });
  const host: DesktopHost = { createWindow: () => window, loadWeb: async () => {}, createTray: () => ({ destroy() {} }),
    registerBridge: () => () => {}, quit() {} };
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const app = createDesktopApplication({ dataDir, initialReleaseDir: dataDir, host, shellVersion: "1.0.0",
    configuredServerOrigin: `http://127.0.0.1:${address.port}`, trustedReleaseKeys: { fixture: publicKey }, createRuntime: () => runtime });
  application = app;
  await app.start();
  actions.length = 0;
  return { app, dataDir, identity, actions, routes, uploads };
}

for (const phase of ["discovery", "download"] as const) for (const badAck of ["lost", "mismatch"] as const) {
  test(`${phase} body interruption keeps durable diagnostics and replays exact evidence after ${badAck} ACK`, { timeout: 12_000 }, async t => {
    const f = await fixture(t, phase, badAck), requestId = crypto.randomUUID();
    const code = phase === "discovery" ? "DESKTOP_RELEASE_DISCOVERY_FAILED" : "DESKTOP_RELEASE_DOWNLOAD_FAILED";
    await assert.rejects(() => f.app.downloadAvailableReleaseBundle({ requestId }), error => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, code);
      assert.equal((error as Error & { requestId: string }).requestId, requestId);
      assert.ok(error.cause instanceof TypeError, "response headers must arrive before the body read fails");
      assert.doesNotMatch(error.message, /PRIVATE_/u);
      return true;
    });
    assert.deepEqual(f.actions, []);
    assert.equal((await f.app.getUpdateState()).operation, "idle");
    assert.equal(await readActivePointer(f.dataDir), null);
    assert.deepEqual(await createUpdateReceiptJournal(f.dataDir).pending(f.identity.deviceId), []);
    assert.deepEqual(f.routes.filter(route => route !== "/api/software/desktop/devices/register"),
      ["/api/software/desktop/release", ...(phase === "download" ? ["/api/software/desktop/releases/interrupted-release/archive"] : [])]);
    assert.ok(f.routes.some(route => route === "/api/software/desktop/devices/register"));
    const history = await f.app.getUpdateDiagnostics();
    assert.equal(history.deviceId, f.identity.deviceId);
    assert.equal(history.failures.length, 1);
    const entry = history.failures[0]!;
    assert.equal(entry.reported, false);
    const record = entry.record;
    assert.equal(record.errorCode, "DESKTOP_RELEASE_FAILED");
    assert.equal(record.requestId, requestId);
    assert.equal(record.phase, phase);
    assert.ok("releaseId" in record);
    assert.equal(record.releaseId, phase === "discovery" ? "unknown" : "interrupted-release");
    assert.equal(record.currentReleaseId, "installation");
    assert.equal(record.shellVersion, "1.0.0");
    assert.equal(record.webVersion, "1.0.0");
    assert.equal(record.clientVersion, "1.0.0");
    assert.equal(record.recovery, "not_needed");
    assert.equal(record.rootCause.code, code);
    const journalPath = path.join(f.dataDir, "errors.jsonl"), before = await fs.readFile(journalPath);
    assert.doesNotMatch(before.toString("utf8"), /PRIVATE_D11_PARTIAL_BODY|stack|signature|publicKey/u);
    assert.deepEqual(createUpdateFailureJournal(f.dataDir).pending(f.identity.deviceId), [record]);
    await assert.rejects(() => f.app.flushFailures(), { code: badAck === "lost"
      ? "DESKTOP_UPDATE_TRANSPORT_FAILED" : "DESKTOP_UPDATE_FAILURE_ACK_INVALID", requestId });
    assert.deepEqual(await fs.readFile(journalPath), before);
    assert.deepEqual(await f.app.getUpdateDiagnostics(), history);
    assert.deepEqual(createUpdateFailureJournal(f.dataDir).pending(f.identity.deviceId), [record]);
    await f.app.flushFailures();
    assert.equal(f.uploads.length, 2);
    assert.deepEqual(f.uploads[0], f.uploads[1]);
    const uploaded: DesktopUpdateFailureRecord = JSON.parse(f.uploads[0]!.toString("utf8"));
    assert.deepEqual(uploaded, record);
    assert.doesNotMatch(f.uploads[0]!.toString("utf8"), /PRIVATE_D11_PARTIAL_BODY|stack|signature|publicKey/u);
    assert.deepEqual(createUpdateFailureJournal(f.dataDir).pending(f.identity.deviceId), []);
    assert.deepEqual(await f.app.getUpdateDiagnostics(), { deviceId: f.identity.deviceId, failures: [{ record, reported: true }] });
    const requests = f.routes.length;
    await f.app.flushFailures();
    assert.equal(f.routes.length, requests);
    assert.deepEqual(f.actions, []);
  });
}
