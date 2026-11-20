import crypto from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { compareNumericVersion, type ShellReleaseManifest } from "@codeflowai/shared";
import { assertDesktopDeviceIdentity, desktopDevicePublicKeySha256, readDesktopDevicePlatform } from "@codeflowai/shared/desktop-device-auth";
import type { TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import { verifyShellReleaseSignature } from "@codeflowai/shared/desktop-shell-release-signing";
import { readDeviceIdentity, type DeviceIdentity } from "./deviceIdentity.js";
import { createDesktopUpdateTransport } from "./updateTransport.js";
import { createShellUpdateAttemptNetworkAdapter, isShellUpdateHandoffAttempt, type ShellUpdateAttemptStore, type ShellUpdatePreparationAttempt, type ShellUpdateHandoffAttempt, type ShellUpdateTarget } from "./shellUpdateAttempt.js";
import { createUpdateNetworkRetry, preserveUpdateNetworkCancellation, type UpdateNetworkAction, type UpdateNetworkEvidence } from "./updateNetworkRetry.js";
import { downloadShellInstaller, recoverShellInstaller, type DownloadedShellInstaller } from "./shellInstallerDownload.js";

type Registration = { ok: true; deviceId: string; publicKeySha256: string };
type Discovery = { ok: true; available: false; deviceId: string; requestId: string }
  | { ok: true; available: true; deviceId: string; requestId: string; manifest: ShellReleaseManifest };
export type ShellDiscovery = Discovery;
export type ShellUpdateDiscoveryResult = { status: "no-update"; attempt: ShellUpdatePreparationAttempt; reason?: "none" | "same" }
  | { status: "target"; attempt: ShellUpdatePreparationAttempt; manifest: ShellReleaseManifest };
type Directory = { directory: string; identity: BigIntStats };
type NetworkInput = { store: ShellUpdateAttemptStore; identity: DeviceIdentity; configuredServerOrigin: string;
  currentShellVersion?: string;
  discovery?: (requestId: string) => Promise<ShellDiscovery>;
  trustedKeys: TrustedReleaseKeys; signal: AbortSignal;
  onRetry: (context: { retry: number; delayMs: number; error: unknown }) => void | Promise<void>;
  onExhausted?: (error: unknown) => void };
type SelectedAttempt = (ShellUpdatePreparationAttempt | ShellUpdateHandoffAttempt) & { target: ShellUpdateTarget };
type SwitchAck = { ok: true; authorized: true; deviceId: string; requestId: string; shellId: string; installerSha256: string; manifestSha256: string };
const MAX_BYTES = 16 * 1024 * 1024 + 65_536;
const REGISTER = "/api/software/desktop/devices/register";
const DISCOVER = "/api/software/desktop/shell-release-availability";

/** 新登记协议固定 8 字段；壳更新不带运行版本，既保留服务端已知值，也让重试动作摘要跨壳版本稳定。 */
function registrationBody(identity: { deviceId: string; publicKeyBase64: string }, platform: ReturnType<typeof readDesktopDevicePlatform>) {
  return { ...identity, ...platform, shellVersion: "unknown", webVersion: "unknown", clientVersion: "unknown", releaseId: "unknown" };
}

/** 同一原 attempt 驱动登记、发现、完整安装器与本次切换资格；不安装、不激活或另起周期。 */
export function createShellUpdateNetwork(input: NetworkInput) {
  let running = false;
  const api = {
    /** 按唯一槽恢复，不从登记重放；完整发现验证后只绑定一次目标或正常终结。 */
    async prepare(): Promise<ShellUpdateDiscoveryResult> {
      if (running) throw failure("DESKTOP_SHELL_NETWORK_BUSY");
      running = true;
      let requestId: string | undefined, actionKey: string | undefined, shellId: string | undefined;
      try {
        input.signal.throwIfAborted();
        const initial = await current(input.store); requestId = initial.requestId;
        const platform = readDesktopDevicePlatform(process.platform, process.arch);
        if (platform.platform !== "win32" || platform.arch !== "x64") throw failure("DESKTOP_SHELL_NETWORK_PLATFORM_UNSUPPORTED");
        const identity = { deviceId: input.identity.deviceId, publicKeyBase64: input.identity.publicKeyBase64 };
        assertDesktopDeviceIdentity(identity.deviceId);
        const publicKeySha256 = desktopDevicePublicKeySha256(identity.publicKeyBase64), actual = await readDeviceIdentity(initial.dataDir);
        if (actual.deviceId !== identity.deviceId || actual.publicKeyBase64 !== identity.publicKeyBase64) throw failure("DESKTOP_DEVICE_IDENTITY_CHANGED");
        const transport = createDesktopUpdateTransport({ dataDir: initial.dataDir, identity: { ...identity, createdAt: actual.createdAt },
          configuredServerOrigin: input.configuredServerOrigin });
        const origin = input.configuredServerOrigin;
        const registrationPayload = registrationBody(identity, platform);
        const context = { origin, deviceId: identity.deviceId, publicKeySha256, requestId };
        const registrationIdentity = requestIdentity(context, "shell-register", "POST", REGISTER, registrationPayload);
        const discoveryIdentity = requestIdentity(context, "shell-discover", "GET", DISCOVER);
        const slot = initial.network;
        const later = slot !== null && isLaterAction(slot.actionKey);
        if (slot && ![registrationIdentity.actionKey, discoveryIdentity.actionKey].includes(slot.actionKey) && !later) throw failure("DESKTOP_SHELL_NETWORK_ACTION_UNSUPPORTED");
        const expectedIdentity = slot?.actionKey === registrationIdentity.actionKey ? registrationIdentity : later
          ? selectedIdentity(context, initial, slot!.actionKey) : discoveryIdentity;
        if (slot && slot.requestSha256 !== expectedIdentity.requestSha256) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
        if ((initial.target !== null || initial.phase === "no-update") && slot?.actionKey !== discoveryIdentity.actionKey && !later) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
        const directories = await resultDirectories(initial.dataDir, requestId);
        const retry = createUpdateNetworkRetry({ signal: input.signal, onRetry: input.onRetry, onExhausted: input.onExhausted,
          durable: createShellUpdateAttemptNetworkAdapter(input.store) });

        /** 严格 ACK 保留真实响应，不能仅根据 HTTP 200 或登记输入推造成功。 */
        const registration = (value: unknown): Registration => registrationValue(value, identity.deviceId, publicKeySha256);
        /** true 必须先完整验签、规范字段与有效时间，再允许同壳判断或目标绑定。 */
        const discovery = (value: unknown): Discovery => {
          const result = discoveryValue(value, identity.deviceId, requestId!, input.trustedKeys);
          if (result.available) shellId = result.manifest.shellId;
          return result;
        };
        const registrationAction = resultAction({ ...context, ...registrationIdentity }, "registration.json", "device-registration", registration, directories);
        const discoveryAction = resultAction({ ...context, ...discoveryIdentity }, "discovery.json", "shell-manifest", discovery, directories);
        if (slot === null || slot.actionKey === registrationIdentity.actionKey) {
          actionKey = registrationIdentity.actionKey;
          await retry.run(async () => registration(await readResponse(await transport.requestRaw({ method: "POST", path: REGISTER,
            body: registrationPayload, requestId, signal: input.signal }), input.signal, requestId!)), registrationAction);
        } else {
          actionKey = registrationIdentity.actionKey;
          if ((await registrationAction.recoverResult(null)).status !== "verified") throw failure("DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN");
        }
        actionKey = discoveryIdentity.actionKey;
        let found: Discovery;
        if (initial.phase === "no-update" || later) {
          if (initial.phase === "no-update" && slot?.status !== "succeeded") throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
          const recovered = await discoveryAction.recoverResult(later ? null : slot!.status === "succeeded" ? slot!.evidence : null);
          if (recovered.status !== "verified") throw failure("DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN");
          found = recovered.value;
        } else found = await retry.run(async () => discovery(input.discovery ? await input.discovery(requestId!)
          : await readResponse(await transport.requestRaw({ method: "GET", path: DISCOVER,
            requestId, signal: input.signal }), input.signal, requestId!)), discoveryAction);
        input.signal.throwIfAborted();
        const attempt = await current(input.store);
        if (attempt.requestId !== requestId || ["schemaVersion", "installationDir", "dataDir", "userDataDir", "sessionDataDir", "originalState", "binding",
          ...(initial.schemaVersion === 5 ? ["preparationMains", "owned", "ownedLifecycle"] : [])]
          .some(key => JSON.stringify((attempt as unknown as Record<string, unknown>)[key]) !== JSON.stringify((initial as unknown as Record<string, unknown>)[key]))) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
        // 是否更新只比较独立壳版本；已有目标仍沿原尝试恢复，不重新选择版本。
        let newer = false;
        if (found.available && attempt.target === null) {
          if (!/^\d+(?:\.\d+){1,3}$/u.test(input.currentShellVersion ?? "") || !/^\d+(?:\.\d+){1,3}$/u.test(found.manifest.version)) {
            throw failure("DESKTOP_SHELL_VERSION_INVALID");
          }
          const currentVersion = input.currentShellVersion!.split(".").length === 2 ? `${input.currentShellVersion}.0` : input.currentShellVersion!;
          const targetVersion = found.manifest.version.split(".").length === 2 ? `${found.manifest.version}.0` : found.manifest.version;
          newer = compareNumericVersion(targetVersion, currentVersion) > 0;
        }
        if (!found.available || attempt.target === null && !newer) {
          if (attempt.target !== null) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
          const terminal = attempt.phase === "no-update" ? attempt : await input.store.replace(attempt, { ...attempt, revision: attempt.revision + 1, phase: "no-update" }) as ShellUpdatePreparationAttempt;
          input.signal.throwIfAborted(); return { status: "no-update", attempt: terminal, reason: found.available ? "same" : "none" };
        }
        if (found.manifest.shellId === attempt.originalState.activeShellId) throw failure("DESKTOP_SHELL_VERSION_ID_CONFLICT");
        if (attempt.phase !== "preparing") throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
        const manifest = found.manifest, target = { shellId: manifest.shellId, manifestSha256: sha256(JSON.stringify(manifest)),
          installerSha256: manifest.installerSha256, installerSize: manifest.installerSize };
        if (attempt.target !== null && JSON.stringify(attempt.target) !== JSON.stringify(target)) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
        const bound = attempt.target !== null ? attempt : await input.store.replace(attempt, { ...attempt, revision: attempt.revision + 1, target,
          candidateState: { activeShellId: target.shellId, previousShellId: attempt.originalState.activeShellId, baselineShellId: attempt.originalState.baselineShellId } }) as ShellUpdatePreparationAttempt;
        input.signal.throwIfAborted(); return { status: "target", attempt: bound, manifest };
      } catch (cause) {
        throw Object.assign(new Error("DESKTOP_SHELL_DISCOVERY_FAILED", { cause }), { code: cause instanceof Error && "code" in cause ? cause.code : "DESKTOP_SHELL_DISCOVERY_FAILED",
          requestId: requestId ?? (cause instanceof Error && "requestId" in cause ? cause.requestId : undefined),
          deviceId: input.identity.deviceId, actionKey, shellId });
      } finally { running = false; }
    },
    /** 仅复验已发布准备工件供 helper 使用；不联网、不推进槽或制造切换资格。 */
    async readPrepared(): Promise<DownloadedShellInstaller & { attempt: SelectedAttempt; manifest: ShellReleaseManifest }> {
      return await readPrepared(false);
    },
    /** 已准入或显式恢复只读既有签名工件；过期不撤销已安装事实，不发送或预约网络动作。 */
    async readInstalledPrepared(): Promise<DownloadedShellInstaller & { attempt: SelectedAttempt; manifest: ShellReleaseManifest }> {
      return await readPrepared(true);
    },
    /** 一个原 durable 动作包含下载、完整验签与关闭；已进入授权槽仅复验安装器，不倒退槽。 */
    async downloadInstaller(): Promise<DownloadedShellInstaller> {
      const prepared = await api.prepare();
      if (prepared.status !== "target") throw failure("DESKTOP_SHELL_INSTALLER_TARGET_REQUIRED");
      if (running) throw failure("DESKTOP_SHELL_NETWORK_BUSY"); running = true;
      let requestId: string | undefined, shellId: string | undefined;
      try {
        const context = await selectedContext(input, false); requestId = context.attempt.requestId; shellId = context.manifest.shellId;
        const { attempt, manifest, directories, transport, retry, base } = context;
        const identity = selectedIdentity(base, attempt, "shell-installer");
        const installerInput = { directory: directories.at(-1)!.directory, manifest, trustedKeys: input.trustedKeys, requestId, signal: input.signal };
        /** 结果只复验真实完整安装器；partial 永不晋升为已完成证据。 */
        const recover = async (evidence: UpdateNetworkEvidence | null) => {
          await assertDirectories(directories);
          const observed = await recoverShellInstaller(installerInput);
          if (observed.status === "unknown") return observed;
          const proof = { kind: "shell-installer" as const, sha256: observed.value.sha256 };
          if (evidence && (evidence.kind !== proof.kind || evidence.sha256 !== proof.sha256)) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
          await assertDirectories(directories); input.signal.throwIfAborted();
          return { status: "verified" as const, value: observed.value, evidence: proof };
        };
        if (isAuthorization(attempt.network!.actionKey)) {
          const recovered = await recover(null);
          if (recovered.status !== "verified") throw failure("DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN");
          await assertSelectedUnchanged(input.store, attempt); input.signal.throwIfAborted();
          return recovered.value;
        }
        const value = await retry.run(async () => await downloadShellInstaller({ ...installerInput, transport: {
          /** 非 2xx 仍走原有界 JSON/清理边界，二进制成功正文交下载器唯一 reader。 */
          async request(request) { const response = await transport.requestRaw(request);
            if (!response.ok) await readResponse(response, input.signal, requestId!); return response; }
        } }), { ...identity, recoverResult: recover,
          /** downloader 已发布后再物理复验，外层直到此处完成才持久成功槽。 */
          async persistResult(value) { const recovered = await recover(null);
            if (recovered.status !== "verified" || JSON.stringify(recovered.value) !== JSON.stringify(value)) throw failure("DESKTOP_SHELL_NETWORK_RESULT_CHANGED");
            return recovered.evidence; } });
        await assertSelectedUnchanged(input.store, attempt); input.signal.throwIfAborted(); return value;
      } catch (cause) { throw contextualError(cause, input.identity.deviceId, requestId, "shell-installer", shellId); }
      finally { running = false; }
    },
    /** 只返回本活调用真实发送并完整验证的肯定结果；历史 positive 必须先结清再新取当前资格。 */
    async authorizeSwitch(): Promise<SwitchAck> {
      if (running) throw failure("DESKTOP_SHELL_NETWORK_BUSY"); running = true;
      let requestId: string | undefined, actionKey: string | undefined, shellId: string | undefined;
      try {
        let context = await selectedContext(input, true); requestId = context.attempt.requestId; shellId = context.manifest.shellId;
        const { manifest, directories, transport, retry, base } = context;
        const installer = await recoverShellInstaller({ directory: directories.at(-1)!.directory, manifest, trustedKeys: input.trustedKeys, requestId, signal: input.signal });
        if (installer.status !== "verified") throw failure("DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN");
        /** 严格比对本次固定三摘要，否定响应是失败并停止后续副作用。 */
        const validate = (value: unknown): SwitchAck => switchValue(value, context.attempt.target, base.deviceId, requestId!);
        /** 每个原 revision 动作有独立真实 ACK，不增加可激活缓存位。 */
        const run = async (identity: { actionKey: string; requestSha256: string }) => {
          actionKey = identity.actionKey;
          const result = resultAction({ ...base, ...identity }, `authorization-${identity.actionKey.slice("shell-authorize:".length)}.json`, "shell-switch-authorization", validate, directories);
          let sent = false;
          const value = await retry.run(async () => {
            assertManifestCurrent(manifest);
            sent = true;
            return validate(await readResponse(await transport.requestRaw({ method: "GET", path: authorizationPath(context.attempt.target), requestId, signal: input.signal }), input.signal, requestId!));
          }, result);
          return { value, sent };
        };
        const slot = context.attempt.network!;
        if (isAuthorization(slot.actionKey)) {
          const previous = await run(selectedIdentity(base, context.attempt, slot.actionKey));
          if (previous.sent) { assertManifestCurrent(manifest); await assertSelectedUnchanged(input.store, context.attempt); input.signal.throwIfAborted(); return previous.value; }
          context = await selectedContext(input, true);
        } else if (slot.actionKey !== "shell-installer" || slot.status !== "succeeded") throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
        const identity = selectedIdentity(base, context.attempt, `shell-authorize:${context.attempt.revision}`);
        const current = await run(identity);
        if (!current.sent) throw failure("DESKTOP_SHELL_SWITCH_CURRENT_RESPONSE_REQUIRED");
        assertManifestCurrent(manifest); await assertSelectedUnchanged(input.store, context.attempt); input.signal.throwIfAborted(); return current.value;
      } catch (cause) { throw contextualError(cause, input.identity.deviceId, requestId, actionKey, shellId); }
      finally { running = false; }
    }
  };
  return api;

  /** 两种只读证明共用完整缓存与安装器核验；installed仅改变时效及阶段门禁。 */
  async function readPrepared(installed: boolean): Promise<DownloadedShellInstaller & { attempt: SelectedAttempt; manifest: ShellReleaseManifest }> {
    if (running) throw failure("DESKTOP_SHELL_NETWORK_BUSY"); running = true;
    let requestId: string | undefined, shellId: string | undefined;
    try {
      const context = await selectedContext(input, true, installed); requestId = context.attempt.requestId; shellId = context.manifest.shellId;
      const observed = await recoverShellInstaller({ directory: context.directories.at(-1)!.directory, manifest: context.manifest,
        trustedKeys: input.trustedKeys, requestId, signal: input.signal, ...(installed ? { installed: true as const } : {}) });
      if (observed.status !== "verified") throw failure("DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN");
      await assertDirectories(context.directories); await assertSelectedUnchanged(input.store, context.attempt, true); input.signal.throwIfAborted();
      return { attempt: context.attempt, manifest: context.manifest, ...observed.value };
    } catch (cause) { throw contextualError(cause, input.identity.deviceId, requestId, installed ? "read-installed-prepared" : "read-prepared", shellId); }
    finally { running = false; }
  }
}

/** 后续动作只复验既有真实发现，不重新登记或把当前槽退回旧动作。 */
async function selectedContext(input: NetworkInput, allowHandoff: boolean, installed = false) {
  input.signal.throwIfAborted();
  const observed = await input.store.read();
  if (!observed || observed.target === null || (installed
    ? !isShellUpdateHandoffAttempt(observed) || observed.admission === null && !observed.recovery
    : !((observed.schemaVersion === 2 || observed.schemaVersion === 5 && !isShellUpdateHandoffAttempt(observed)) && observed.phase === "preparing"
      || allowHandoff && isShellUpdateHandoffAttempt(observed) && !observed.recovery && observed.phase === "handoff"
      && observed.selectedMain === null && observed.admission === null && observed.terminalEvidence === null))) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
  const attempt = observed as SelectedAttempt, requestId = attempt.requestId;
  const platform = readDesktopDevicePlatform(process.platform, process.arch);
  if (platform.platform !== "win32" || platform.arch !== "x64") throw failure("DESKTOP_SHELL_NETWORK_PLATFORM_UNSUPPORTED");
  const identity = { deviceId: input.identity.deviceId, publicKeyBase64: input.identity.publicKeyBase64 };
  assertDesktopDeviceIdentity(identity.deviceId);
  const publicKeySha256 = desktopDevicePublicKeySha256(identity.publicKeyBase64), actual = await readDeviceIdentity(attempt.dataDir);
  if (identity.deviceId !== actual.deviceId || identity.publicKeyBase64 !== actual.publicKeyBase64) throw failure("DESKTOP_DEVICE_IDENTITY_CHANGED");
  const transport = createDesktopUpdateTransport({ dataDir: attempt.dataDir, identity: actual, configuredServerOrigin: input.configuredServerOrigin });
  const base = { origin: input.configuredServerOrigin, deviceId: identity.deviceId, publicKeySha256, requestId };
  const slot = attempt.network;
  if (!slot || !["shell-discover", "shell-installer"].includes(slot.actionKey) && !isAuthorization(slot.actionKey)) throw failure("DESKTOP_SHELL_NETWORK_ACTION_UNSUPPORTED");
  const expected = slot.actionKey === "shell-discover" ? requestIdentity(base, "shell-discover", "GET", DISCOVER) : selectedIdentity(base, attempt, slot.actionKey);
  if (expected.requestSha256 !== slot.requestSha256) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
  const directories = await resultDirectories(attempt.dataDir, requestId, false);
  const registration = resultAction({ ...base, ...requestIdentity(base, "shell-register", "POST", REGISTER,
    registrationBody(identity, platform)) },
    "registration.json", "device-registration", value => registrationValue(value, identity.deviceId, publicKeySha256), directories);
  if ((await registration.recoverResult(null)).status !== "verified") throw failure("DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN");
  const discovery = resultAction({ ...base, ...requestIdentity(base, "shell-discover", "GET", DISCOVER) }, "discovery.json", "shell-manifest",
    value => discoveryValue(value, identity.deviceId, requestId, input.trustedKeys, !installed), directories);
  const recovered = await discovery.recoverResult(slot.actionKey === "shell-discover" && slot.status === "succeeded" ? slot.evidence : null);
  if (recovered.status !== "verified" || !recovered.value.available) throw failure("DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN");
  const manifest = recovered.value.manifest;
  const target = { shellId: manifest.shellId, manifestSha256: sha256(JSON.stringify(manifest)), installerSha256: manifest.installerSha256, installerSize: manifest.installerSize };
  if (JSON.stringify(target) !== JSON.stringify(attempt.target)) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
  input.signal.throwIfAborted();
  const retry = createUpdateNetworkRetry({ signal: input.signal, onRetry: input.onRetry, onExhausted: input.onExhausted, durable: createShellUpdateAttemptNetworkAdapter(input.store) });
  return { attempt, base, transport, directories, retry, manifest };
}

/** 固定目标和明确续传策略进入逻辑摘要；变化的真实 Range 仍由原 signer 单独精确绑定。 */
function selectedIdentity(base: object, attempt: ShellUpdatePreparationAttempt | ShellUpdateHandoffAttempt, actionKey: string) {
  if (attempt.target === null) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
  if (actionKey === "shell-installer") return requestIdentity({ ...base, target: attempt.target, resumePolicy: "known-prefix-v1" }, actionKey, "GET", `/api/software/desktop/shell-releases/${attempt.target.shellId}/installer`);
  if (!isAuthorization(actionKey) || Number(actionKey.slice("shell-authorize:".length)) > attempt.revision) throw failure("DESKTOP_SHELL_NETWORK_ACTION_UNSUPPORTED");
  return requestIdentity({ ...base, target: attempt.target }, actionKey, "GET", authorizationPath(attempt.target));
}

/** 后续只认精确已实现动作；任意前缀或未来动作不能倒退/绕过原槽。 */
function isLaterAction(actionKey: string): boolean { return actionKey === "shell-installer" || isAuthorization(actionKey); }
/** 授权动作后缀直接来自原 revision，严格排除别名、越界整数和非规范数字。 */
function isAuthorization(actionKey: string): boolean { return /^shell-authorize:(0|[1-9][0-9]{0,15})$/u.test(actionKey) && Number.isSafeInteger(Number(actionKey.slice("shell-authorize:".length))); }
/** 路径只从原合同已校验的固定目标构造。 */
function authorizationPath(target: ShellUpdateTarget): string { return `/api/software/desktop/shell-releases/${target.shellId}/switch-authorization`; }

/** 后续网络不能顺带采用其他本地绑定、目标、进程选择或准入事实。 */
async function assertSelectedUnchanged(store: ShellUpdateAttemptStore, expected: SelectedAttempt, readonly = false): Promise<void> {
  const actual = await store.read();
  const keys = ["schemaVersion", "requestId", "installationDir", "dataDir", "userDataDir", "sessionDataDir", "originalState", "candidateState", "binding", "target", "phase",
    ...(isShellUpdateHandoffAttempt(expected) ? ["continuationId", "oldMain", "helper", "selectedMain", "admission", "terminalEvidence", "recovery", "owned"] : []),
    ...(expected.schemaVersion === 4 || expected.schemaVersion === 5 ? ["owned", "ownedLifecycle", ...(isShellUpdateHandoffAttempt(expected) ? ["recoveryHistory"] : []),
      ...(readonly ? ["revision", "controlRevision", "network", "retriesUsed"] : [])] : []),
    ...(expected.schemaVersion === 5 ? ["preparationMains", ...(isShellUpdateHandoffAttempt(expected) ? ["handoffRevision"] : [])] : [])];
  if (!actual || keys.some(key => JSON.stringify((actual as unknown as Record<string, unknown>)[key]) !== JSON.stringify((expected as unknown as Record<string, unknown>)[key]))) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
}

/** 严格真实 ACK，不从请求输入或 HTTP 成功状态推造登记完成。 */
function registrationValue(value: unknown, deviceId: string, publicKeySha256: string): Registration {
  const record = fields(value, ["ok", "deviceId", "publicKeySha256"]);
  if (record.ok !== true || record.deviceId !== deviceId || record.publicKeySha256 !== publicKeySha256) throw failure("DESKTOP_DEVICE_REGISTRATION_ACK_INVALID");
  return { ok: true, deviceId, publicKeySha256 };
}

/** false 也严格信封，true 每次完整验签及当前时效核对。 */
function discoveryValue(value: unknown, deviceId: string, requestId: string, trustedKeys: TrustedReleaseKeys, requireFresh = true): Discovery {
  const available = fields(value).available, record = fields(value, ["ok", "available", "deviceId", "requestId", ...(available === true ? ["manifest"] : [])]);
  if (record.ok !== true || typeof available !== "boolean" || record.deviceId !== deviceId || record.requestId !== requestId) throw failure("DESKTOP_SHELL_DISCOVERY_RESPONSE_INVALID");
  if (!available) return { ok: true, available, deviceId, requestId };
  const manifest = verifyShellReleaseSignature(record.manifest, trustedKeys); if (requireFresh) assertManifestCurrent(manifest);
  return { ok: true, available, deviceId, requestId, manifest };
}

/** 只接受当前有效的固定已验签清单，等待或本地预检后不得沿用过期资格。 */
function assertManifestCurrent(manifest: ShellReleaseManifest): void {
  const now = Date.now();
  if (Date.parse(manifest.createdAt) > now || now >= Date.parse(manifest.expiresAt)) throw failure("DESKTOP_SHELL_MANIFEST_TIME_INVALID");
}

/** 业务否定先严格确认身份；肯定必须精确匹配原已绑定三摘要。 */
function switchValue(value: unknown, target: ShellUpdateTarget, deviceId: string, requestId: string): SwitchAck {
  const authorized = fields(value).authorized;
  const record = fields(value, ["ok", "authorized", "deviceId", "requestId", "shellId", ...(authorized === true ? ["installerSha256", "manifestSha256"] : [])]);
  if (record.ok !== true || typeof authorized !== "boolean" || record.deviceId !== deviceId || record.requestId !== requestId || record.shellId !== target.shellId) throw failure("DESKTOP_SHELL_SWITCH_RESPONSE_INVALID");
  if (!authorized) throw failure("DESKTOP_SHELL_SWITCH_NOT_AUTHORIZED");
  if (record.installerSha256 !== target.installerSha256 || record.manifestSha256 !== target.manifestSha256) throw failure("DESKTOP_SHELL_SWITCH_TARGET_CHANGED");
  return { ok: true, authorized: true, deviceId, requestId, shellId: target.shellId, installerSha256: target.installerSha256, manifestSha256: target.manifestSha256 };
}

/** 原因及安全业务标识交回实际处理 owner；无降级或重复日志。 */
function contextualError(cause: unknown, deviceId: string, requestId?: string, actionKey?: string, shellId?: string): Error {
  return Object.assign(new Error("DESKTOP_SHELL_NETWORK_FAILED", { cause }), { code: cause instanceof Error && "code" in cause ? cause.code : "DESKTOP_SHELL_NETWORK_FAILED", deviceId,
    requestId: requestId ?? (cause instanceof Error && "requestId" in cause ? cause.requestId : undefined), actionKey, shellId });
}

/** 只接受完整准备2/5，不猜事实或自动复活失败周期。 */
async function current(store: ShellUpdateAttemptStore): Promise<ShellUpdatePreparationAttempt> {
  const value = await store.read();
  if (!value || !(value.schemaVersion === 2 || value.schemaVersion === 5 && !isShellUpdateHandoffAttempt(value))
    || !["preparing", "no-update"].includes(value.phase)) throw Object.assign(failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT"), { requestId: value?.requestId });
  return value;
}

/** 稳定逻辑材料不含每次变化的签名时间，也不额外保存网络预算。 */
function requestIdentity(context: object, actionKey: string, method: "GET" | "POST", requestPath: string, body?: unknown) {
  return { actionKey, requestSha256: sha256(JSON.stringify({ protocol: "codeflow.shell-network.v1", ...context, actionKey, method,
    path: requestPath, bodySha256: sha256(body === undefined ? "" : JSON.stringify(body)) })) };
}

/** 正文按实际字节有界读取；取消/释放完成后才允许外层完成或预约网络重试。 */
async function readResponse(response: Response, signal: AbortSignal, requestId: string): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw failure("DESKTOP_SHELL_DISCOVERY_RESPONSE_INVALID");
  let failed = false, primary: unknown, done = false, readFailure: { cause: unknown } | undefined;
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (cause) { readFailure = { cause }; throw Object.assign(new Error("DESKTOP_UPDATE_RESPONSE_INVALID", { cause: preserveUpdateNetworkCancellation(cause, signal) }), { code: "DESKTOP_UPDATE_RESPONSE_INVALID" }); }
      if (chunk.done) { done = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw failure("DESKTOP_SHELL_DISCOVERY_RESPONSE_TOO_LARGE");
      chunks.push(Buffer.from(chunk.value));
    }
    signal.throwIfAborted();
    const value = parseJson(Buffer.concat(chunks, size));
    if (!response.ok) {
      const record = fields(value);
      if (record.ok !== false || typeof record.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(record.code)
        || Object.keys(record).some(key => !["ok", "code", "message", "details"].includes(key))
        || Object.hasOwn(record, "message") && typeof record.message !== "string") throw failure("DESKTOP_SHELL_NETWORK_HTTP_RESPONSE_INVALID");
      throw Object.assign(new Error("DESKTOP_UPDATE_HTTP_FAILED", { cause: Object.assign(new Error("DESKTOP_SHELL_NETWORK_REMOTE_FAILED"), { code: record.code }) }), { code: "DESKTOP_UPDATE_HTTP_FAILED", requestId,
        status: response.status, retryAfter: response.headers.get("retry-after"), remoteCode: record.code });
    }
    return value;
  } catch (cause) { failed = true; primary = cause; throw cause; }
  finally {
    const cleanup: unknown[] = [];
    if (!done) { try { await reader.cancel(); } catch (cause) {
      // errored reader 会重复交还同一根因，只去重同一 Error 实体；独立清理副因完整保留。
      if (!readFailure || !(cause instanceof Error) || cause !== readFailure.cause) cleanup.push(cause);
    } }
    try { reader.releaseLock(); } catch (cause) { cleanup.push(cause); }
    if (cleanup.length) throw new AggregateError([...(failed ? [primary] : []), ...cleanup], "DESKTOP_SHELL_DISCOVERY_READER_CLOSE_FAILED");
  }
}

