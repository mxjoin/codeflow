import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as tar from 'tar';
import { type ReleaseBundleManifest } from '@codeflowai/shared';
import { signReleaseBundleManifest } from '@codeflowai/shared/desktop-release-signing';
import { buildDesktopDevicePayload, desktopDevicePublicKeySha256, readDesktopDeviceHeaders,
  verifyDesktopDeviceSignature } from '@codeflowai/shared/desktop-device-auth';
import { type DesktopUpdateReceipt } from '@codeflowai/shared/desktop-update-receipt';
import { createDesktopApplication, type DesktopHost } from '../src/desktopApplication.js';
import type { ClientRuntime, ClientRuntimeExpectation } from '../src/clientRuntime.js';
import { loadOrCreateDeviceIdentity } from '../src/deviceIdentity.js';
import { readActivePointer } from '../src/releaseBundleCoordinator.js';
import * as download from '../src/releaseBundleDownload.js';
import { createUpdateFailureJournal } from '../src/updateFailureJournal.js';
import { createUpdateReceiptJournal } from '../src/updateReceiptJournal.js';

/** 用显式屏障观察在途请求，避免依赖时钟延迟。 */
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** 真签名、归档、传输和日志覆盖组合入口；仅壳窗口及 Client 调度使用替身。 */
async function fixture(t: test.TestContext) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-d12n-desktop-'));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const packageDir = path.join(dataDir, 'incoming');
  await fs.mkdir(path.join(packageDir, 'web'), { recursive: true });
  await fs.mkdir(path.join(packageDir, 'client', 'dist'), { recursive: true });
  await fs.writeFile(path.join(packageDir, 'web', 'index.html'), 'web');
  await fs.writeFile(path.join(packageDir, 'client', 'dist', 'index.cjs'), 'client');
  const archivePath = path.join(dataDir, 'bundle.tar.gz');
  await tar.c({ cwd: packageDir, file: archivePath, gzip: true, portable: true }, ['web', 'client']);
  const archive = await fs.readFile(archivePath);
  const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
  const webSha256 = hash(`index.html\0${hash('web')}\n`);
  const clientSha256 = hash(`dist/index.cjs\0${hash('client')}\n`);
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: 'available-release', version: '1.0.0',
    webVersion: '1.0.0', clientVersion: '1.0.0', protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 88,
    platform: process.platform, arch: process.arch, keyId: 'availability-fixture', archiveSha256: hash(archive), archiveSize: archive.length,
    webSha256, clientSha256, packageSha256: hash(`client\0${clientSha256}\nweb\0${webSha256}\n`),
    files: [{ path: 'client/dist/index.cjs', size: 6, sha256: hash('client') }, { path: 'web/index.html', size: 3, sha256: hash('web') }],
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-10-24T00:00:00.000Z',
  }, privateKey);
  const requests: string[] = [];
  const receipts: DesktopUpdateReceipt[] = [];
  const actions: string[] = [];
  const serverFailures: unknown[] = [];
  const control: {
    available: boolean;
    manifest: ReleaseBundleManifest;
    archiveStatus: number;
    failStage?: string;
    respond: (ack: Record<string, unknown>, response: http.ServerResponse) => Promise<void>;
  } = { available: true, manifest, archiveStatus: 200,
    respond: async (ack, response) => { response.end(JSON.stringify(ack)); } };
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const meta = readDesktopDeviceHeaders(request.rawHeaders);
      assert.equal(meta.deviceId, identity.deviceId);
      verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ ...meta, method: request.method!,
        url: request.url!, body, range: request.headers.range, ifMatch: request.headers['if-match'] as string | undefined }), meta.signature);
      requests.push(request.url!);
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/software/desktop/devices/register') {
        response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      } else if (request.url === '/api/software/desktop/release-availability') {
        await control.respond({ ok: true, available: control.available, deviceId: identity.deviceId, requestId: meta.requestId,
          ...(control.available ? { manifest: control.manifest } : {}) }, response);
      } else if (request.url === '/api/software/desktop/release') {
        response.end(JSON.stringify(control.manifest));
      } else if (request.url === `/api/software/desktop/releases/${manifest.releaseId}/archive`) {
        if (control.archiveStatus !== 200) {
          response.writeHead(control.archiveStatus, { 'retry-after': '7' });
          response.end(JSON.stringify({ ok: false, code: 'DESKTOP_UPDATE_UNAVAILABLE' }));
        } else {
          response.writeHead(200, { etag: `"${manifest.archiveSha256}"`, 'content-length': archive.length });
          response.end(archive);
        }
      } else if (request.url === `/api/software/desktop/releases/${manifest.releaseId}/switch-authorization`) {
        response.end(JSON.stringify({ ok: true, authorized: true, deviceId: identity.deviceId, requestId: meta.requestId,
          releaseId: manifest.releaseId, archiveSha256: manifest.archiveSha256 }));
      } else {
        assert.equal(request.url, '/api/software/desktop/update-receipts');
        const receipt = JSON.parse(body.toString('utf8')) as DesktopUpdateReceipt;
        assert.equal(meta.requestId, receipt.requestId);
        receipts.push(receipt);
        if (receipt.stage === control.failStage) {
          response.writeHead(503); response.end(JSON.stringify({ ok: false, code: 'DESKTOP_UPDATE_UNAVAILABLE' }));
        } else response.end(JSON.stringify({ ok: true, deviceId: receipt.deviceId, requestId: receipt.requestId, releaseId: receipt.releaseId,
          archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256 }));
      }
    })().catch(error => { serverFailures.push(error); response.writeHead(500); response.end('{}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = Object.assign(new EventEmitter(), { show() {}, focus() {}, hide() {}, destroy() {} });
  const host: DesktopHost = { createWindow: () => window, async loadWeb() { actions.push('web'); },
    createTray: () => ({ destroy() {} }), registerBridge: () => () => {}, quit() {} };
  /** 每个 Client 替身仅承接原健康与更新控制合同。 */
  const createRuntime = (_entry: string, expected?: ClientRuntimeExpectation): ClientRuntime => ({
    async start() {}, async waitReady() {}, async stop() {}, async drain() { actions.push('drain'); }, onEvent() { return () => {}; },
    async request(request) { actions.push(request.method); return { status: 200, body: { ok: true, hasRunningSessions: false } }; },
    snapshot() { return { status: 'ready', requestId: null, releaseId: expected?.releaseId ?? null, errorCode: null, pid: 123,
      health: { protocolVersion: 1, clientVersion: expected?.clientVersion ?? '1.0.0', dbSchemaVersion: 88, database: 'ready' } }; },
  });
  const trustedReleaseKeys = { 'availability-fixture': publicKey };
  /** 重启继续使用同一身份、活动指针和原日志。 */
  const createApp = () => createDesktopApplication({ dataDir, initialReleaseDir: dataDir, trustedReleaseKeys, host, createRuntime,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  let app = createApp();
  let started = false;
  t.after(async () => {
    if (started) await app.exit();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
    assert.deepEqual(serverFailures, []);
  });
  await app.start(); started = true; actions.length = 0;
  /** 生成仍由同一信任根签名的边界清单。 */
  const sign = (changes: Partial<ReleaseBundleManifest>) => {
    const { signature: _signature, ...payload } = { ...manifest, ...changes };
    return signReleaseBundleManifest(payload, privateKey);
  };
  return { get app() { return app; }, dataDir, identity, manifest, control, requests, receipts, actions, sign, trustedReleaseKeys,
    failures: () => createUpdateFailureJournal(dataDir).pending(identity.deviceId),
    /** 用原启动入口验证持久活动版本的同包判断。 */
    async restart() { await app.exit(); started = false; app = createApp(); await app.start(); started = true; actions.length = 0; },
  };
}

/** 正常空结果只能有登记和发现，不生成归档、暂存或阶段证据。 */
async function assertNoUpdateEffects(f: Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual(f.requests.filter(path => path !== '/api/software/desktop/devices/register'), ['/api/software/desktop/release-availability']);
  assert.ok(f.requests.filter(path => path === '/api/software/desktop/devices/register').length >= 1);
  assert.equal((await fs.readdir(f.dataDir)).includes('.staging'), false);
  assert.deepEqual(f.receipts, []);
  assert.deepEqual(await createUpdateReceiptJournal(f.dataDir).pending(f.identity.deviceId), []);
  assert.deepEqual(f.failures(), []);
  assert.deepEqual(f.actions, []);
  assert.equal(await readActivePointer(f.dataDir), null);
}

test('availability false returns null without download or failure effects and releases the lifecycle', async t => {
  const f = await fixture(t); f.control.available = false;
  assert.equal(await f.app.downloadReleaseUpdateIfAvailable({ requestId: crypto.randomUUID() }), null);
  await assertNoUpdateEffects(f);
  await f.app.flushReceipts();
});

test('installation version equality does not replace a trusted archive identity', async t => {
  const f = await fixture(t); const requestId = crypto.randomUUID();
  const result = await f.app.downloadReleaseUpdateIfAvailable({ requestId });
  await f.app.flushReceipts();
  assert.ok(result); assert.equal(result.requestId, requestId); assert.equal(result.manifest.archiveSha256, f.manifest.archiveSha256);
  assert.deepEqual(f.receipts.map(receipt => receipt.stage), ['received']);
  assert.equal(f.receipts[0]!.requestId, requestId); assert.deepEqual(f.failures(), []);
  assert.equal(await readActivePointer(f.dataDir), null); assert.deepEqual(f.actions, []);
});

for (const cold of [false, true]) test(`an exact active release returns null after ${cold ? 'cold startup' : 'the original switch'}`, async t => {
  const f = await fixture(t); const result = await f.app.downloadReleaseUpdateIfAvailable(); assert.ok(result);
  await f.app.applyRelease(result.directory, { requestId: result.requestId });
  await f.app.flushReceipts();
  assert.deepEqual(f.receipts.map(receipt => receipt.stage), ['received', 'verified', 'prepared', 'switched', 'healthy']);
  if (cold) await f.restart();
  f.requests.length = 0; f.actions.length = 0;
  const receipts = structuredClone(f.receipts); const staging = await fs.readdir(path.join(f.dataDir, '.staging'));
  assert.equal(await f.app.downloadReleaseUpdateIfAvailable(), null);
  assert.deepEqual(f.requests.filter(path => path !== '/api/software/desktop/devices/register'), ['/api/software/desktop/release-availability']);
  assert.ok(f.requests.filter(path => path === '/api/software/desktop/devices/register').length >= 1);
  assert.deepEqual(f.receipts, receipts); assert.deepEqual(f.failures(), []); assert.deepEqual(f.actions, []);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, '.staging')), staging);
});

test('a committed active pointer still skips the package when healthy receipt delivery failed', async t => {
  const f = await fixture(t); const result = await f.app.downloadReleaseUpdateIfAvailable(); assert.ok(result);
  f.control.failStage = 'healthy';
  await f.app.applyRelease(result.directory, { requestId: result.requestId });
  await assert.rejects(f.app.flushReceipts());
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  const receipts = structuredClone(f.receipts); const failures = f.failures(); f.requests.length = 0;
  assert.equal(await f.app.downloadReleaseUpdateIfAvailable(), null);
  assert.deepEqual(f.requests.filter(path => path !== '/api/software/desktop/devices/register'), ['/api/software/desktop/release-availability']);
  assert.ok(f.requests.filter(path => path === '/api/software/desktop/devices/register').length >= 1);
  assert.deepEqual(f.receipts, receipts); assert.deepEqual(f.failures(), failures);
});

test('same release ID with another signed archive fails without downloading', async t => {
  const f = await fixture(t); const result = await f.app.downloadReleaseUpdateIfAvailable(); assert.ok(result);
  await f.app.applyRelease(result.directory, { requestId: result.requestId });
  f.control.manifest = f.sign({ archiveSha256: 'a'.repeat(64) }); f.requests.length = 0;
  const requestId = crypto.randomUUID();
  await assert.rejects(() => f.app.downloadReleaseUpdateIfAvailable({ requestId }), { code: 'DESKTOP_RELEASE_CACHE_CONFLICT', requestId });
  assert.equal(f.requests.some(url => url.endsWith('/archive')), false);
  const failures = f.failures(); assert.equal(failures.length, 1);
  assert.equal(failures[0]!.errorCode, 'DESKTOP_RELEASE_FAILED'); assert.equal(failures[0]!.releaseId, f.manifest.releaseId);
});

const invalidManifests: Array<[string, string, (f: Awaited<ReturnType<typeof fixture>>) => ReleaseBundleManifest]> = [
  ['signature', 'DESKTOP_RELEASE_SIGNATURE_INVALID', f => ({ ...f.manifest, signature: `${f.manifest.signature[0] === 'A' ? 'B' : 'A'}${f.manifest.signature.slice(1)}` })],
  ['key', 'DESKTOP_RELEASE_UNTRUSTED_KEY', f => f.sign({ keyId: 'unknown-key' })],
  ['platform', 'DESKTOP_RELEASE_PLATFORM_MISMATCH', f => f.sign({ platform: process.platform === 'win32' ? 'darwin' : 'win32', arch: 'x64' })],
  ['expiry', 'DESKTOP_RELEASE_EXPIRED', f => f.sign({ expiresAt: '2026-01-02T00:00:00.000Z' })],
];
for (const [name, code, change] of invalidManifests) test(`an exact active identity cannot bypass ${name} validation`, async t => {
  const f = await fixture(t); const result = await f.app.downloadReleaseUpdateIfAvailable(); assert.ok(result);
  await f.app.applyRelease(result.directory, { requestId: result.requestId });
  f.control.manifest = change(f); f.requests.length = 0;
  const requestId = crypto.randomUUID();
  await assert.rejects(() => f.app.downloadReleaseUpdateIfAvailable({ requestId }), { code, requestId });
  assert.equal(f.requests.some(url => url.endsWith('/archive')), false);
  assert.equal(f.failures().length, 1); assert.equal(f.failures()[0]!.requestId, requestId);
});

const badAcks: Array<[string, (ack: Record<string, unknown>) => unknown]> = [
  ['foreign device', ack => ({ ...ack, deviceId: crypto.randomUUID() })],
  ['foreign attempt', ack => ({ ...ack, requestId: crypto.randomUUID() })],
  ['extra field', ack => ({ ...ack, path: 'PRIVATE_REMOTE_PATH' })],
  ['missing identity', ack => { const { deviceId: _device, ...rest } = ack; return rest; }],
  ['missing manifest', ack => { const { manifest: _manifest, ...rest } = ack; return rest; }],
  ['false with manifest', ack => ({ ...ack, available: false })],
  ['string availability', ack => ({ ...ack, available: 'true' })],
  ['string ok', ack => ({ ...ack, ok: 'true' })],
  ['array', ack => [ack]],
];
for (const [name, change] of badAcks) test(`malformed availability ACK ${name} explicitly fails once`, async t => {
  const f = await fixture(t); const requestId = crypto.randomUUID();
  f.control.respond = async (ack, response) => { response.end(JSON.stringify(change(ack))); };
  await assert.rejects(() => f.app.downloadReleaseUpdateIfAvailable({ requestId }), { code: 'DESKTOP_UPDATE_RESPONSE_INVALID', requestId });
  assert.equal(f.requests.some(url => url.endsWith('/archive')), false);
  assert.equal((await fs.readdir(f.dataDir)).includes('.staging'), false);
  assert.deepEqual(f.receipts, []); assert.equal(f.failures().length, 1);
  assert.equal(f.failures()[0]!.phase, 'discovery'); assert.equal(f.failures()[0]!.requestId, requestId);
  assert.equal(JSON.stringify(f.failures()).includes('PRIVATE_REMOTE_PATH'), false);
});

test('invalid availability manifest structure fails before any download side effect', async t => {
  const f = await fixture(t);
  f.control.respond = async (ack, response) => { response.end(JSON.stringify({ ...ack, manifest: { ...f.manifest, path: 'PRIVATE_MANIFEST' } })); };
  await assert.rejects(() => f.app.downloadReleaseUpdateIfAvailable(), { code: 'DESKTOP_RELEASE_MANIFEST_INVALID' });
  assert.equal(f.requests.some(url => url.endsWith('/archive')), false); assert.deepEqual(f.receipts, []);
  assert.equal(f.failures().length, 1); assert.equal(JSON.stringify(f.failures()).includes('PRIVATE_MANIFEST'), false);
});

test('availability validates requestId before registration or evidence writes', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.app.downloadReleaseUpdateIfAvailable({ requestId: 'invalid-attempt' }), { code: 'DESKTOP_UPDATE_RECEIPT_INVALID' });
  assert.deepEqual(f.requests, []); assert.deepEqual(f.failures(), []); assert.deepEqual(f.receipts, []);
});

