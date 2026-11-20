import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDesktopDevicePayload, desktopDevicePublicKeySha256, verifyDesktopDeviceSignature } from "@codeflowai/shared/desktop-device-auth";
import { signShellReleaseManifest } from "@codeflowai/shared/desktop-shell-release-signing";
import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "../src/deviceIdentity.js";
import { createShellUpdateAttemptNetworkAdapter, createShellUpdateAttemptStore, isShellUpdateHandoffAttempt, type ShellUpdateAttemptStore, type ShellUpdateAttemptV2, type ShellUpdateAttemptV3, type ShellUpdatePreparationAttempt, type ShellUpdateHandoffAttempt } from "../src/shellUpdateAttempt.js";

const implementation = existsSync(fileURLToPath(new URL("../src/shellUpdateNetwork.ts", import.meta.url)))
  ? await import("../src/shellUpdateNetwork.js") : {};
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "cf-d13-shell-discovery-"));
after(() => { process.stdout.write(`D13 shell discovery evidence: ${evidence}\n`); });
type NetworkInput = { store: ShellUpdateAttemptStore; identity: DeviceIdentity; configuredServerOrigin: string;
  currentShellVersion: string;
  trustedKeys: Record<string, crypto.KeyObject | string>; signal: AbortSignal;
  onRetry: (context: { retry: number; delayMs: number; error: unknown }) => void | Promise<void> };
type Result = { status: "no-update" | "target"; attempt: ShellUpdatePreparationAttempt; manifest?: unknown; reason?: "none" | "same" };
type Installed = { installerPath: string; sha256: string; size: number };
type Network = { prepare(): Promise<Result>; readPrepared(): Promise<Installed & { attempt: ShellUpdatePreparationAttempt | ShellUpdateHandoffAttempt; manifest: unknown }>;
  readInstalledPrepared(): Promise<Installed & { attempt: ShellUpdateAttemptV3; manifest: unknown }>;
  downloadInstaller(): Promise<Installed>; authorizeSwitch(): Promise<{ authorized: true; requestId: string; shellId: string }> };

/** 缺少产品入口时产生行为 RED，夹具仍使用真实 signer/store/HTTP。 */
function network(input: NetworkInput): Network {
  const entry = (implementation as Record<string, unknown>).createShellUpdateNetwork;
  assert.equal(typeof entry, "function", "createShellUpdateNetwork must exist");
  return (entry as (value: NetworkInput) => Network)(input);
}

/** 每例独占完整本地事实和真实签名 HTTP；所有资源在例末关闭，失败现场保留。 */
async function fixture(t: test.TestContext, options: { sameShell?: boolean; matchingInstalled?: boolean; available?: boolean; installer?: boolean; requestId?: string; lifecycle?: boolean } = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(evidence, "data-")));
  const identity = await loadOrCreateDeviceIdentity(dataDir), keys = crypto.generateKeyPairSync("ed25519");
  const installer = Buffer.from("synthetic shell installer, never executed\n".repeat(2048));
  const manifest = signShellReleaseManifest({ schemaVersion: 1, protocol: "codeflow-desktop-shell-v1",
    shellId: options.sameShell ? "shell-current" : "shell-next", version: "2.0.0", platform: "win32", arch: "x64",
    installerSha256: options.installer ? crypto.createHash("sha256").update(installer).digest("hex") : "a".repeat(64), installerSize: options.installer ? installer.length : 123, keyId: "test-key",
    files: ["CodeFlowAI.exe", "resources/app.asar", "resources/release-trust.json"].map(name => ({ path: name, size: 1,
      sha256: options.matchingInstalled ? crypto.createHash("sha256").update("x").digest("hex") : "b".repeat(64) })),
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, keys.privateKey);
  const initial: ShellUpdateAttemptV2 = { schemaVersion: 2, requestId: options.requestId ?? `shell:${crypto.randomUUID()}`, revision: 0,
    installationDir: path.join(dataDir, "installation"), dataDir, userDataDir: path.join(dataDir, "user"), sessionDataDir: path.join(dataDir, "session"),
    originalState: { activeShellId: "shell-current", previousShellId: "shell-previous", baselineShellId: "installation" },
    binding: { kind: "active", releaseId: "business-current", packageSha256: "c".repeat(64),
      health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 7, database: "ready" } },
    phase: "preparing", target: null, candidateState: null, retriesUsed: 0, network: null };
  const main = { pid: 41, parentPid: 9, created: 1041, executable: path.join(initial.installationDir, "shells", "shell-current", "CodeFlowAI.exe"), commandLine: "preparation main" };
  const client = { ...main, pid: 42, parentPid: main.pid, created: 1042, commandLine: "preparation client" };
  for (const entry of manifest.files) {
    const file = path.join(initial.installationDir, "shells", initial.originalState.activeShellId, entry.path);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "x");
  }
  const store = createShellUpdateAttemptStore(dataDir);
  if (options.lifecycle) await store.beginPreparation(null, initial, { main, client, readyRequestId: "network-ready", processes: [main, client] });
  else await store.replace(null, initial);
  const calls: Array<{ path: string; timestamp: number; requestId: string; body: unknown; range?: string; ifMatch?: string }> = [], failures: unknown[] = [];
  let respond: ((request: http.IncomingMessage, response: http.ServerResponse) => unknown | Promise<unknown>) | undefined;
  const ack = { ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) };
  const discovery = options.available === false ? { ok: true, available: false, deviceId: identity.deviceId, requestId: initial.requestId }
    : { ok: true, available: true, deviceId: identity.deviceId, requestId: initial.requestId, manifest };
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks), requestId = String(request.headers["x-codeflow-request-id"]), timestamp = Number(request.headers["x-codeflow-timestamp"]);
      verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ deviceId: identity.deviceId,
        method: request.method!, url: request.url!, body: bytes, requestId, timestamp, range: request.headers.range, ifMatch: request.headers["if-match"] }), String(request.headers["x-codeflow-signature"]));
      assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
      calls.push({ path: request.url!, timestamp, requestId, body: bytes.length ? JSON.parse(bytes.toString("utf8")) : null, range: request.headers.range, ifMatch: request.headers["if-match"] });
      if (!respond && options.installer && request.url!.endsWith("/installer")) { sendInstaller(request, response, installer, manifest.installerSha256); return; }
      if (!respond && options.installer && request.url!.endsWith("/switch-authorization")) { response.end(JSON.stringify({ ok: true, authorized: true, deviceId: identity.deviceId,
        requestId: initial.requestId, shellId: manifest.shellId, installerSha256: manifest.installerSha256, manifestSha256: crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex") })); return; }
      const body = respond ? await respond(request, response) : request.url!.endsWith("/register") ? ack : discovery;
      if (!response.writableEnded && !response.destroyed) { if (!response.headersSent) response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); }
    })().catch(error => { failures.push(error); response.writeHead(500); response.end(JSON.stringify({ ok: false, code: "TEST_HANDLER_FAILED" })); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); assert.deepEqual(failures, []); });
  const configuredServerOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new AbortController();
  const input: NetworkInput = { store, identity, configuredServerOrigin, trustedKeys: { "test-key": keys.publicKey }, signal: controller.signal,
    currentShellVersion: options.sameShell ? "2.0.0" : "1.0", onRetry: () => {} };
  return { dataDir, identity, keys, manifest, installer, initial, store, main, client, calls, server, ack, discovery, input, controller,
    respond(handler: typeof respond) { respond = handler; },
    resultDirectory: path.join(dataDir, ".staging", "shell-update", crypto.createHash("sha256").update(initial.requestId).digest("hex")) };
}