/** 工件仅保存真实响应与不可变请求绑定；规范 bytes 本身就是唯一槽引用的证据。 */
function resultAction<T>(context: { origin: string; deviceId: string; publicKeySha256: string; requestId: string; actionKey: string; requestSha256: string },
  filename: string, kind: UpdateNetworkEvidence["kind"], validate: (value: unknown) => T, directories: Directory[]): UpdateNetworkAction<T> {
  const target = path.join(directories.at(-1)!.directory, filename);
  /** 完整工件严格复验，不存在才 unknown；破损、链接或错上下文一律显式失败。 */
  async function recover(evidence: UpdateNetworkEvidence | null) {
    await assertDirectories(directories);
    const bytes = await readResult(target);
    if (bytes === null) return { status: "unknown" as const };
    const record = fields(parseJson(bytes), ["schemaVersion", ...Object.keys(context), "response"]);
    if (record.schemaVersion !== 1 || Object.entries(context).some(([key, value]) => record[key] !== value)) throw failure("DESKTOP_SHELL_NETWORK_RESULT_CONTEXT_INVALID");
    const value = validate(record.response), canonical = Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...context, response: value })}\n`, "utf8");
    if (!bytes.equals(canonical)) throw failure("DESKTOP_SHELL_NETWORK_RESULT_INVALID");
    const observed = { kind, sha256: sha256(bytes) };
    if (evidence !== null && (evidence.kind !== kind || evidence.sha256 !== observed.sha256)) throw failure("DESKTOP_SHELL_NETWORK_STATE_CONFLICT");
    await assertDirectories(directories);
    return { status: "verified" as const, value, evidence: observed };
  }
  return { actionKey: context.actionKey, requestSha256: context.requestSha256, recoverResult: recover,
    /** 独占临时实体写满、同步、关闭后排他发布；故障现场保留，禁止覆写已有结果。 */
    async persistResult(value) {
      await assertDirectories(directories);
      const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...context, response: validate(value) })}\n`, "utf8");
      if (bytes.length > MAX_BYTES) throw failure("DESKTOP_SHELL_NETWORK_RESULT_TOO_LARGE");
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const file = await fs.open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      let written!: BigIntStats;
      await withClose(file, async () => {
        const before = await file.stat({ bigint: true }); regular(before);
        let offset = 0;
        while (offset < bytes.length) { const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > bytes.length - offset) throw failure("DESKTOP_SHELL_NETWORK_RESULT_WRITE_INVALID"); offset += bytesWritten; }
        await file.sync(); written = await file.stat({ bigint: true }); regular(written);
        if (before.dev !== written.dev || before.ino !== written.ino || !(await readBytes(file, written)).equals(bytes)
          || !sameMetadata(written, await file.stat({ bigint: true }))) throw failure("DESKTOP_SHELL_NETWORK_RESULT_CHANGED");
      });
      await assertDirectories(directories);
      if (!sameMetadata(written, await fs.lstat(temporary, { bigint: true }))) throw failure("DESKTOP_SHELL_NETWORK_RESULT_CHANGED");
      await fs.link(temporary, target); await fs.unlink(temporary);
      const recovered = await recover(null);
      if (recovered.status !== "verified") throw failure("DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN");
      if (recovered.evidence.sha256 !== sha256(bytes)) throw failure("DESKTOP_SHELL_NETWORK_RESULT_CHANGED");
      return recovered.evidence;
    } };
}

