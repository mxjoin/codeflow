import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { DesktopMigrationAccount, DesktopMigrationState } from "@codeflowai/shared";
import { signDevicePayload, type DeviceIdentity } from "./deviceIdentity.js";
import { createDesktopUpdateTransport } from "./updateTransport.js";

type AccountSource = { sourceClientId: string; apiKey: string; serverWs: string };
export type LegacyMigrationRequest = {
  action: "discover" | "migrate"; dataDir: string; targetClientId: string; targetDeviceId: string;
  candidateId?: string; migrationId?: string;
};
export type LegacyMigrationResult = {
  candidateId: string | null; workspaceCount: number; migrationId?: string;
  completed?: boolean; resume?: boolean; accountSource?: AccountSource;
};
type Progress = { stage: string; completed: number; total: number | null; workspaceCount?: number };
export type LegacyMigrationExecutor = (request: LegacyMigrationRequest, progress: (value: Progress) => void) => Promise<LegacyMigrationResult>;
type AccountRecord = { schemaVersion: 1; targetClientId: string; migrationId: string | null; nonce: string; cancelled: boolean; delivered: boolean };
export type LegacyClientMigration = ReturnType<typeof createLegacyClientMigration>;

/** 旧整组包沿原启动等待整组升级；有迁移记录时禁止用缺能力的旧包绕过屏障。 */
export function resolveLegacyClientMigrationWorker(releaseDir: string, dataDir: string): string | null {
  const entry = path.join(releaseDir, "client", "dist", "legacyClientMigrationWorker.cjs");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(entry); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (fs.existsSync(path.join(dataDir, "legacy-client-migration-journal.json"))) throw new Error("MIGRATION_RELEASE_UNSUPPORTED");
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("MIGRATION_WORKER_ENTRY_INVALID");
  return entry;
}