test("a higher shell version updates without comparing the installed file inventory", async t => {
  const f = await fixture(t, { matchingInstalled: true });
  const result = await network(f.input).prepare();
  assert.equal(result.status, "target");
  assert.equal(result.attempt.target?.shellId, "shell-next");
  assert.equal(f.calls.some(call => call.path.endsWith("/installer")), false);
});

for (const version of ["2.0.0", "3.0"])
test(`shell target at or below installed version ${version} is not downloaded`, async t => {
  const f = await fixture(t); f.input.currentShellVersion = version;
  const result = await network(f.input).prepare();
  assert.equal(result.status, "no-update"); assert.equal(result.attempt.target, null);
});

test("unknown shell version is a check failure, never an implicit upgrade from zero", async t => {
  const f = await fixture(t); f.input.currentShellVersion = "unknown";
  await assert.rejects(network(f.input).prepare(), error => (error as Error).cause instanceof Error
    && ((error as Error).cause as Error).message === "DESKTOP_SHELL_VERSION_INVALID");
  assert.equal((await f.store.read())?.target, null);
});

test("schema5 network preserves preparation proofs across discovery installer and a new process", async t => {
  const f = await fixture(t, { lifecycle: true, installer: true });
  let current = await f.store.read();
  if (current?.schemaVersion !== 5 || isShellUpdateHandoffAttempt(current)) throw new Error("preparation5 required");
  current = await f.store.observePreparationOwned(current, { caller: f.main, processes: [f.main] });
  const before = structuredClone(current), result = await network(f.input).prepare();
  assert.equal(result.status, "target"); assert.equal(result.attempt.schemaVersion, 5);
  const downloaded = await network(f.input).downloadInstaller(); assert.equal(downloaded.sha256, f.manifest.installerSha256);
  const prepared = await network(f.input).readPrepared();
  assert.equal(prepared.attempt.schemaVersion, 5);
  if (prepared.attempt.schemaVersion !== 5) throw new Error("schema5 result required");
  assert.deepEqual(prepared.attempt.ownedLifecycle, before.ownedLifecycle);
  assert.deepEqual(prepared.attempt.preparationMains, before.preparationMains);
  const count = f.calls.length; assert.equal((await resumeInNode(f)).attempt.schemaVersion, 5); assert.equal(f.calls.length, count);
  assert.equal((await f.store.read())?.retriesUsed, 0);
});

test("schema5 ordinary main binding preserves waiting budget and dispatching cannot resend", async t => {
  const f = await fixture(t, { lifecycle: true });
  f.respond((_request, response) => { response.statusCode = 503; return { ok: false, code: "TEMPORARY" }; });
  f.input.onRetry = () => { throw new Error("AFTER_RESERVATION"); };
  await assert.rejects(network(f.input).prepare());
  const waiting = await f.store.read();
  if (waiting?.schemaVersion !== 5 || isShellUpdateHandoffAttempt(waiting)) throw new Error("preparation5 required");
  assert.equal(waiting.retriesUsed, 1); assert.equal(waiting.network?.status, "waiting");
  const nextMain = { ...f.main, pid: 51, created: 1051, commandLine: "new preparation main" };
  const bound = await f.store.bindPreparationMain(waiting, { caller: nextMain, processes: [nextMain],
    launchState: { status: "known", value: waiting.originalState }, binding: { status: "matched", value: waiting.binding },
    profile: { status: "known", dataDir: waiting.dataDir, userDataDir: waiting.userDataDir, sessionDataDir: waiting.sessionDataDir } });
  assert.deepEqual(bound.network, waiting.network); assert.equal(bound.retriesUsed, 1);
  const adapter = createShellUpdateAttemptNetworkAdapter(f.store), current = await adapter.read();
  await adapter.replace(current, { retriesUsed: 1, network: { actionKey: current.network!.actionKey, requestSha256: current.network!.requestSha256, status: "dispatching" } });
  const count = f.calls.length;
  await assert.rejects(network({ ...f.input, onRetry: () => {} }).prepare(), { code: "DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN" });
  assert.equal(f.calls.length, count); assert.equal((await f.store.read())?.retriesUsed, 1);
});

/** 因果检查包含显式 undefined 原因，避免多故障被覆盖。 */
function causes(value: unknown): unknown[] {
  return [value, ...(value instanceof AggregateError ? value.errors.flatMap(causes) : []),
    ...(value instanceof Error && Object.hasOwn(value, "cause") ? causes(value.cause) : [])];
}

/** 新 Node 进程恢复同唯一 attempt；退出、正文与 stderr 均严格校验。 */
async function resumeInNode(f: Awaited<ReturnType<typeof fixture>>, action = "prepare") {
  const script = path.join(f.dataDir, "resume.mjs");
  await fs.writeFile(script, `import { createShellUpdateNetwork } from ${JSON.stringify(new URL("../src/shellUpdateNetwork.ts", import.meta.url).href)};\n`
    + `import { createShellUpdateAttemptStore } from ${JSON.stringify(new URL("../src/shellUpdateAttempt.ts", import.meta.url).href)};\n`
    + `const result = await createShellUpdateNetwork({store:createShellUpdateAttemptStore(${JSON.stringify(f.dataDir)}),currentShellVersion:${JSON.stringify(f.input.currentShellVersion)},identity:${JSON.stringify(f.identity)},configuredServerOrigin:${JSON.stringify(f.input.configuredServerOrigin)},trustedKeys:${JSON.stringify({ "test-key": f.keys.publicKey.export({ format: "pem", type: "spki" }).toString() })},signal:new AbortController().signal,onRetry:()=>{}}).${action}();\n`
    + "console.log(JSON.stringify(result));\n", "utf8");
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), windowsHide: true, env: process.env });
  let stdout = "", stderr = ""; child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, stderr); assert.equal(stderr, ""); return JSON.parse(stdout) as Result;
}

test("registration and discovery share a signed request ID then bind one verified target without resending on resume", async t => {
  const f = await fixture(t), result = await network(f.input).prepare();
  assert.equal(result.status, "target"); assert.deepEqual(result.manifest, f.manifest);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/software/desktop/devices/register", "/api/software/desktop/shell-release-availability"]);
  assert.ok(f.calls.every(call => call.requestId === f.initial.requestId));
  assert.deepEqual(f.calls[0]!.body, { deviceId: f.identity.deviceId, publicKeyBase64: f.identity.publicKeyBase64, platform: "win32", arch: "x64",
    shellVersion: "unknown", webVersion: "unknown", clientVersion: "unknown", releaseId: "unknown" });
  assert.deepEqual(result.attempt.target, { shellId: "shell-next", manifestSha256: crypto.createHash("sha256").update(JSON.stringify(f.manifest)).digest("hex"), installerSha256: "a".repeat(64), installerSize: 123 });
  assert.deepEqual(result.attempt.candidateState, { activeShellId: "shell-next", previousShellId: "shell-current", baselineShellId: "installation" });
  assert.equal(result.attempt.phase, "preparing");
  assert.deepEqual(await resumeInNode(f), result); assert.equal(f.calls.length, 2);
  const artifacts = await fs.readdir(f.resultDirectory); assert.deepEqual(artifacts.sort(), ["discovery.json", "registration.json"]);
  for (const name of artifacts) { const record = JSON.parse(await fs.readFile(path.join(f.resultDirectory, name), "utf8"));
    assert.equal(record.requestId, f.initial.requestId); for (const forbidden of ["phase", "network", "retriesUsed", "activated"]) assert.equal(Object.hasOwn(record, forbidden), false); }
});