test('availability owns one lifecycle operation until discovery finishes', async t => {
  const f = await fixture(t); const started = barrier(); const answer = barrier();
  f.control.available = false;
  f.control.respond = async (ack, response) => { started.release(); await answer.promise; response.end(JSON.stringify(ack)); };
  const pending = f.app.downloadReleaseUpdateIfAvailable(); await started.promise;
  await assert.rejects(() => f.app.downloadReleaseUpdateIfAvailable(), /DESKTOP_OPERATION_IN_PROGRESS/u);
  await assert.rejects(() => f.app.downloadAvailableReleaseBundle(), /DESKTOP_OPERATION_IN_PROGRESS/u);
  await assert.rejects(() => f.app.flushReceipts(), /DESKTOP_OPERATION_IN_PROGRESS/u);
  await assert.rejects(() => f.app.exit(), /DESKTOP_OPERATION_IN_PROGRESS/u);
  answer.release(); assert.equal(await pending, null); await f.app.flushReceipts(); await assertNoUpdateEffects(f);
});

test('a cancelled availability request explicitly fails and releases the lifecycle', async t => {
  const f = await fixture(t); const started = barrier(); const answer = barrier(); const controller = new AbortController();
  f.control.respond = async (ack, response) => { started.release(); await answer.promise; response.end(JSON.stringify(ack)); };
  const requestId = crypto.randomUUID();
  const pending = f.app.downloadReleaseUpdateIfAvailable({ requestId, signal: controller.signal });
  await started.promise; controller.abort(); answer.release();
  await assert.rejects(() => pending, { code: 'DESKTOP_UPDATE_TRANSPORT_FAILED', requestId });
  assert.equal(f.failures().length, 1); assert.equal(f.failures()[0]!.phase, 'discovery');
  assert.equal((await fs.readdir(f.dataDir)).includes('.staging'), false); await f.app.flushReceipts();
});