/** 正常 Client 启动前的唯一迁移 owner；Worker 与认证失败各自保留显式状态。 */
export function createLegacyClientMigration(input: {
  dataDir: string; workerEntry: string; identity: DeviceIdentity;
  execute?: LegacyMigrationExecutor;
  restoreAccount?: (source: AccountSource, record: AccountRecord) => Promise<DesktopMigrationAccount>;
}) {
  const accountPath = path.join(input.dataDir, "legacy-client-migration-account.json");
  let record = readAccountRecord(accountPath, input.dataDir);
  let state: DesktopMigrationState = { status: "checking", migrationId: record.migrationId, candidateId: null, workspaceCount: 0,
    stage: "discover", completed: 0, total: null, errorCode: null, message: null,
    account: { status: record.cancelled ? "cancelled" : "not_requested", errorCode: null, message: null } };
  let child: ChildProcess | null = null;
  let stopped = false;
  let flight: Promise<void> | undefined;
  let accountFlight: Promise<void> | undefined;
  let source: AccountSource | undefined;
  let account: DesktopMigrationAccount | null = null;
  let generation = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let discovered!: () => void;
  const discovery = new Promise<void>(resolve => { discovered = resolve; });
  const listeners = new Set<(state: DesktopMigrationState) => void>();
  let prepared: Promise<void> | undefined;

  /** 状态只广播脱敏副本，不共享宿主可变对象。 */
  const canDefer = (): boolean => !stopped && !record.migrationId
    && !fs.lstatSync(path.join(input.dataDir, "legacy-client-migration-journal.json"), { throwIfNoEntry: false })
    && (state.status === "available" || state.status === "failed" && state.stage === "discover"
      && state.errorCode === "SOURCE_ACCOUNT_UNRESOLVED" && !state.candidateId);
  const snapshot = (): DesktopMigrationState => structuredClone({ ...state, canDefer: canDefer() });
  const publish = (): void => { for (const listener of listeners) listener(snapshot()); };
  /** 只持久保存重试身份和用户选择，不保存 Key、session 或账号正文。 */
  const save = (): void => {
    if (!record.migrationId) record.targetClientId = readTargetClientId(input.dataDir) ?? record.targetClientId;
    writeAccountRecord(accountPath, record);
  };
  /** 在拥有迁移上下文的边界写一次错误；根因先移除所有内存凭据。 */
  const log = (error: unknown, code: string, stage: string): void => {
    const redact = (text: string) => [source?.apiKey, account?.session.sessionToken].reduce<string>((value, secret) => secret ? value.split(secret).join("[REDACTED]") : value, text);
    const logDir = path.join(input.dataDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "legacy-client-migration.jsonl"), JSON.stringify({ time: new Date().toISOString(),
      errorCode: code, requestId: record.migrationId ?? "legacy-discovery", migrationId: record.migrationId,
      sourceClientId: source?.sourceClientId ?? null, targetClientId: record.targetClientId, stage,
      rootCause: redact(error instanceof Error ? error.message : String(error)).slice(0, 1000) }) + "\n", "utf8");
  };
  /** Worker 状态来自计数，任何无效计数均拒绝，不能制造完成百分比。 */
  const progress = (value: Progress): void => {
    if (typeof value.stage !== "string" || !Number.isSafeInteger(value.completed) || value.completed < 0
      || value.total !== null && (!Number.isSafeInteger(value.total) || value.total < value.completed)) throw new Error("MIGRATION_PROGRESS_INVALID");
    state = { ...state, stage: value.stage, completed: value.completed, total: value.total,
      ...(value.workspaceCount === undefined ? {} : { workspaceCount: value.workspaceCount }) };
    publish();
  };
  /** 固定入口只执行一个命令；最终结果必须同时等到子进程正常退出才可信。 */
  const executeWorker: LegacyMigrationExecutor = (request, onProgress) => new Promise((resolve, reject) => {
    if (child || stopped) { reject(new Error(stopped ? "MIGRATION_STOPPED" : "MIGRATION_WORKER_BUSY")); return; }
    const worker = spawn(process.execPath, [input.workerEntry], { cwd: path.dirname(input.workerEntry),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });
    child = worker;
    let result: LegacyMigrationResult | undefined;
    let failure: unknown;
    worker.on("message", (message: unknown) => {
      try {
        if (!message || typeof message !== "object") throw new Error("MIGRATION_WORKER_PROTOCOL_INVALID");
        const value = message as { type?: unknown; progress?: Progress; result?: LegacyMigrationResult; error?: { code: string; message: string } };
        if (value.type === "progress" && value.progress) onProgress(value.progress);
        else if (value.type === "result" && value.result && !result) result = value.result;
        else if (value.type === "error" && value.error) failure = Object.assign(new Error(value.error.message), { code: value.error.code });
        else throw new Error("MIGRATION_WORKER_PROTOCOL_INVALID");
      } catch (error) { failure = error; worker.kill(); }
    });
    worker.on("error", error => { failure = error; });
    worker.once("close", (code, signal) => {
      child = null;
      if (failure) reject(failure);
      else if (stopped || code !== 0 || signal || !result) reject(Object.assign(new Error(stopped ? "MIGRATION_STOPPED" : "MIGRATION_WORKER_EXITED"), { code: "MIGRATION_WORKER_EXITED" }));
      else resolve(result);
    });
    worker.send(request, error => { if (error) { failure = error; worker.kill(); } });
  });
  const execute = input.execute ?? executeWorker;
  /** 网络只恢复账号，失败按已确认规则开放已完成的本地数据并保留单独重试。 */
  const restore = async (): Promise<void> => {
    if (record.cancelled) throw new Error("MIGRATION_ACCOUNT_CANCELLED");
    if (!source) throw new Error("MIGRATION_ACCOUNT_SOURCE_MISSING");
    const owner = generation;
    account = null;
    state = { ...state, account: { status: "restoring", errorCode: null, message: null } }; publish();
    try {
      const restored = await (input.restoreAccount ?? ((from, pending) => restoreMigrationAccount(input, from, pending)))(source, record);
      if (owner !== generation || record.cancelled || stopped) return;
      account = restored;
      state = { ...state, account: { status: "restored", errorCode: null, message: null } };
    } catch (error) {
      const code = errorCode(error, "MIGRATION_ACCOUNT_RESTORE_FAILED");
      log(error, code, "account");
      if (owner !== generation || record.cancelled || stopped) return;
      state = { ...state, account: { status: "failed", errorCode: code, message: "本地数据迁移完成，账号未登录。可重试恢复或重新登录。" } };
    }
    publish();
  };
  const owner = {
    /** 发现只读，候选存在时一直等待明确点击；失败保留同一页面供重试。 */
    prepare(): Promise<void> {
      prepared ??= (async () => {
        try {
          const result = await execute({ action: "discover", dataDir: input.dataDir, targetClientId: record.targetClientId, targetDeviceId: input.identity.deviceId }, progress);
          assertMigrationResult(result);
          source = result.accountSource;
          state = { ...state, candidateId: result.candidateId, workspaceCount: result.workspaceCount };
          if (result.migrationId && record.migrationId && result.migrationId !== record.migrationId) throw new Error("MIGRATION_ID_CONFLICT");
          if (result.migrationId && !record.migrationId) {
            record = { ...record, migrationId: result.migrationId }; save();
            state = { ...state, migrationId: record.migrationId };
          }
          if (result.completed) { state = { ...state, status: "running", stage: "runtime_starting" }; release(); }
          else if (result.resume) {
            state = { ...state, status: "available" };
            await owner.start(result.candidateId!);
          } else if (!result.candidateId) { state = { ...state, status: "running", stage: "runtime_starting" }; release(); }
          else state = { ...state, status: "available" };
          publish();
        } catch (error) {
          const code = errorCode(error, "MIGRATION_DISCOVERY_FAILED");
          log(error, code, "discover");
          state = { ...state, status: "failed", errorCode: code };
          if (code === "SOURCE_ACCOUNT_UNRESOLVED" && canDefer()) {
            state = { ...state, status: "running", stage: "runtime_starting", candidateId: null, workspaceCount: 0,
              completed: 0, total: null, errorCode: code,
              message: "旧 Client 所属 Server 暂不可用，旧数据已保留；未迁移旧数据，新桌面将继续启动。" };
            publish(); release(); return;
          }
          state = { ...state, status: "failed", errorCode: code, message: "无法检查旧 Client 数据，原数据保留。请退出后重试。" };
          publish();
        } finally { discovered(); }
        await gate;
        if (stopped) throw Object.assign(new Error("MIGRATION_STOPPED"), { code: "MIGRATION_STOPPED" });
      })();
      return prepared;
    },
    /** 测试及启动协调只等待发现事实，不代表迁移门禁已放行。 */
    whenDiscovered(): Promise<void> { return discovery; },
    snapshot,
    subscribe(listener: (value: DesktopMigrationState) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** 候选标识由本次发现生成；重复点击共用同一在途任务。 */
    start(candidateId: string): Promise<void> {
      if (candidateId !== state.candidateId || !candidateId) return Promise.reject(new Error("MIGRATION_CANDIDATE_CHANGED"));
      if (flight) return flight;
      if (!["available", "failed"].includes(state.status) || stopped) return Promise.reject(new Error("MIGRATION_DECISION_INVALID"));
      state = { ...state, status: "running", stage: "quiesce", errorCode: null, message: null }; publish();
      flight = (async () => {
        try {
          record = { ...record, migrationId: record.migrationId ?? crypto.randomUUID() }; save();
          state = { ...state, migrationId: record.migrationId };
          const result = await execute({ action: "migrate", dataDir: input.dataDir, candidateId, migrationId: record.migrationId!,
            targetClientId: record.targetClientId, targetDeviceId: input.identity.deviceId }, progress);
          assertMigrationResult(result);
          if (result.completed !== true) throw new Error("MIGRATION_COMMIT_NOT_CONFIRMED");
          if (result.migrationId !== record.migrationId) throw new Error("MIGRATION_ID_CONFLICT");
          source = result.accountSource;
          state = { ...state, stage: "runtime_starting" }; publish(); release();
        } catch (error) {
          log(error, errorCode(error, "MIGRATION_DATA_FAILED"), state.stage);
          state = { ...state, status: "failed", errorCode: errorCode(error, "MIGRATION_DATA_FAILED"), message: "迁移失败，原数据保留。请重试本次迁移。" }; publish();
          throw error;
        } finally { flight = undefined; }
      })();
      return flight;
    },
    /** 仅未开始迁移的候选或账号检测失败可稍后，数据提交及安全失败仍保留屏障。 */
    async defer(): Promise<void> {
      if (!canDefer()) throw new Error("MIGRATION_DECISION_INVALID");
      generation++; source = undefined; account = null;
      state = { ...state, status: "running", stage: "runtime_starting", candidateId: null, workspaceCount: 0,
        completed: 0, total: null, errorCode: null, message: null }; publish(); release();
    },
    /** 正常 Client ready 后才开放页面；账号恢复有独立失败态及有限网络预算。 */
    async runtimeReady(): Promise<void> {
      if (record.migrationId && !source && !record.cancelled && !record.delivered) {
        state = { ...state, account: { status: "failed", errorCode: "MIGRATION_ACCOUNT_SOURCE_MISSING",
          message: "本地数据迁移完成，旧登录凭据不可用，请重新登录。" } };
        log(new Error("MIGRATION_ACCOUNT_SOURCE_MISSING"), "MIGRATION_ACCOUNT_SOURCE_MISSING", "account");
      }
      if (source && !record.cancelled && !record.delivered) { accountFlight = restore(); try { await accountFlight; } finally { accountFlight = undefined; } }
      if (stopped) throw Object.assign(new Error("MIGRATION_STOPPED"), { code: "MIGRATION_STOPPED" });
      state = { ...state, status: "ready", stage: "completed", completed: state.total ?? state.completed }; publish();
    },
    /** 有效待交付结果只重交付；过期或缺失时才重新兑换，不再执行数据导入。 */
    async retryAccount(): Promise<void> {
      if (record.cancelled) throw new Error("MIGRATION_ACCOUNT_CANCELLED");
      if (state.status !== "ready") throw new Error("MIGRATION_NOT_READY");
      if (account && account.session.sessionExpiresAt > Date.now() + 5_000) return;
      accountFlight ??= (async () => {
        if (!source) {
          const result = await execute({ action: "discover", dataDir: input.dataDir, targetClientId: record.targetClientId, targetDeviceId: input.identity.deviceId }, () => {});
          assertMigrationResult(result);
          if (!result.completed || result.migrationId !== record.migrationId) throw new Error("MIGRATION_COMMIT_NOT_CONFIRMED");
          source = result.accountSource;
        }
        await restore();
      })();
      try { await accountFlight; } finally { accountFlight = undefined; }
    },
    /** 交付有效内存副本，持久化确认前保留同一结果；过期必须显式重试恢复。 */
    async takeAccount(): Promise<DesktopMigrationAccount | null> {
      if (account && account.session.sessionExpiresAt <= Date.now() + 5_000) throw new Error("MIGRATION_ACCOUNT_EXPIRED");
      return structuredClone(account);
    },
    /** 仅在现有store已保存真实session后确认，重开不再次兑换或覆盖账号。 */
    async acknowledgeAccount(): Promise<void> {
      if (!account || record.cancelled) throw new Error("MIGRATION_ACCOUNT_NOT_PENDING");
      if (account.session.sessionExpiresAt <= Date.now() + 5_000) throw new Error("MIGRATION_ACCOUNT_EXPIRED");
      record = { ...record, delivered: true }; save(); account = null;
    },
    /** 用户登出或改用其他账号时永久终止该来源恢复，包括迟到的网络结果。 */
    async cancelAccount(): Promise<void> {
      generation++; record = { ...record, cancelled: true }; save(); account = null;
      state = { ...state, account: { status: "cancelled", errorCode: null, message: null } }; publish();
    },
    /** 停止失败仍释放启动门禁并上抛；Worker 归属保留到关闭，允许原退出入口重试。 */
    async stop(): Promise<void> {
      stopped = true; generation++;
      try {
        const worker = child;
        if (worker) {
          const closed = new Promise<void>(resolve => worker.once("close", () => resolve()));
          if (!worker.kill()) throw new Error("MIGRATION_WORKER_STOP_FAILED");
          await closed;
        }
      } finally { release(); }
    },
  };
  return owner;
}