for (const sameShell of [false, true]) test(`${sameShell ? "fully verified same shell" : "available false"} ends as no-update and never opens a new cycle`, async t => {
  const f = await fixture(t, { sameShell, available: sameShell }), result = await network(f.input).prepare();
  assert.equal(result.status, "no-update"); assert.equal(result.attempt.phase, "no-update");
  assert.equal(result.reason, sameShell ? "same" : "none");
  assert.equal(result.attempt.target, null); assert.equal(result.attempt.candidateState, null);
  assert.deepEqual(await resumeInNode(f), result); assert.equal(f.calls.length, 2);
  assert.equal((await f.store.read())?.requestId, f.initial.requestId);
});

test("invalid registration ACK explicitly fails with zero discovery requests", async t => {
  const f = await fixture(t); f.respond(() => ({ ...f.ack, publicKeySha256: "0".repeat(64) }));
  await assert.rejects(network(f.input).prepare()); assert.equal(f.calls.length, 1);
  assert.equal((await f.store.read())?.phase, "failed");
});

for (const variant of ["signature", "trust", "expired", "future", "version", "envelope", "identity", "same-shell-signature", "private-json", "oversized"] as const) {
  test(`invalid ${variant} discovery never binds target or continues sending`, async t => {
    const f = await fixture(t, { sameShell: variant === "same-shell-signature" });
    let manifest: unknown = f.manifest;
    if (variant.includes("signature")) { const bytes = Buffer.from(f.manifest.signature, "base64"); bytes[0] = bytes[0]! ^ 1; manifest = { ...f.manifest, signature: bytes.toString("base64") }; }
    if (variant === "trust") f.input.trustedKeys = {};
    if (variant === "version") manifest = { ...f.manifest, schemaVersion: 2 };
    if (variant === "expired" || variant === "future") { const { signature: _signature, ...payload } = f.manifest; manifest = signShellReleaseManifest({ ...payload,
      createdAt: new Date(Date.now() + (variant === "future" ? 60_000 : -120_000)).toISOString(), expiresAt: new Date(Date.now() + (variant === "future" ? 120_000 : -60_000)).toISOString() }, f.keys.privateKey); }
    f.respond((request, response) => {
      if (request.url!.endsWith("/register")) return f.ack;
      if (variant === "private-json") { response.end('{"private":"DO_NOT_EXPOSE_REMOTE_SECRET"'); return; }
      if (variant === "oversized") { response.end(" ".repeat(16 * 1024 * 1024 + 65_537)); return; }
      return { ...f.discovery, manifest, ...(variant === "envelope" ? { extra: true } : {}), ...(variant === "identity" ? { requestId: "other" } : {}) };
    });
    await assert.rejects(network(f.input).prepare(), error => { assert.equal(causes(error).some(cause => cause instanceof Error && cause.message.includes("DO_NOT_EXPOSE_REMOTE_SECRET")), false); return true; });
    const attempt = await f.store.read(); assert.equal(attempt?.target, null); assert.equal(attempt?.phase, "failed"); assert.equal(f.calls.length, 2);
  });
}

test("a retry reservation survives a new Node process with one shared budget and a new signature timestamp", async t => {
  const f = await fixture(t); let first = true;
  f.respond((request, response) => { if (first) { first = false; response.statusCode = 503; return { ok: false, code: "TEMPORARY" }; }
    return request.url!.endsWith("/register") ? f.ack : f.discovery; });
  const stopped = new Error("STOP_AFTER_RESERVATION"); f.input.onRetry = () => { throw stopped; };
  await assert.rejects(network(f.input).prepare(), error => error === stopped || causes(error).includes(stopped));
  const waiting = await f.store.read() as ShellUpdateAttemptV2; assert.equal(waiting.network?.status, "waiting"); assert.equal(waiting.retriesUsed, 1);
  const result = await resumeInNode(f); assert.equal(result.status, "target"); assert.equal(result.attempt.retriesUsed, 1);
  assert.equal(f.calls.length, 3); assert.ok(f.calls[1]!.timestamp > f.calls[0]!.timestamp);
});

test("discovery waiting resumes discovery only, while dispatching without evidence sends nothing", async t => {
  const f = await fixture(t); f.respond((request, response) => { if (request.url!.endsWith("/register")) return f.ack; response.statusCode = 503; return { ok: false, code: "TEMPORARY" }; });
  f.input.onRetry = () => { throw new Error("STOP_AFTER_RESERVATION"); }; await assert.rejects(network(f.input).prepare());
  const adapter = createShellUpdateAttemptNetworkAdapter(f.store), waiting = await adapter.read(); assert.equal(waiting.network?.status, "waiting");
  await adapter.replace(waiting, { retriesUsed: waiting.retriesUsed, network: { actionKey: waiting.network!.actionKey, requestSha256: waiting.network!.requestSha256, status: "dispatching" } });
  const count = f.calls.length; await assert.rejects(network({ ...f.input, onRetry: () => {} }).prepare(), { code: "DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN" }); assert.equal(f.calls.length, count);
});

test("a discovery reservation recovers in a new process without repeating registration", async t => {
  const f = await fixture(t); let first = true;
  f.respond((request, response) => { if (request.url!.endsWith("/register")) return f.ack; if (first) { first = false; response.statusCode = 503; return { ok: false, code: "TEMPORARY" }; } return f.discovery; });
  f.input.onRetry = () => { throw new Error("STOP_AFTER_RESERVATION"); }; await assert.rejects(network(f.input).prepare());
  const result = await resumeInNode(f); assert.equal(result.status, "target"); assert.equal(result.attempt.retriesUsed, 1);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/software/desktop/devices/register", "/api/software/desktop/shell-release-availability", "/api/software/desktop/shell-release-availability"]);
});

for (const field of ["origin", "deviceId", "publicKeySha256", "requestId", "requestSha256", "response"] as const) test(`cached ${field} tampering fails with zero resends`, async t => {
  const f = await fixture(t); await network(f.input).prepare(); const filename = path.join(f.resultDirectory, "registration.json");
  const record = JSON.parse(await fs.readFile(filename, "utf8")); record[field] = field === "response" ? { ...f.ack, publicKeySha256: "0".repeat(64) } : "wrong";
  await fs.writeFile(filename, `${JSON.stringify(record)}\n`, "utf8");
  await assert.rejects(network(f.input).prepare()); assert.equal(f.calls.length, 2);
});