/** 逐层固定真实普通目录，读取模式不创建；requestId 摘要避免 Windows 路径解释。 */
async function resultDirectories(dataDir: string, requestId: string, create = true): Promise<Directory[]> {
  if (await fs.realpath(dataDir) !== dataDir) throw failure("DESKTOP_SHELL_NETWORK_RESULT_PATH_INVALID");
  const directories: Directory[] = [];
  let directory = dataDir;
  for (const part of ["", ".staging", "shell-update", sha256(requestId)]) {
    if (part) {
      directory = path.join(directory, part);
      if (create) { try { await fs.mkdir(directory, { mode: 0o700 }); }
        catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause; } }
    }
    const identity = await fs.lstat(directory, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink() || await fs.realpath(directory) !== directory) throw failure("DESKTOP_SHELL_NETWORK_RESULT_PATH_INVALID");
    directories.push({ directory, identity }); await assertDirectories(directories);
  }
  return directories;
}

/** 操作前后核目录实体，拒绝根或任一祖先重指；不声称跨进程互斥或目录项断电耐久。 */
async function assertDirectories(directories: Directory[]): Promise<void> {
  for (const { directory, identity } of directories) { const actual = await fs.lstat(directory, { bigint: true });
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== identity.dev || actual.ino !== identity.ino
      || await fs.realpath(directory) !== directory) throw failure("DESKTOP_SHELL_NETWORK_RESULT_PATH_INVALID"); }
}