/** 卸载在原账号记录持久取消自动恢复；没有迁移事实时不创建记录。 */
export function cancelLegacyMigrationAccountForUninstall(dataDir: string): void {
  const file = path.join(dataDir, "legacy-client-migration-account.json");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat && !fs.lstatSync(path.join(dataDir, "legacy-client-migration-journal.json"), { throwIfNoEntry: false })) return;
  const directory = fs.lstatSync(dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || path.relative(fs.realpathSync.native(dataDir), path.resolve(dataDir)) !== "") throw new Error("MIGRATION_ACCOUNT_PATH_INVALID");
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error("MIGRATION_ACCOUNT_PATH_INVALID");
  writeAccountRecord(file, { ...readAccountRecord(file, dataDir), cancelled: true });
}

/** 共用同目录原子写；失败回收本次临时文件，保留写入及清理的全部错误。 */
function writeAccountRecord(file: string, record: AccountRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`, fd = fs.openSync(temporary, "wx", 0o600);
  let failure: unknown;
  try {
    try { fs.writeFileSync(fd, JSON.stringify(record), "utf8"); fs.fsyncSync(fd); }
    catch (error) { failure = error; throw error; }
    finally {
      try { fs.closeSync(fd); }
      catch (error) { throw failure === undefined ? error : new AggregateError([failure, error], "MIGRATION_ACCOUNT_CLOSE_FAILED", { cause: failure }); }
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    try { if (fs.lstatSync(temporary, { throwIfNoEntry: false })) fs.unlinkSync(temporary); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "MIGRATION_ACCOUNT_CLEANUP_FAILED", { cause: error }); }
    throw error;
  }
}

/** 严格恢复本安装的重试身份；错误记录不能被重建空值掩盖。 */
function readAccountRecord(file: string, dataDir: string): AccountRecord {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
    return { schemaVersion: 1, targetClientId: readTargetClientId(dataDir) ?? `local_${crypto.randomUUID()}`, migrationId: null,
      nonce: crypto.randomUUID(), cancelled: false, delivered: false };
  }
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as AccountRecord;
  if (record.schemaVersion !== 1 || typeof record.targetClientId !== "string" || !record.targetClientId.trim()
    || record.migrationId !== null && !/^[0-9a-f-]{36}$/u.test(record.migrationId)
    || !/^[0-9a-f-]{36}$/u.test(record.nonce) || typeof record.cancelled !== "boolean" || typeof record.delivered !== "boolean") throw new Error("MIGRATION_ACCOUNT_RECORD_INVALID");
  return record.migrationId ? record : { ...record, targetClientId: readTargetClientId(dataDir) ?? record.targetClientId };
}

/** 未绑定迁移时沿正常 Client 已生成的稳定身份；绑定后由原记录锁定身份。 */
function readTargetClientId(dataDir: string): string | undefined {
  const configPath = path.join(dataDir, "config.json");
  if (!fs.existsSync(configPath)) return undefined;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { clientId?: unknown };
  if (config.clientId !== undefined && (typeof config.clientId !== "string" || !config.clientId.trim())) throw new Error("MIGRATION_TARGET_CONFIG_INVALID");
  return config.clientId as string | undefined;
}

/** 只传短错误码，避免远端正文或秘密进入状态。 */
function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : fallback;
}

/** Worker输出仍须满足宿主合同，缺字段不能被当成没有旧数据放行。 */
function assertMigrationResult(value: LegacyMigrationResult): void {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.workspaceCount) || value.workspaceCount < 0
    || value.candidateId !== null && (typeof value.candidateId !== "string" || !value.candidateId || value.candidateId.length > 256)
    || value.migrationId !== undefined && (typeof value.migrationId !== "string" || !/^[0-9a-f-]{36}$/u.test(value.migrationId))
    || value.completed !== undefined && typeof value.completed !== "boolean"
    || value.resume !== undefined && typeof value.resume !== "boolean"
    || value.resume && !value.candidateId
    || value.accountSource && (typeof value.accountSource.sourceClientId !== "string" || !value.accountSource.sourceClientId
      || typeof value.accountSource.apiKey !== "string" || !value.accountSource.apiKey
      || typeof value.accountSource.serverWs !== "string" || !value.accountSource.serverWs)) throw new Error("MIGRATION_WORKER_RESULT_INVALID");
}

/** 原 Server、固定路径、禁跳转；先登记既有安装，再用旧 Key 换真实账号会话。 */
async function restoreMigrationAccount(input: { dataDir: string; identity: DeviceIdentity }, source: AccountSource, record: AccountRecord): Promise<DesktopMigrationAccount> {
  const { buildClientMigrationPayload, CLIENT_MIGRATION_PATH } = await import("@codeflowai/shared/client-migration-auth");
  const ws = new URL(source.serverWs);
  if (!["ws:", "wss:"].includes(ws.protocol) || ws.username || ws.password || ws.hash) throw new Error("MIGRATION_ACCOUNT_ORIGIN_INVALID");
  ws.protocol = ws.protocol === "wss:" ? "https:" : "http:";
  const serverOrigin = ws.origin;
  const signal = AbortSignal.timeout(30_000);
  // 迁移发生在运行时就绪前，没有可上报的资源版本；固定 unknown 以满足新登记协议。
  await createDesktopUpdateTransport({ ...input, configuredServerOrigin: serverOrigin,
    getVersions: () => ({ shellVersion: "unknown", webVersion: "unknown", clientVersion: "unknown", releaseId: "unknown" }) }).register({ signal });
  const unsigned = { schemaVersion: 1 as const, migrationId: record.migrationId!, sourceClientId: source.sourceClientId,
    targetClientId: record.targetClientId, deviceId: input.identity.deviceId, publicKey: input.identity.publicKeyBase64,
    timestamp: Date.now(), nonce: record.nonce };
  const signed = await signDevicePayload(input.dataDir, buildClientMigrationPayload(unsigned, source.apiKey));
  if (signed.deviceId !== unsigned.deviceId || signed.publicKeyBase64 !== unsigned.publicKey) throw new Error("MIGRATION_DEVICE_CHANGED");
  const response = await fetch(new URL(CLIENT_MIGRATION_PATH, serverOrigin), { method: "POST", redirect: "error", credentials: "omit", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${source.apiKey}` }, body: JSON.stringify({ ...unsigned, signature: signed.signature }) });
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new Error("MIGRATION_ACCOUNT_RESPONSE_INVALID"); }
  const body = value as DesktopMigrationAccount["session"] & { ok?: boolean; code?: unknown };
  if (!response.ok || body?.ok !== true) throw Object.assign(new Error("MIGRATION_ACCOUNT_RESTORE_FAILED"), { code: errorCode(body, "MIGRATION_ACCOUNT_RESTORE_FAILED") });
  if (typeof body.sessionToken !== "string" || !body.sessionToken.startsWith("sess_") || !Number.isSafeInteger(body.sessionExpiresAt)
    || body.sessionExpiresAt <= Date.now() || !body.userSummary?.userId || !body.accountRole || !body.accessContext) throw new Error("MIGRATION_ACCOUNT_RESPONSE_INVALID");
  return { serverOrigin, session: body };
}