test("unknown future actions and failed/handoff attempts never restart network work", async t => {
  for (const phase of ["preparing", "failed", "handoff"] as const) {
    const f = await fixture(t); const current = await f.store.read() as ShellUpdateAttemptV2;
    const selection = phase === "handoff" ? { target: { shellId: "shell-next", manifestSha256: "d".repeat(64), installerSha256: "a".repeat(64), installerSize: 123 },
      candidateState: { activeShellId: "shell-next", previousShellId: "shell-current", baselineShellId: "installation" } } : {};
    const prepared = await f.store.replace(current, { ...current, revision: 1, ...selection });
    await f.store.replace(prepared, { ...prepared, revision: 2, phase });
    if (phase === "preparing") { const adapter = createShellUpdateAttemptNetworkAdapter(f.store); await adapter.replace(await adapter.read(), { retriesUsed: 0, network: { actionKey: "future-installer", requestSha256: "d".repeat(64), status: "dispatching" } }); }
    await assert.rejects(network(f.input).prepare()); assert.equal(f.calls.length, 0);
  }
});

test("cancellation after headers stops body verification without retries or discovery", async t => {
  const f = await fixture(t), reason = new Error("USER_CANCELLED"); let retries = 0; f.input.onRetry = () => { retries++; };
  f.respond((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.write('{"ok":'); f.controller.abort(reason); });
  await assert.rejects(network(f.input).prepare(), error => error === reason || causes(error).includes(reason));
  assert.equal(f.calls.length, 1); assert.equal(retries, 0); assert.equal((await f.store.read())?.retriesUsed, 0);
});

for (const operation of ["write", "sync", "close", "link", "post-read"] as const) test(`result ${operation} failure cannot mark success or send discovery`, async t => {
  const f = await fixture(t), problem = new Error(`RESULT_${operation}_FAILED`), open = fs.open.bind(fs), link = fs.link.bind(fs);
  let injected = false, retries = 0; f.input.onRetry = () => { retries++; };
  if (operation === "link") t.mock.method(fs, "link", async (source: string, target: string) => { if (target.endsWith("registration.json")) { injected = true; throw problem; } return link(source, target); });
  else t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args), name = String(args[0]);
    if (name.includes("registration.json.") && name.endsWith(".tmp")) {
      if (operation === "write" || operation === "sync") t.mock.method(handle, operation, async () => { injected = true; throw problem; });
      if (operation === "close") { const close = handle.close.bind(handle); t.mock.method(handle, "close", async () => { await close(); injected = true; throw problem; }); }
    }
    if (operation === "post-read" && name.endsWith("registration.json")) t.mock.method(handle, "read", async () => { injected = true; throw problem; });
    return handle;
  });
  await assert.rejects(network(f.input).prepare(), error => causes(error).includes(problem));
  assert.equal(injected, true); assert.equal(retries, 0); assert.equal(f.calls.length, 1);
  const attempt = await f.store.read() as ShellUpdateAttemptV2; assert.equal(attempt.network?.status, "dispatching"); assert.equal(attempt.retriesUsed, 0);
});

test("undefined write failure and close failure remain separate causes and do not retry", async t => {
  const f = await fixture(t), closeFailure = new Error("CLOSE_FAILED"), open = fs.open.bind(fs); let retries = 0; f.input.onRetry = () => { retries++; };
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes("registration.json.") && String(args[0]).endsWith(".tmp")) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, "write", async () => { throw undefined; });
      t.mock.method(handle, "close", async () => { await close(); throw closeFailure; });
    }
    return handle;
  });
  await assert.rejects(network(f.input).prepare(), error => causes(error).some(value => value instanceof AggregateError && value.errors.length === 2 && value.errors[0] === undefined && value.errors[1] === closeFailure));
  assert.equal(retries, 0); assert.equal(f.calls.length, 1); assert.equal((await f.store.read() as ShellUpdateAttemptV2).network?.status, "dispatching");
});

test("reader failure and cancel failure preserve both causes with zero retry", async t => {
  const f = await fixture(t), nativeFetch = globalThis.fetch, closeFailure = new Error("READER_CANCEL_FAILED"), readFailure = Object.assign(new Error("BODY_RESET"), { code: "ECONNRESET" });
  let retries = 0; f.input.onRetry = () => { retries++; };
  t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await nativeFetch(...args), getReader = response.body!.getReader.bind(response.body);
    t.mock.method(response.body!, "getReader", () => { const reader = getReader();
      const cancel = reader.cancel.bind(reader); t.mock.method(reader, "read", async () => { throw readFailure; });
      t.mock.method(reader, "cancel", async () => { await cancel(); throw closeFailure; }); return reader; });
    return response;
  });
  await assert.rejects(network(f.input).prepare(), error => causes(error).includes(readFailure) && causes(error).includes(closeFailure));
  assert.equal(f.calls.length, 1); assert.equal(retries, 0); assert.equal((await f.store.read())?.retriesUsed, 0);
});

test("released reader failure cannot be retried even with an otherwise transient code", async t => {
  const f = await fixture(t), nativeFetch = globalThis.fetch, problem = Object.assign(new Error("READER_RELEASE_FAILED"), { code: "ECONNRESET" });
  let retries = 0; f.input.onRetry = () => { retries++; };
  t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await nativeFetch(...args), getReader = response.body!.getReader.bind(response.body);
    t.mock.method(response.body!, "getReader", () => { const reader = getReader(), release = reader.releaseLock.bind(reader);
      t.mock.method(reader, "releaseLock", () => { release(); throw problem; }); return reader; }); return response;
  });
  await assert.rejects(network(f.input).prepare(), error => causes(error).includes(problem)); assert.equal(f.calls.length, 1); assert.equal(retries, 0);
});

test("complete registration evidence survives a failed succeeded-slot save and recovers without resending", async t => {
  const f = await fixture(t), replace = f.store.replace.bind(f.store), problem = new Error("SUCCEEDED_SAVE_FAILED"); let once = true;
  t.mock.method(f.store, "replace", async (expected: unknown, next: any) => { if (once && next.network?.status === "succeeded") { once = false; throw problem; } return replace(expected, next); });
  await assert.rejects(network(f.input).prepare(), error => causes(error).includes(problem));
  assert.equal(f.calls.length, 1); assert.equal((await f.store.read() as ShellUpdateAttemptV2).network?.status, "dispatching");
  const result = await resumeInNode(f); assert.equal(result.status, "target"); assert.equal(f.calls.length, 2);
  assert.equal(f.calls.filter(call => call.path.endsWith("/register")).length, 1);
});

test("a locally cached manifest is rechecked for expiry before returning a selected target", async t => {
  const f = await fixture(t); await network(f.input).prepare(); const count = f.calls.length, now = Date.now;
  t.mock.method(Date, "now", () => now() + 7_200_000);
  await assert.rejects(network(f.input).prepare(), error => causes(error).some(value => value instanceof Error && value.message === "DESKTOP_SHELL_MANIFEST_TIME_INVALID"));
  assert.equal(f.calls.length, count);
});

