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
import { assertDesktopUpdateReceipt, type DesktopUpdateReceipt } from "@codeflowai/shared/desktop-update-receipt";
import type { ClientRuntime } from "../src/clientRuntime.js";
import { createDesktopApplication, type DesktopHost } from "../src/desktopApplication.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { readActivePointer } from "../src/releaseBundleCoordinator.js";
import { createUpdateReceiptJournal } from "../src/updateReceiptJournal.js";

type IdentityFault = "missing" | "invalid-json" | "same-device-new-key" | "different-device";
type Boundary = "before-register" | "before-receipt";

/** 只在本测试身份文件注入故障，下载、签名、回执和 HTTP 使用真实入口。 */
async function fixture(t: test.TestContext, fault: IdentityFault, boundary: Boundary) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipt-identity-"));
  const dataDir = path.join(root, "profile"), identityPath = path.join(dataDir, "device-identity.json");
  let application: ReturnType<typeof createDesktopApplication> | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  // 先关闭真实资源再回收本片目录，所有清理原因均交给测试结果。
  t.after(async () => {
    const resources = await Promise.allSettled([application?.exit(), closeServer?.()]);
    const files = await Promise.allSettled([fs.rm(root, { recursive: true, force: true })]);
    const failures = [...resources, ...files].filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "D10_IDENTITY_FIXTURE_CLEANUP_FAILED");
  });
  const identity = await loadOrCreateDeviceIdentity(dataDir), originalIdentity = await fs.readFile(identityPath);
  let changedIdentity: Buffer | undefined;
  if (fault === "invalid-json") changedIdentity = Buffer.from('{"PRIVATE_D10_INVALID_IDENTITY":', "utf8");
  else if (fault === "same-device-new-key" || fault === "different-device") {
    const replacementDir = path.join(root, "replacement");
    const replacement = await loadOrCreateDeviceIdentity(replacementDir);
    assert.notEqual(replacement.publicKeyBase64, identity.publicKeyBase64);
    // 分别改变设备或密钥，避免其中一个检查掩盖另一个检查缺失。
    const stored = JSON.parse(fault === "same-device-new-key"
      ? await fs.readFile(path.join(replacementDir, "device-identity.json"), "utf8") : originalIdentity.toString("utf8"));
    stored.deviceId = fault === "same-device-new-key" ? identity.deviceId : replacement.deviceId;
    changedIdentity = Buffer.from(JSON.stringify(stored), "utf8");
  }
  const archive = Buffer.alloc(8192, 97), digest = crypto.createHash("sha256").update(archive).digest("hex");
  const keys = crypto.generateKeyPairSync("ed25519");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "identity-release", version: "2.0.0",
    webVersion: "2.0.0", clientVersion: "2.0.0", protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 88,
    platform: process.platform as "win32" | "darwin", arch: process.arch as "x64" | "arm64", keyId: "fixture",
    archiveSha256: digest, archiveSize: archive.length, webSha256: "b".repeat(64), clientSha256: "c".repeat(64), packageSha256: "d".repeat(64),
    files: [{ path: "client/dist/index.cjs", size: 6, sha256: "e".repeat(64) }, { path: "web/index.html", size: 3, sha256: "f".repeat(64) }],
    createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2099-10-24T00:00:00.000Z" }, keys.privateKey);
  const routes: string[] = [], receipts: DesktopUpdateReceipt[] = [], failures: unknown[] = [];
  const handlers = new Set<Promise<void>>();
  let operationRegistrations = 0, injected = false;
  /** 故障只发生一次；恢复由测试显式写回原字节，不调用身份创建入口。 */
  const changeIdentity = async (): Promise<void> => {
    assert.equal(injected, false); injected = true;
    if (fault === "missing") await fs.unlink(identityPath);
    else await fs.writeFile(identityPath, changedIdentity!);
  };
  /** 先登记实际到达，再核签名；任何非法发送都不能被隐藏为零请求。 */
  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    routes.push(request.url!);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), metadata = readDesktopDeviceHeaders(request.rawHeaders);
    assert.equal(metadata.deviceId, identity.deviceId);
    verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ ...metadata,
      method: request.method!, url: request.url!, body: bytes }), metadata.signature);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/software/desktop/devices/register") {
      // 设备心跳与业务登记共用接口；只按非心跳登记计数，避免后台心跳改变注入时点。
      if (!String(metadata.requestId).startsWith("device-presence:")) operationRegistrations++;
      if (!injected && boundary === "before-receipt" && operationRegistrations === 2) await changeIdentity();
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
    } else if (request.url === "/api/software/desktop/release") response.end(JSON.stringify(manifest));
    else if (request.url === "/api/software/desktop/releases/identity-release/archive") {
      if (!injected && boundary === "before-register") await changeIdentity();
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length, etag: `"${digest}"` });
      response.end(archive);
    } else {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/software/desktop/update-receipts");
      const receipt: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      assertDesktopUpdateReceipt(receipt);
      assert.equal(metadata.requestId, receipt.requestId);
      receipts.push(receipt);
      response.end(JSON.stringify({ ok: true, deviceId: receipt.deviceId, requestId: receipt.requestId, releaseId: receipt.releaseId,
        archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256 }));
    }
  };
  const server = http.createServer((request, response) => {
    const task = handle(request, response); handlers.add(task);
    void task.then(() => handlers.delete(task), cause => { failures.push(cause); handlers.delete(task); response.destroy(); });
  });
  closeServer = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all(handlers); assert.deepEqual(failures, []);
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const actions: string[] = [];
  const runtime: ClientRuntime = {
    start: async () => { actions.push("start"); }, waitReady: async () => { actions.push("ready"); },
    stop: async () => { actions.push("stop"); }, drain: async () => { actions.push("drain"); },
    request: async () => { assert.fail("download and receipt delivery must not control sessions"); }, onEvent: () => () => {},
    snapshot: () => ({ status: "ready", requestId: null, releaseId: null, errorCode: null, pid: 123,
      health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } }),
  };
  const window = Object.assign(new EventEmitter(), { show() {}, focus() {}, hide() {}, destroy() {} });
  const host: DesktopHost = { createWindow: () => window, loadWeb: async () => {}, createTray: () => ({ destroy() {} }),
    registerBridge: () => () => {}, quit() {} };
  const address = server.address(); assert.ok(address && typeof address === "object");
  const app = createDesktopApplication({ dataDir, initialReleaseDir: dataDir, host, createRuntime: () => runtime,
    configuredServerOrigin: `http://127.0.0.1:${address.port}`, trustedReleaseKeys: { fixture: keys.publicKey } });
  application = app; await app.start(); actions.length = 0;
  return { app, dataDir, identityPath, originalIdentity, changedIdentity, identity, archive, digest, routes, receipts, actions,
    directory: path.join(dataDir, ".staging", `download-${crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`) };
}