/** 仅真实路径缺失是 unknown；读取前后以同 fd 与路径身份核对完整 bytes。 */
async function readResult(target: string): Promise<Buffer | null> {
  let before: BigIntStats;
  try { before = await fs.lstat(target, { bigint: true }); }
  catch (cause) { if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null; throw cause; }
  regular(before);
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const bytes = await withClose(file, async () => {
    const opened = await file.stat({ bigint: true }); regular(opened);
    if (!sameMetadata(before, opened)) throw failure("DESKTOP_SHELL_NETWORK_RESULT_CHANGED");
    const bytes = await readBytes(file, opened);
    if (!sameMetadata(opened, await file.stat({ bigint: true })) || !sameMetadata(opened, await fs.lstat(target, { bigint: true }))) throw failure("DESKTOP_SHELL_NETWORK_RESULT_CHANGED");
    return bytes;
  });
  if (!sameMetadata(before, await fs.lstat(target, { bigint: true }))) throw failure("DESKTOP_SHELL_NETWORK_RESULT_CHANGED");
  return bytes;
}

/** 大小与读取均有界，额外一字节检查不接受未观察到的尾部内容。 */
async function readBytes(file: FileHandle, stat: BigIntStats): Promise<Buffer> {
  if (stat.size < 1n || stat.size > BigInt(MAX_BYTES)) throw failure("DESKTOP_SHELL_NETWORK_RESULT_TOO_LARGE");
  const bytes = Buffer.alloc(Number(stat.size)); let position = 0;
  while (position < bytes.length) { const length = Math.min(65_536, bytes.length - position), { bytesRead } = await file.read(bytes, position, length, position);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > length) throw failure("DESKTOP_SHELL_NETWORK_RESULT_INVALID"); position += bytesRead; }
  if ((await file.read(Buffer.alloc(1), 0, 1, position)).bytesRead !== 0) throw failure("DESKTOP_SHELL_NETWORK_RESULT_CHANGED");
  return bytes;
}