test("hardlinked cache files and redirected staging directories reject with zero resends", async t => {
  const f = await fixture(t); await network(f.input).prepare(); const filename = path.join(f.resultDirectory, "registration.json");
  await fs.link(filename, path.join(f.dataDir, "registration-alias.json")); await assert.rejects(network(f.input).prepare()); assert.equal(f.calls.length, 2);
  const g = await fixture(t); await fs.mkdir(path.join(g.dataDir, "outside")); await fs.symlink(path.join(g.dataDir, "outside"), path.join(g.dataDir, ".staging"), "junction");
  await assert.rejects(network(g.input).prepare()); assert.equal(g.calls.length, 0);
});

test("invalid configured origin, identity, platform and missing attempt fail before HTTP", async t => {
  for (const kind of ["origin", "identity", "platform", "missing"] as const) {
    const f = await fixture(t);
    if (kind === "origin") f.input.configuredServerOrigin = "http://untrusted.invalid";
    if (kind === "identity") f.input.identity = { ...f.identity, deviceId: crypto.randomUUID() };
    if (kind === "missing") f.input.store = createShellUpdateAttemptStore(await fs.mkdtemp(path.join(evidence, "missing-")));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    if (kind === "platform") Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    try { await assert.rejects(network(f.input).prepare()); assert.equal(f.calls.length, 0); }
    finally { Object.defineProperty(process, "platform", platform); }
  }
});

test("changed local health binding cannot be adopted after discovery", async t => {
  const f = await fixture(t), read = f.store.read.bind(f.store); let reads = 0;
  t.mock.method(f.store, "read", async () => { const value = await read(); reads++;
    if (value?.schemaVersion === 2 && value.network?.status === "succeeded" && value.network.evidence.kind === "shell-manifest") {
      return { ...value, binding: { ...value.binding, health: { ...value.binding.health, clientVersion: "unexpected-other-runtime" } } };
    }
    return value;
  });
  await assert.rejects(network(f.input).prepare(), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
  assert.ok(reads > 1); assert.equal((await read())?.target, null); assert.equal(f.calls.length, 2);
});

test("no-update recovery rejects a changed slot request digest before accepting cached discovery", async t => {
  const f = await fixture(t, { available: false }); await network(f.input).prepare();
  const filename = path.join(f.dataDir, "shell-update-attempt.json"), attempt = JSON.parse(await fs.readFile(filename, "utf8"));
  attempt.network.requestSha256 = "f".repeat(64); await fs.writeFile(filename, JSON.stringify(attempt), "utf8");
  await assert.rejects(network(f.input).prepare()); assert.equal(f.calls.length, 2);
});

test("a cached result replaced while its reader closes cannot authorize the next stage", async t => {
  const f = await fixture(t); await network(f.input).prepare(); const open = fs.open.bind(fs); let changed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => { const handle = await open(...args);
    if (String(args[0]).endsWith("registration.json")) { const close = handle.close.bind(handle); t.mock.method(handle, "close", async () => {
      await close(); await fs.writeFile(String(args[0]), "{}\n", "utf8"); changed = true;
    }); } return handle;
  });
  await assert.rejects(network(f.input).prepare()); assert.equal(changed, true); assert.equal(f.calls.length, 2);
});

for (const kind of ["malformed", "oversized", "body-cleanup"] as const) test(`non-2xx ${kind} response is explicit failure without retry or discovery`, async t => {
  const f = await fixture(t), nativeFetch = globalThis.fetch; let retries = 0; f.input.onRetry = () => { retries++; };
  f.respond((_request, response) => { response.statusCode = 503;
    if (kind === "malformed") { response.end('{"remote":"PRIVATE_503_NEVER_EXPOSE"'); return; }
    if (kind === "oversized") { response.end(" ".repeat(16 * 1024 * 1024 + 65_537)); return; }
    return { ok: false, code: "TEMPORARY" };
  });
  if (kind === "body-cleanup") t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await nativeFetch(...args), getReader = response.body!.getReader.bind(response.body);
    t.mock.method(response.body!, "getReader", () => { const reader = getReader(), cancel = reader.cancel.bind(reader);
      t.mock.method(reader, "read", async () => { throw Object.assign(new Error("BODY_RESET"), { code: "ECONNRESET" }); });
      t.mock.method(reader, "cancel", async () => { await cancel(); throw new Error("CANCEL_FAILED"); }); return reader; }); return response;
  });
  await assert.rejects(network(f.input).prepare(), error => { assert.equal(causes(error).some(cause => cause instanceof Error && cause.message.includes("PRIVATE_503_NEVER_EXPOSE")), false); return true; });
  assert.equal(f.calls.length, 1); assert.equal(retries, 0); assert.equal((await f.store.read())?.retriesUsed, 0);
});

/** 真实二进制响应遵守固定 ETag 与确切 Range；不执行合成安装器。 */
function sendInstaller(request: http.IncomingMessage, response: http.ServerResponse, bytes: Buffer, digest: string): void {
  assert.equal(request.headers["if-match"], `"${digest}"`);
  const start = request.headers.range ? Number(/^bytes=(\d+)-$/u.exec(request.headers.range)![1]) : 0;
  response.writeHead(start ? 206 : 200, { etag: `"${digest}"`, "content-length": String(bytes.length - start),
    ...(start ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) }); response.end(bytes.subarray(start));
}

/** 经原 store 显式交接；不造真实 PID 或启动 helper。 */
async function beginNetworkHandoff(f: Awaited<ReturnType<typeof fixture>>, lifecycle = false): Promise<ShellUpdateHandoffAttempt> {
  const selected = await f.store.read(); assert.ok(selected?.schemaVersion === 2 && selected.target);
  const processIdentity = (pid: number, parentPid: number) => ({ pid, parentPid, created: 100_000 + pid,
    executable: path.join(selected.installationDir, "shells", "shell-current", "CodeFlowAI.exe"), commandLine: `synthetic-network-${pid}` });
  const oldMain = processIdentity(101, 1), helper = processIdentity(102, 101);
  return await f.store.beginHandoff(selected, { continuationId: "network-handoff", oldMain, helper,
    ...(lifecycle ? { lifecycle: true, processes: [oldMain, helper], knownOwned: [] } : {}) });
}

test("installer action downloads verified bytes with the original signer and recovers across Node without earlier sends", async t => {
  const f = await fixture(t, { installer: true }), owner = network(f.input);
  const result = await owner.downloadInstaller(); assert.deepEqual(await fs.readFile(result.installerPath), f.installer);
  assert.equal(result.sha256, f.manifest.installerSha256); assert.equal(result.size, f.installer.length);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/software/desktop/devices/register", "/api/software/desktop/shell-release-availability", "/api/software/desktop/shell-releases/shell-next/installer"]);
  const state = await f.store.read() as ShellUpdateAttemptV2; assert.equal(state.network?.status, "succeeded"); assert.equal(state.network?.actionKey, "shell-installer");
  assert.ok(state.network?.status === "succeeded" && state.network.evidence.kind === "shell-installer");
  assert.deepEqual(await resumeInNode(f, "downloadInstaller"), result); assert.equal(f.calls.length, 3);
  assert.equal((await owner.prepare()).status, "target"); assert.equal(f.calls.length, 3);
});