for (const boundary of ["before-register", "before-receipt"] as const) {
  for (const fault of ["missing", "invalid-json", "same-device-new-key", "different-device"] as const) {
    test(`received remains pending when identity is ${fault} ${boundary} and resumes only with the original identity`, { timeout: 12_000 }, async t => {
      const f = await fixture(t, fault, boundary), requestId = crypto.randomUUID();
      await f.app.downloadAvailableReleaseBundle({ requestId });
      await assert.rejects(() => f.app.flushReceipts(), error => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code: string }).code, "DESKTOP_UPDATE_RECEIPT_SEND_FAILED");
        assert.equal((error as Error & { requestId: string }).requestId, requestId);
        assert.ok(error.cause instanceof Error);
        const identityFailure = error.cause;
        if (fault === "invalid-json") {
          assert.ok(identityFailure.cause instanceof Error);
          assert.equal(identityFailure.cause.message, "DESKTOP_DEVICE_IDENTITY_JSON_INVALID");
        } else assert.equal(identityFailure.message, fault === "missing" ? "DESKTOP_DEVICE_IDENTITY_MISSING" : "DESKTOP_DEVICE_IDENTITY_CHANGED");
        return true;
      });
      assert.deepEqual(f.routes.filter(route => route !== "/api/software/desktop/devices/register"),
        ["/api/software/desktop/release", "/api/software/desktop/releases/identity-release/archive"]);
      assert.ok(f.routes.some(route => route === "/api/software/desktop/devices/register"));
      assert.deepEqual(f.receipts, []);
      if (fault === "missing") await assert.rejects(() => fs.access(f.identityPath), { code: "ENOENT" });
      else assert.ok((await fs.readFile(f.identityPath)).equals(f.changedIdentity!), "failed signing must preserve the altered identity bytes");
      assert.deepEqual(f.actions, []);
      assert.equal((await f.app.getUpdateState()).operation, "idle");
      assert.equal(await readActivePointer(f.dataDir), null);
      const directory = f.directory;
      assert.deepEqual(await fs.readFile(path.join(directory, "bundle.tar.gz")), f.archive);
      assert.deepEqual(await fs.readdir(directory), ["bundle.tar.gz", "manifest.json"]);
      const journal = createUpdateReceiptJournal(f.dataDir), pending = await journal.pending(f.identity.deviceId);
      assert.equal(pending.length, 1);
      const receipt = pending[0]!;
      assert.equal(receipt.stage, "received"); assert.equal(receipt.requestId, requestId);
      assert.equal(receipt.releaseId, "identity-release"); assert.equal(receipt.archiveSha256, f.digest);
      const logPath = path.join(f.dataDir, "update-receipts.jsonl"), before = await fs.readFile(logPath);
      assert.equal(before.toString("utf8").trim().split("\n").length, 1);
      const requestsWhileFaulty = f.routes.length;
      await assert.rejects(() => f.app.flushReceipts(), { code: "DESKTOP_UPDATE_RECEIPT_SEND_FAILED", requestId });
      assert.equal(f.routes.length, requestsWhileFaulty);
      assert.deepEqual(await fs.readFile(logPath), before);
      assert.deepEqual(await createUpdateReceiptJournal(f.dataDir).pending(f.identity.deviceId), [receipt]);
      if (fault === "missing") await assert.rejects(() => fs.access(f.identityPath), { code: "ENOENT" });
      else assert.ok((await fs.readFile(f.identityPath)).equals(f.changedIdentity!), "failed receipt retry must preserve the altered identity bytes");
      await fs.writeFile(f.identityPath, f.originalIdentity);
      const requestsBeforeRecovery = f.routes.length;
      await f.app.flushReceipts();
      assert.deepEqual(f.routes.slice(requestsBeforeRecovery).filter(route => route !== "/api/software/desktop/devices/register"),
        ["/api/software/desktop/update-receipts"]);
      assert.ok(f.routes.slice(requestsBeforeRecovery).some(route => route === "/api/software/desktop/devices/register"));
      assert.deepEqual(f.receipts, [receipt]);
      const reopened = createUpdateReceiptJournal(f.dataDir);
      assert.deepEqual(await reopened.pending(f.identity.deviceId), []);
      assert.deepEqual(await reopened.find(f.identity.deviceId, requestId, "received"), receipt);
      const after = await fs.readFile(logPath);
      assert.deepEqual(after.subarray(0, before.length), before);
      assert.equal(after.toString("utf8").trim().split("\n").length, 2);
      const requests = f.routes.length;
      await f.app.flushReceipts();
      assert.equal(f.routes.length, requests);
      assert.equal(f.routes.filter(route => route.endsWith("/archive")).length, 1);
      assert.ok((await fs.readFile(f.identityPath)).equals(f.originalIdentity), "receipt delivery must preserve the restored identity bytes");
      assert.deepEqual(f.actions, []);
    });
  }
}