/** 布尔旗标保留 throw undefined；关闭失败不能掩盖主要原因。 */
async function withClose<T>(file: FileHandle, operation: () => Promise<T>): Promise<T> {
  let failed = false, primary: unknown;
  try { return await operation(); } catch (cause) { failed = true; primary = cause; throw cause; }
  finally { try { await file.close(); } catch (cause) { throw failed ? new AggregateError([primary, cause], "DESKTOP_SHELL_NETWORK_RESULT_CLOSE_FAILED") : cause; } }
}

/** JSON/UTF-8 私文不进入错误链，结构语义由严格合同继续核验。 */
function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw failure("DESKTOP_SHELL_NETWORK_UTF8_INVALID"); }
  try { return JSON.parse(text); } catch { throw failure("DESKTOP_SHELL_NETWORK_JSON_INVALID"); }
}

/** 只接受自有数据属性和精确字段，拒绝数组、原型和访问器输入。 */
function fields(value: unknown, expected?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure("DESKTOP_SHELL_NETWORK_RESPONSE_INVALID");
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || !("value" in Object.getOwnPropertyDescriptor(value, key)!))
    || expected && (keys.length !== expected.length || expected.some(key => !Object.hasOwn(value, key)))) throw failure("DESKTOP_SHELL_NETWORK_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

/** 工件只接受唯一普通实体，防止链接别名绕过结果绑定。 */
function regular(stat: BigIntStats): void { if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw failure("DESKTOP_SHELL_NETWORK_RESULT_PATH_INVALID"); }
/** 身份与可见元数据共同发现读写期间的替换、截断和改写。 */
function sameMetadata(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
/** 请求材料和完整结果使用同一标准 SHA-256，不增加签名算法。 */
function sha256(value: string | Uint8Array): string { return crypto.createHash("sha256").update(value).digest("hex"); }
/** 固定错误码不包含远端正文，日志留给拥有处理权的调用 owner。 */
function failure(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