test("installer HTTP retry reserves the original shared budget and resumes only that action in a new Node", async t => {
  const f = await fixture(t, { installer: true }); let first = true;
  f.respond((request, response) => { if (request.url!.endsWith("/register")) return f.ack; if (request.url!.endsWith("/availability")) return f.discovery;
    if (request.url!.endsWith("/installer")) { if (first) { first = false; response.statusCode = 503; return { ok: false, code: "TEMPORARY" }; }
      sendInstaller(request, response, f.installer, f.manifest.installerSha256); return; } return f.discovery; });
  f.input.onRetry = () => { throw new Error("PERSISTED_INSTALLER_RESERVATION"); };
  await assert.rejects(network(f.input).downloadInstaller());
  const waiting = await f.store.read() as ShellUpdateAttemptV2; assert.equal(waiting.network?.status, "waiting"); assert.equal(waiting.retriesUsed, 1);
  const result = await resumeInNode(f, "downloadInstaller") as unknown as Installed; assert.deepEqual(await fs.readFile(result.installerPath), f.installer);
  assert.equal(f.calls.length, 4); assert.equal(f.calls.filter(call => call.path.endsWith("/register")).length, 1);
});

test("installer unknown dispatch with only a partial file is never resent", async t => {
  const f = await fixture(t, { installer: true });
  f.respond((request, response) => { if (request.url!.endsWith("/installer")) { response.statusCode = 503; return { ok: false, code: "TEMPORARY" }; } return request.url!.endsWith("/register") ? f.ack : f.discovery; });
  f.input.onRetry = () => { throw new Error("STOP_AT_INSTALLER_WAIT"); }; await assert.rejects(network(f.input).downloadInstaller());
  const adapter = createShellUpdateAttemptNetworkAdapter(f.store), waiting = await adapter.read(); assert.equal(waiting.network?.status, "waiting");
  await adapter.replace(waiting, { retriesUsed: waiting.retriesUsed, network: { actionKey: waiting.network!.actionKey, requestSha256: waiting.network!.requestSha256, status: "dispatching" } });
  const before = f.calls.length; await assert.rejects(network(f.input).downloadInstaller(), { code: "DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN" }); assert.equal(f.calls.length, before);
});

test("each live switch authorization sends again and a cached positive cannot conceal current revocation", async t => {
  const f = await fixture(t, { installer: true }), owner = network(f.input); await owner.downloadInstaller();
  const first = await owner.authorizeSwitch(); assert.equal(first.authorized, true); assert.equal(first.shellId, "shell-next");
  const firstAction = (await f.store.read() as ShellUpdateAttemptV2).network!.actionKey;
  await owner.authorizeSwitch(); const secondAction = (await f.store.read() as ShellUpdateAttemptV2).network!.actionKey; assert.notEqual(secondAction, firstAction);
  f.respond((request) => request.url!.endsWith("/switch-authorization") ? { ok: true, authorized: false, deviceId: f.identity.deviceId, requestId: f.initial.requestId, shellId: "shell-next" } : f.discovery);
  const calls = f.calls.length; await assert.rejects(owner.authorizeSwitch(), { code: "DESKTOP_SHELL_SWITCH_NOT_AUTHORIZED" }); assert.equal(f.calls.length, calls + 1);
  assert.equal((await f.store.read())?.phase, "failed");
});

test("a new Node must obtain current switch permission after recovering a historical positive", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller(); await network(f.input).authorizeSwitch();
  const before = f.calls.length, result = await resumeInNode(f, "authorizeSwitch") as unknown as { authorized: true };
  assert.equal(result.authorized, true); assert.equal(f.calls.length, before + 1);
});

test("handoff helper authorization uses the same exact action and shared budget before any main selection", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller(); await beginNetworkHandoff(f);
  const before = f.calls.length, result = await network(f.input).authorizeSwitch(); assert.equal(result.authorized, true); assert.equal(f.calls.length, before + 1);
  const state = await f.store.read() as ShellUpdateAttemptV3; assert.equal(state.schemaVersion, 3); assert.equal(state.phase, "handoff");
  assert.equal(state.selectedMain, null); assert.equal(state.admission, null); assert.match(state.network.actionKey, /^shell-authorize:(0|[1-9][0-9]*)$/u);
});

test("schema4 authorization preserves released inventory and advances the control revision", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller();
  let current = await beginNetworkHandoff(f, true);
  const query = { ...current.oldMain, pid: 150, parentPid: current.oldMain.pid, created: 100_150, commandLine: "query child" };
  current = await f.store.observeHandoffOwned(current, { caller: current.helper, processes: [current.oldMain, current.helper, query] });
  current = await f.store.observeHandoffOwned(current, { caller: current.helper, processes: [current.oldMain, current.helper] });
  assert.equal(current.schemaVersion, 4); if (current.schemaVersion !== 4) throw new Error("schema4 required");
  const before = current;
  assert.equal((await network(f.input).authorizeSwitch()).authorized, true);
  const actual = await f.store.read(); if (actual?.schemaVersion !== 4) throw new Error("schema4 required");
  assert.ok(actual.controlRevision > before.controlRevision); assert.equal(actual.controlRevision, actual.revision);
  assert.deepEqual(actual.ownedLifecycle, before.ownedLifecycle);
  const prepared = await network(f.input).readPrepared(); assert.equal(prepared.attempt.schemaVersion, 4);
});

test("schema4 installed proof reads admitted history without changing either revision", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller();
  await admitInstalledFixture(f, true); const before = await f.store.read(), calls = f.calls.length;
  assert.equal((await network(f.input).readInstalledPrepared()).attempt.schemaVersion, 4);
  assert.deepEqual(await f.store.read(), before); assert.equal(f.calls.length, calls);
});

test("schema4 readPrepared rejects a changed control revision during its readonly proof", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller();
  const before = await beginNetworkHandoff(f, true); if (before.schemaVersion !== 4) throw new Error("schema4 required");
  let reads = 0;
  const store = { ...f.store, read: async () => ++reads === 1 ? before : { ...before, controlRevision: before.controlRevision - 1 } };
  await assert.rejects(network({ ...f.input, store }).readPrepared(), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
  assert.ok(reads >= 2); assert.deepEqual(await f.store.read(), before);
});

test("handoff readPrepared verifies full manifest and installer without network or slot mutations", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller(); await beginNetworkHandoff(f);
  const owner = network(f.input), before = await f.store.read(), calls = f.calls.length;
  const prepared = await owner.readPrepared(); assert.equal(prepared.attempt.schemaVersion, 3); assert.deepEqual(prepared.manifest, f.manifest);
  assert.deepEqual(await fs.readFile(prepared.installerPath), f.installer); assert.deepEqual(await f.store.read(), before); assert.equal(f.calls.length, calls);
  await fs.writeFile(prepared.installerPath, Buffer.alloc(f.installer.length));
  await assert.rejects(owner.readPrepared()); assert.deepEqual(await f.store.read(), before); assert.equal(f.calls.length, calls);
});