for (const active of [false, true]) test(`D12N-CANCEL-001 cancellation after JSON consumption rejects ${active ? 'the exact active release' : 'an empty result'}`, async t => {
  const f = await fixture(t);
  if (active) {
    const result = await f.app.downloadReleaseUpdateIfAvailable(); assert.ok(result);
    await f.app.applyRelease(result.directory, { requestId: result.requestId });
  } else f.control.available = false;
  f.requests.length = 0; f.actions.length = 0;
  const receipts = structuredClone(f.receipts);
  const staging = active ? await fs.readdir(path.join(f.dataDir, '.staging')) : null;
  const controller = new AbortController(); const reason = new Error('LATE_AVAILABILITY_CANCELLED');
  const originalFetch = globalThis.fetch;
  // 保留真实 HTTP 与设备签名，只在正文完全消费后插入确定的取消时点。
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith('/release-availability')) {
      const readJson = response.json.bind(response);
      response.json = async () => { const body = await readJson(); controller.abort(reason); return body; };
    }
    return response;
  });
  const requestId = crypto.randomUUID();
  await assert.rejects(() => f.app.downloadReleaseUpdateIfAvailable({ requestId, signal: controller.signal }), error => {
    assert.equal((error as { code?: string }).code, 'DESKTOP_RELEASE_DISCOVERY_FAILED');
    assert.equal((error as { requestId?: string }).requestId, requestId);
    assert.equal((error as { cause?: unknown }).cause, reason); return true;
  });
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(f.requests.filter(path => path !== '/api/software/desktop/devices/register'), ['/api/software/desktop/release-availability']);
  assert.ok(f.requests.filter(path => path === '/api/software/desktop/devices/register').length >= 1);
  assert.deepEqual(f.receipts, receipts); assert.deepEqual(f.actions, []);
  assert.equal(f.failures().length, 1); assert.equal(f.failures()[0]!.requestId, requestId);
  if (active) assert.deepEqual(await fs.readdir(path.join(f.dataDir, '.staging')), staging);
  else assert.equal((await fs.readdir(f.dataDir)).includes('.staging'), false);
  await f.app.flushReceipts();
});