/** 已准入实体只用于只读工件证明，不伪造真实进程或重新授予切换资格。 */
async function admitInstalledFixture(f: Awaited<ReturnType<typeof fixture>>, lifecycle = false) {
  const handoff = await beginNetworkHandoff(f, lifecycle);
  const main = { pid: 103, parentPid: handoff.helper.pid, created: 100_103,
    executable: path.join(handoff.installationDir, "shells", handoff.target.shellId, "CodeFlowAI.exe"), commandLine: "synthetic-installed-main" };
  let selected = await f.store.replace(handoff, { ...handoff, revision: handoff.revision + 1, selectedMain: main }) as ShellUpdateHandoffAttempt;
  const ready = { role: "candidate", continuationId: selected.continuationId, main,
    client: { pid: 104, parentPid: main.pid, created: 100_104, executable: path.join(f.dataDir, "node.exe"), commandLine: "synthetic-installed-client" },
    readyRequestId: "installed-ready", health: selected.binding.health, binding: selected.binding, launchState: selected.candidateState,
    profile: { dataDir: selected.dataDir, userDataDir: selected.userDataDir, sessionDataDir: selected.sessionDataDir }, mainFrame: "loaded",
    startup: { continuationId: selected.continuationId, admission: "paused" } };
  if (lifecycle) selected = await f.store.observeHandoffOwned(selected, { caller: selected.helper, processes: [selected.helper, main, ready.client] });
  return await f.store.replace(selected, { ...selected, revision: selected.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateHandoffAttempt;
}

test("installed proof reads an expired admitted manifest without network budget or state writes", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller(); await admitInstalledFixture(f);
  const owner = network(f.input), before = await f.store.read(), calls = f.calls.length, now = Date.now;
  t.mock.method(Date, "now", () => now() + 7_200_000);
  assert.equal(typeof owner.readInstalledPrepared, "function", "installed proof reader must exist");
  const result = await owner.readInstalledPrepared(); assert.deepEqual(result.manifest, f.manifest);
  assert.deepEqual(await fs.readFile(result.installerPath), f.installer);
  await assert.rejects(owner.readPrepared()); await assert.rejects(owner.authorizeSwitch());
  assert.deepEqual(await f.store.read(), before); assert.equal(f.calls.length, calls);
});

test("installed proof rejects a preparing or unadmitted handoff without network or writes", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller(); const owner = network(f.input);
  assert.equal(typeof owner.readInstalledPrepared, "function", "installed proof reader must exist");
  for (const handoff of [false, true]) {
    if (handoff) await beginNetworkHandoff(f);
    const before = await f.store.read(), calls = f.calls.length;
    await assert.rejects(owner.readInstalledPrepared()); assert.deepEqual(await f.store.read(), before); assert.equal(f.calls.length, calls);
  }
});

test("installed proof retains origin signature and physical installer checks after expiration", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller(); await admitInstalledFixture(f);
  const owner = network(f.input), before = await f.store.read(), calls = f.calls.length, now = Date.now;
  t.mock.method(Date, "now", () => now() + 7_200_000);
  assert.equal(typeof owner.readInstalledPrepared, "function", "installed proof reader must exist");
  await assert.rejects(network({ ...f.input, configuredServerOrigin: "http://127.0.0.1:1" }).readInstalledPrepared());
  const prepared = await owner.readInstalledPrepared(); await fs.writeFile(prepared.installerPath, Buffer.alloc(f.installer.length));
  await assert.rejects(owner.readInstalledPrepared()); assert.deepEqual(await f.store.read(), before); assert.equal(f.calls.length, calls);
});

test("installed proof supports an original recovery without admission and rejects changed signature bytes", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller(); const prior = await beginNetworkHandoff(f);
  const caller = { ...prior.oldMain, pid: 201, parentPid: 1, created: 200_001, commandLine: "synthetic-recovery-controller" };
  const helper = { ...caller, pid: 202, parentPid: caller.pid, created: 200_002, commandLine: "synthetic-recovery-helper" };
  const state = await f.store.beginRecovery(prior, { caller, helper, processes: [caller, helper],
    owner: { status: "gone", identity: prior.helper }, oldMain: { status: "gone", identity: prior.oldMain }, selectedMain: { status: "not-started" },
    launchState: { status: "known", value: prior.originalState }, binding: { status: "matched", value: prior.binding },
    profile: { status: "known", dataDir: prior.dataDir, userDataDir: prior.userDataDir, sessionDataDir: prior.sessionDataDir },
    ownedReleased: "verified", knownOwned: { status: "known", identities: [prior.oldMain, prior.helper] } });
  assert.equal(state.admission, null); const calls = f.calls.length, now = Date.now;
  t.mock.method(Date, "now", () => now() + 7_200_000);
  const owner = network(f.input), read = await owner.readInstalledPrepared(); assert.deepEqual(read.manifest, f.manifest);
  const filename = path.join(f.resultDirectory, "discovery.json"), bytes = await fs.readFile(filename, "utf8");
  assert.ok(bytes.includes(f.manifest.signature));
  const changed = `${f.manifest.signature[0] === "A" ? "B" : "A"}${f.manifest.signature.slice(1)}`;
  await fs.writeFile(filename, bytes.replace(f.manifest.signature, changed), "utf8");
  await assert.rejects(owner.readInstalledPrepared()); assert.deepEqual(await f.store.read(), state); assert.equal(f.calls.length, calls);
});

test("readPrepared does not recreate a missing result directory", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller();
  await fs.rename(f.resultDirectory, `${f.resultDirectory}-held`); const before = await f.store.read();
  await assert.rejects(network(f.input).readPrepared()); assert.equal(existsSync(f.resultDirectory), false);
  assert.deepEqual(await f.store.read(), before); assert.equal(f.calls.length, 3);
});

for (const kind of ["changed-target", "bad-envelope", "expired", "cancelled"] as const) test(`switch ${kind} cannot return positive or perform later effects`, async t => {
  const f = await fixture(t, { installer: true }), owner = network(f.input); await owner.downloadInstaller();
  if (kind === "expired") { const now = Date.now; t.mock.method(Date, "now", () => now() + 7_200_000); }
  if (kind === "cancelled") f.controller.abort(new Error("CANCEL_BEFORE_SWITCH"));
  if (kind === "changed-target" || kind === "bad-envelope") f.respond(() => ({ ok: true, authorized: true, deviceId: f.identity.deviceId, requestId: f.initial.requestId,
    shellId: kind === "changed-target" ? "other-shell" : "shell-next", installerSha256: f.manifest.installerSha256,
    manifestSha256: crypto.createHash("sha256").update(JSON.stringify(f.manifest)).digest("hex"), ...(kind === "bad-envelope" ? { extra: true } : {}) }));
  const before = f.calls.length; await assert.rejects(owner.authorizeSwitch()); assert.equal(f.calls.length, before + (kind === "expired" || kind === "cancelled" ? 0 : 1));
});

for (const lifecycle of [false, true]) test(`${lifecycle ? "schema5" : "schema2"} four transient failures across registration discovery installer and authorization consume only three retries`, async t => {
  const f = await fixture(t, { installer: true, lifecycle }), failed = new Set<string>();
  f.respond((request, response) => {
    if (!failed.has(request.url!)) { failed.add(request.url!); response.statusCode = 503; response.setHeader("retry-after", "0"); return { ok: false, code: "TEMPORARY" }; }
    if (request.url!.endsWith("/register")) return f.ack;
    if (request.url!.endsWith("/installer")) { sendInstaller(request, response, f.installer, f.manifest.installerSha256); return; }
    return f.discovery;
  });
  const owner = network(f.input); await owner.downloadInstaller(); const before = f.calls.length;
  await assert.rejects(owner.authorizeSwitch()); assert.equal(f.calls.length, before + 1);
  const state = await f.store.read(); assert.equal(state?.retriesUsed, 3); assert.equal(state?.phase, "failed"); assert.equal(f.calls.length, 7);
});

/** 当前肯定 ACK 绑定真实夹具清单的规范完整摘要。 */
function positiveSwitch(f: Awaited<ReturnType<typeof fixture>>) {
  return { ok: true, authorized: true, deviceId: f.identity.deviceId, requestId: f.initial.requestId, shellId: f.manifest.shellId,
    installerSha256: f.manifest.installerSha256, manifestSha256: crypto.createHash("sha256").update(JSON.stringify(f.manifest)).digest("hex") };
}

test("a synced installer prefix resumes in a new Node with the exact signed Range and one reservation", async t => {
  const f = await fixture(t, { installer: true }); let first = true;
  f.respond((request, response) => {
    if (request.url!.endsWith("/installer")) {
      if (first) { first = false; response.writeHead(200, { etag: `"${f.manifest.installerSha256}"`, "content-length": String(f.installer.length) });
        response.write(f.installer.subarray(0, 32768)); setTimeout(() => response.destroy(), 40); return; }
      sendInstaller(request, response, f.installer, f.manifest.installerSha256); return;
    }
    return request.url!.endsWith("/register") ? f.ack : f.discovery;
  });
  f.input.onRetry = () => { throw new Error("PRESERVE_PREFIX_RESERVATION"); }; await assert.rejects(network(f.input).downloadInstaller());
  const waiting = await f.store.read() as ShellUpdateAttemptV2; assert.equal(waiting.network?.status, "waiting"); assert.equal(waiting.retriesUsed, 1);
  const result = await resumeInNode(f, "downloadInstaller") as unknown as Installed;
  assert.deepEqual(await fs.readFile(result.installerPath), f.installer); assert.equal(f.calls.at(-1)!.range, "bytes=32768-");
  assert.equal(f.calls.length, 4); assert.equal((await f.store.read())?.retriesUsed, 1);
});

test("handoff authorization waiting resumes the saved action in a new Node without adding a second reservation", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller(); await beginNetworkHandoff(f); let first = true;
  f.respond((_request, response) => { if (first) { first = false; response.statusCode = 503; return { ok: false, code: "TEMPORARY" }; } return positiveSwitch(f); });
  f.input.onRetry = () => { throw new Error("PRESERVED_HANDOFF_AUTHORIZATION"); }; await assert.rejects(network(f.input).authorizeSwitch());
  const waiting = await f.store.read() as ShellUpdateAttemptV3; assert.equal(waiting.network.status, "waiting"); assert.equal(waiting.retriesUsed, 1);
  const key = waiting.network.actionKey, before = f.calls.length;
  const result = await resumeInNode(f, "authorizeSwitch") as unknown as { authorized: true }; assert.equal(result.authorized, true);
  const after = await f.store.read() as ShellUpdateAttemptV3; assert.equal(after.network.actionKey, key); assert.equal(after.retriesUsed, 1); assert.equal(f.calls.length, before + 1);
});

test("handoff authorization unknown dispatch never sends and cannot become a live positive", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller(); await beginNetworkHandoff(f);
  f.respond((_request, response) => { response.statusCode = 503; return { ok: false, code: "TEMPORARY" }; });
  f.input.onRetry = () => { throw new Error("STOP_AFTER_AUTH_WAIT"); }; await assert.rejects(network(f.input).authorizeSwitch());
  const adapter = createShellUpdateAttemptNetworkAdapter(f.store), waiting = await adapter.read();
  await adapter.replace(waiting, { retriesUsed: waiting.retriesUsed, network: { actionKey: waiting.network!.actionKey, requestSha256: waiting.network!.requestSha256, status: "dispatching" } });
  const before = f.calls.length; await assert.rejects(network(f.input).authorizeSwitch(), { code: "DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN" }); assert.equal(f.calls.length, before);
});

test("a complete historical authorization ACK at the dispatch crash point still requires a new live response", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller(); const replace = f.store.replace.bind(f.store), problem = new Error("AUTH_SUCCESS_SAVE_FAILED");
  let first = true;
  t.mock.method(f.store, "replace", async (expected: unknown, next: any) => { if (first && next.network?.status === "succeeded" && next.network.evidence.kind === "shell-switch-authorization") { first = false; throw problem; } return replace(expected, next); });
  await assert.rejects(network(f.input).authorizeSwitch(), error => causes(error).includes(problem));
  const before = f.calls.length; f.respond(() => ({ ok: true, authorized: false, deviceId: f.identity.deviceId, requestId: f.initial.requestId, shellId: f.manifest.shellId }));
  await assert.rejects(network(f.input).authorizeSwitch(), { code: "DESKTOP_SHELL_SWITCH_NOT_AUTHORIZED" }); assert.equal(f.calls.length, before + 1);
});

test("manifest expiry during a saved authorization delay prevents the pending HTTP send", async t => {
  const f = await fixture(t, { installer: true }); await network(f.input).downloadInstaller();
  f.respond((_request, response) => { response.statusCode = 503; response.setHeader("retry-after", "0"); return { ok: false, code: "TEMPORARY" }; });
  const now = Date.now; f.input.onRetry = () => { t.mock.method(Date, "now", () => now() + 7_200_000); };
  const before = f.calls.length; await assert.rejects(network(f.input).authorizeSwitch(), { code: "DESKTOP_SHELL_MANIFEST_TIME_INVALID" });
  assert.equal(f.calls.length, before + 1); assert.equal((await f.store.read())?.retriesUsed, 1);
});

test("installer accepts the exact existing HTTP request identity including dot and plus", async t => {
  const f = await fixture(t, { installer: true, requestId: "shell.check+existing:1" }), value = await network(f.input).downloadInstaller();
  assert.deepEqual(await fs.readFile(value.installerPath), f.installer); assert.ok(f.calls.every(call => call.requestId === "shell.check+existing:1"));
});

test("an interrupted non-2xx installer body stays inside the same durable retry boundary", async t => {
  const f = await fixture(t, { installer: true }); let first = true;
  f.respond((request, response) => {
    if (request.url!.endsWith("/installer")) {
      if (first) { first = false; response.writeHead(503, { "content-type": "application/json", "content-length": "500" }); response.write('{"ok":false,'); setTimeout(() => response.destroy(), 40); return; }
      sendInstaller(request, response, f.installer, f.manifest.installerSha256); return;
    }
    return request.url!.endsWith("/register") ? f.ack : f.discovery;
  });
  f.input.onRetry = () => { throw new Error("PRESERVED_ERROR_BODY_RETRY"); }; await assert.rejects(network(f.input).downloadInstaller());
  const waiting = await f.store.read() as ShellUpdateAttemptV2; assert.equal(waiting.network?.status, "waiting"); assert.equal(waiting.retriesUsed, 1);
  const result = await resumeInNode(f, "downloadInstaller") as unknown as Installed; assert.deepEqual(await fs.readFile(result.installerPath), f.installer); assert.equal(f.calls.length, 4);
});