test('download errors retain the original request context and existing download failure boundary', async t => {
  const f = await fixture(t); f.control.archiveStatus = 503; const requestId = crypto.randomUUID();
  await assert.rejects(() => f.app.downloadReleaseUpdateIfAvailable({ requestId }), error => {
    assert.equal((error as { requestId?: string }).requestId, requestId);
    const cause = (error as { cause?: { status?: number; retryAfter?: string } }).cause;
    assert.equal(cause?.status, 503); assert.equal(cause?.retryAfter, '7'); return true;
  });
  const failures = f.failures(); assert.equal(failures.length, 1); assert.equal(failures[0]!.phase, 'download');
  assert.equal(failures[0]!.errorCode, 'DESKTOP_RELEASE_FAILED'); assert.equal(failures[0]!.releaseId, f.manifest.releaseId); assert.deepEqual(f.receipts, []);
});

test('the same download attempt replays received and keeps the existing stage journal', async t => {
  const f = await fixture(t); const requestId = crypto.randomUUID(); f.control.failStage = 'received';
  await f.app.downloadReleaseUpdateIfAvailable({ requestId });
  await assert.rejects(f.app.flushReceipts());
  const original = await createUpdateReceiptJournal(f.dataDir).find(f.identity.deviceId, requestId, 'received'); assert.ok(original);
  f.control.failStage = undefined;
  const result = await f.app.downloadReleaseUpdateIfAvailable({ requestId }); assert.ok(result);
  await f.app.flushReceipts();
  assert.equal(f.requests.filter(url => url.endsWith('/archive')).length, 1);
  assert.deepEqual(f.receipts, [original, original]);
  await f.app.applyRelease(result.directory, { requestId });
  await f.app.flushReceipts();
  assert.equal(f.receipts.every(receipt => receipt.requestId === requestId), true);
  assert.deepEqual(f.receipts.slice(1).map(receipt => receipt.stage), ['received', 'verified', 'prepared', 'switched', 'healthy']);
});

test('the strict discovery entry still downloads the exact active release', async t => {
  const f = await fixture(t); const result = await f.app.downloadReleaseUpdateIfAvailable(); assert.ok(result);
  await f.app.applyRelease(result.directory, { requestId: result.requestId }); f.requests.length = 0;
  const strict = await f.app.downloadAvailableReleaseBundle();
  await f.app.flushReceipts();
  assert.equal(strict.manifest.releaseId, f.manifest.releaseId);
  assert.equal(f.requests.includes('/api/software/desktop/release'), true);
  assert.equal(f.requests.includes('/api/software/desktop/release-availability'), false);
  assert.equal(f.receipts.at(-1)!.stage, 'received');
});

test('the extracted manifest verifier performs no filesystem or transport work', async t => {
  const f = await fixture(t); const before = await fs.readdir(f.dataDir); const requestId = crypto.randomUUID();
  const result = download.verifyDownloadManifest({ manifestBytes: Buffer.from(JSON.stringify(f.manifest)), trustedReleaseKeys: f.trustedReleaseKeys, requestId });
  assert.equal(result.releaseId, f.manifest.releaseId); assert.equal(result.archiveSha256, f.manifest.archiveSha256);
  assert.deepEqual(await fs.readdir(f.dataDir), before); assert.deepEqual(f.requests, []); assert.deepEqual(f.failures(), []);
});
