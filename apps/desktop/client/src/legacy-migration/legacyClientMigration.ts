import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises';
import type { WorkspaceId, ThreadId, OrchestrationId } from '@codeflowai/shared';
import { openSqliteDb, type SqliteDb } from '../db/sqliteDb.js';
import { CLIENT_DB_SCHEMA_VERSION, migrateClientDb, assertWorkspaceDbReadOnlySchema,
  ensureWorkspaceCoreQueueTables, ensureWorkspaceAdditionalTables, WORKSPACE_CORE_TABLES, WORKSPACE_ADDITIONAL_TABLES } from '../db/migrateClientDb.js';
import { WorkspaceRepo, type PersistedWorkspace } from '../db/repos/workspaceRepo.js';
import { ThreadQueueStateRepo } from '../db/repos/threadQueueStateRepo.js';
import { FileBlobRepo } from '../db/repos/fileBlobRepo.js';
import { OrchInstanceRepo } from '../db/repos/orchInstanceRepo.js';
import { ChatWorkflowRepo } from '../db/repos/chatWorkflowRepo.js';
import { hashOrchNodeAttemptSubmission } from '../db/repos/orchNodeAttemptRepo.js';
import { serializeCodeAttributionOutboxPayload } from '../db/repos/codeAttributionOutboxRepo.js';
import { OrchIntakeListStateRepo } from '../db/repos/orchIntakeListStateRepo.js';
import { OrchInstanceSummaryProjectionReader } from '../db/orchInstanceSummaryProjection.js';
import { scheduledTaskAccountRuntimeKey } from '../db/repos/scheduledTaskRuntimeStateRepo.js';
import { ConversationEventRepo, RawEngineEventRepo, readWorkspaceEventSeqFloor, recordWorkspaceEventSeqFloor } from '../db/repos/eventRepo.js';
import { acquireClientProcessLock, buildClientProcessLockPath, type ClientProcessLock } from '../startup/clientStartupGuards.js';
import { ensureWorkspaceCodeflowaiDirectory, inspectExistingWorkspaceCodeflowaiDirectory, inspectWorkspaceCodeflowaiFile,
  assertWorkspaceCodeflowaiDirectory } from '../codeflowai/workspaceCodeflowaiDirectory.js';
import { resolveWorkspaceReadPath } from '../fs/fsHelpers.js';
import { parseLegacyClientMigrationRequest, type LegacyClientMigrationRequest, type LegacyClientMigrationProgress,
  type LegacyClientMigrationResult } from './legacyClientMigrationProtocol.js';

type Input = Omit<LegacyClientMigrationRequest, 'action'>;
type Row = Record<string, any>;
type SourceConfig = { apiKey: string; serverWs: string; clientId: string };
type Source = { configPath: string; dbPath: string; accountNamespace: string; sourceClientId: string; serverWs: string;
  workspaces: Array<PersistedWorkspace & { workspaceDbPath: string | null }>; candidateId: string };
type PublishedFile = { target: string; staged: string; sha256: string; originalSha256: string | null; published: boolean };
type Journal = { schemaVersion: 1; migrationId: string; candidateId: string; targetClientId: string; targetDeviceId: string;
  source: Source; stage: string; files: PublishedFile[]; snapshotsReady: boolean; converted: boolean;
  completed: boolean; errorCode: string | null; snapshotGeneration: string | null;
  targetInitialization: { dbSha256: string; metaSha256: string } | null;
  snapshotHashes: Array<{ name: string; sha256: string }> };
export type LegacyClientMigrationDependencies = {
  homeDir?: string;
  resolveNamespace?: (config: SourceConfig) => Promise<string>;
  onProgress?: (progress: LegacyClientMigrationProgress) => void;
  signal?: AbortSignal;
  afterPublish?: (file: { target: string }) => void;
};
const JOURNAL = 'legacy-client-migration-journal.json';
const SIDECARS = ['-wal', '-shm', '-journal'];
const PROFILE_TABLES = ['workspace_execution_profiles', 'workspace_prefs', 'scheduled_task_configs', 'scheduled_task_runs',
  'scheduled_task_runtime_states', 'scheduled_task_account_configs'];
const CACHE_TABLES = ['conversation_presentations', 'conversation_presentation_items', 'orch_list_status_count_cache'];
const WORKSPACE_TABLES = [...new Set([...WORKSPACE_CORE_TABLES, ...WORKSPACE_ADDITIONAL_TABLES, ...PROFILE_TABLES])]
  .filter(table => table !== 'meta' && !CACHE_TABLES.includes(table));
const RETIRED_TABLES = ['notes', 'orch_asset_bundle_sync', 'orch_asset_cache_entries', 'orch_asset_cache_group_assignments',
  'orch_asset_cache_groups', 'orch_asset_cache_skill_files', 'orch_asset_cache_state', 'orch_asset_cache_sync_pages',
  'orch_asset_cache_sync_runs', 'orch_asset_legacy_authority_state', 'orch_asset_migration_lock_state',
  'engine_events', 'conversation_items'];
const REFERENCE_KEYS = new Set(['workspaceId', 'workspace_id', 'workspaceScopeId', 'workspace_scope_id',
  'sourceWorkspaceId', 'targetWorkspaceId', 'localWorkspaceId', 'hostWorkspaceId']);

/** 只读发现当前配置账号；完成或中断事实优先读取同一安装的 journal。 */
export async function discoverLegacyClientMigration(input: Input, dependencies: LegacyClientMigrationDependencies = {}): Promise<LegacyClientMigrationResult> {
  validateInput(input);
  const journal = readJournal(input);
  if (journal) {
    if (journal.completed) { validateCompleted(input, journal); return await journalResult(journal, dependencies); }
    return { candidateId: journal.candidateId, workspaceCount: journal.source.workspaces.length, migrationId: journal.migrationId, resume: true };
  }
  const source = await discoverSource(input, dependencies);
  return { candidateId: source?.candidateId ?? null, workspaceCount: source?.workspaces.length ?? 0 };
}

/** 卸载只清本安装已完成迁移的私有归档凭据，保留历史，原Client及项目不写。 */
export function clearLegacyMigrationCredentials(input: Input): void {
  const root = path.join(input.dataDir, 'legacy-client-migration'), journal = readJournal(input);
  if (!journal) { if (exists(root)) fail('MIGRATION_ARCHIVE_OWNER_MISSING'); return; }
  validateInput(input);
  if (!journal.completed) fail('MIGRATION_NOT_COMPLETED');
  validateCompleted(input, journal);
  if (!exists(root)) return;
  assertDirectory(root);
  const archive = archiveDirectory(input, journal);
  if (fs.readdirSync(root).some(name => name !== journal.migrationId)) fail('MIGRATION_ARCHIVE_UNKNOWN_ENTRY');
  if (!exists(archive)) return;
  const databases: string[] = [], temporary: string[] = [];
  /** 归档只允许已生成的两层目录和固定文件；收齐清单后才打开可写库。 */
  const inspect = (directory: string, generation: boolean): void => {
    assertDirectory(directory);
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (!generation && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name)) { inspect(file, true); continue; }
      assertFile(file);
      const database = generation ? /^(?:source-application|(?:original|source)-workspace-[0-9]+)\.db$/ : /^(?:original-empty-application|target-application|converted-workspace-[0-9]+)\.db$/;
      const base = name.replace(/-(?:wal|shm|journal)$|\.meta\.json$|\.snapshot$/u, '');
      if (database.test(name)) databases.push(file);
      else if (database.test(base) && name !== base) {
        if (name.endsWith('.snapshot')) temporary.push(file);
        else if (!exists(path.join(directory, base))) fail('MIGRATION_ARCHIVE_ORPHAN_SIDECAR');
      } else if (generation && name === 'source-application.meta.json') {
        readObject(file);
      } else if (!generation && ['target-config.json', 'target-meta.json'].includes(name)) {
        if (name === 'target-config.json' && readObject(file).apiKey !== '') fail('MIGRATION_ARCHIVE_CONFIG_INVALID');
      } else fail('MIGRATION_ARCHIVE_UNKNOWN_ENTRY');
    }
  };
  inspect(archive, false);
  for (const file of databases) clearArchivedDatabaseCredentials(file);
  for (const file of temporary) { assertFile(file); fs.unlinkSync(file); }
  if (journal.snapshotGeneration && exists(snapshotDirectory(input, journal))) {
    const directory = snapshotDirectory(input, journal);
    journal.snapshotHashes = fs.readdirSync(directory).map(name => ({ name, sha256: sha256File(path.join(directory, name)) }));
    writeJournal(input, journal);
  }
}

/** 历史SQLite只更新凭据列，不迁schema；安全删除及收口后重开核验，失败阻断卸载。 */
function clearArchivedDatabaseCredentials(filename: string): void {
  withDatabase(filename, false, db => {
    integrity(db);
    if (db.pragma('secure_delete = ON', { simple: true }) !== 1) fail('MIGRATION_ARCHIVE_SECURE_DELETE_FAILED');
    if (hasTable(db, 'engine_keys')) {
      const names = columns(db, 'engine_keys');
      if (!names.includes('api_key') || !names.includes('is_active')) fail('MIGRATION_ARCHIVE_SCHEMA_INVALID');
      db.prepare(`UPDATE engine_keys SET api_key='',is_active=0${names.includes('secret_ref') ? ',secret_ref=NULL' : ''}`).run();
    }
    db.exec('VACUUM');
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Row[];
    if (checkpoint.length !== 1 || checkpoint[0]!.busy !== 0 || checkpoint[0]!.log !== checkpoint[0]!.checkpointed
      || db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') fail('MIGRATION_ARCHIVE_CHECKPOINT_FAILED');
    integrity(db);
  });
  syncFile(filename);
  withDatabase(filename, true, db => {
    integrity(db);
    if (hasTable(db, 'engine_keys') && db.prepare(`SELECT 1 FROM engine_keys WHERE api_key<>'' OR is_active<>0${columns(db, 'engine_keys').includes('secret_ref') ? ' OR secret_ref IS NOT NULL' : ''} LIMIT 1`).get()) {
      fail('MIGRATION_ARCHIVE_CREDENTIALS_NOT_CLEARED');
    }
  });
}

/** 重装只按明确旧/新身份补清归档并接续完成事实；原发现入口仍严格核身份。 */
export function rebindLegacyMigrationForReinstall(input: { dataDir: string; clientId: string; oldDeviceId: string; nextDeviceId: string }): void {
  const filename = path.join(input.dataDir, JOURNAL);
  if (!exists(filename)) return;
  const value = readObject(filename);
  if (![input.oldDeviceId, input.nextDeviceId].includes(value.targetDeviceId)) fail('MIGRATION_JOURNAL_CONFLICT');
  const target = { dataDir: input.dataDir, targetClientId: input.clientId, targetDeviceId: value.targetDeviceId as string };
  validateInput(target);
  const journal = readJournal(target)!;
  if (!journal.completed) fail('MIGRATION_NOT_COMPLETED');
  validateCompleted(target, journal);
  clearLegacyMigrationCredentials(target);
  if (journal.targetDeviceId !== input.nextDeviceId) writeJournal(target, { ...readJournal(target)!, targetDeviceId: input.nextDeviceId });
}

/** 用户确认后独占来源、快照转换并逐项提交；任何失败都保持业务屏障与归档。 */
export async function migrateLegacyClientMigration(input: Input, dependencies: LegacyClientMigrationDependencies = {}): Promise<LegacyClientMigrationResult> {
  parseLegacyClientMigrationRequest({ ...input, action: 'migrate' }); validateInput(input);
  let journal = readJournal(input);
  if (journal?.completed) { validateCompleted(input, journal); return await journalResult(journal, dependencies); }
  if (!journal) {
    const source = await discoverSource(input, dependencies);
    if (!source || source.candidateId !== input.candidateId) fail('MIGRATION_CANDIDATE_CHANGED');
    const targetInitialization = assertEmptyTarget(input);
    journal = { schemaVersion: 1, migrationId: input.migrationId!, candidateId: source.candidateId,
      targetClientId: input.targetClientId, targetDeviceId: input.targetDeviceId, source, stage: 'quiesce', files: [],
      snapshotsReady: false, converted: false, completed: false, errorCode: null, snapshotGeneration: null, targetInitialization, snapshotHashes: [] };
    writeJournal(input, journal);
  }
  if (journal.candidateId !== input.candidateId || journal.migrationId !== input.migrationId) fail('MIGRATION_ID_CONFLICT');
  const locks: ClientProcessLock[] = [];
  let failure: unknown;
  try {
    checkpoint(dependencies); progress(dependencies, 'quiesce', 0, null, journal);
    await stopLegacyOwner(journal.source, dependencies);
    locks.push(acquireClientProcessLock({ dbPath: journal.source.dbPath, clientId: journal.source.sourceClientId }));
    locks.push(acquireClientProcessLock({ dbPath: path.join(input.dataDir, 'codeflowai.db'), clientId: input.targetClientId }));
    if (!journal.snapshotsReady) refreshFrozenSource(journal.source);
    for (const dbPath of journal.source.workspaces.flatMap(work => work.workspaceDbPath ? [work.workspaceDbPath] : [])) {
      locks.push(acquireClientProcessLock({ dbPath, clientId: journal.source.sourceClientId }));
    }
    const archive = archiveDirectory(input, journal); fs.mkdirSync(archive, { recursive: true });
    archiveEmptyInitialization(input, journal);
    if (!journal.snapshotsReady) {
      journal.stage = 'snapshot'; journal.snapshotGeneration = crypto.randomUUID(); writeJournal(input, journal);
      const generation = snapshotDirectory(input, journal); fs.mkdirSync(generation);
      snapshot(journal.source.dbPath, path.join(generation, 'source-application.db'));
      fs.copyFileSync(`${journal.source.dbPath}.meta.json`, path.join(generation, 'source-application.meta.json'), fs.constants.COPYFILE_EXCL);
      syncFile(path.join(generation, 'source-application.meta.json'));
      const config = readSourceConfig(journal.source.configPath);
      if (config.clientId !== journal.source.sourceClientId) fail('SOURCE_IDENTITY_CHANGED');
      for (let index = 0; index < journal.source.workspaces.length; index++) {
        checkpoint(dependencies);
        const work = journal.source.workspaces[index]!;
        if (work.workspaceDbPath) {
          for (const suffix of ['', ...SIDECARS]) {
            const original = `${work.workspaceDbPath}${suffix}`, archived = path.join(generation, `original-workspace-${index}.db${suffix}`);
            if (exists(original) && !exists(archived)) { assertFile(original); fs.copyFileSync(original, archived, fs.constants.COPYFILE_EXCL); syncFile(archived); }
          }
          snapshot(work.workspaceDbPath, path.join(generation, `source-workspace-${index}.db`));
        }
        progress(dependencies, 'snapshot', index + 1, journal.source.workspaces.length, journal);
        await yieldLoop();
      }
      journal.snapshotHashes = fs.readdirSync(generation).map(name => ({ name, sha256: sha256File(path.join(generation, name)) }));
      journal.snapshotsReady = true; writeJournal(input, journal);
    }
    if (!journal.converted) {
      for (const archived of journal.snapshotHashes) {
        if (path.basename(archived.name) !== archived.name || sha256File(path.join(snapshotDirectory(input, journal), archived.name)) !== archived.sha256) fail('MIGRATION_ARCHIVE_CHANGED');
      }
      journal.stage = 'convert'; writeJournal(input, journal);
      journal.files = await convertSnapshots(input, journal, dependencies);
      journal.converted = true; journal.stage = 'verify'; writeJournal(input, journal);
    }
    for (const [index, file] of journal.files.entries()) {
      checkpoint(dependencies);
      if (!file.published && (exists(file.staged) ? sha256File(file.staged) !== file.sha256
        : !exists(file.target) || sha256File(file.target) !== file.sha256)) fail('MIGRATION_STAGING_CHANGED');
      progress(dependencies, 'verify', index + 1, journal.files.length, journal);
    }
    journal.stage = 'publish'; writeJournal(input, journal);
    for (const [index, file] of journal.files.entries()) {
      checkpoint(dependencies); publishFile(input, journal, file);
      progress(dependencies, 'publish', index + 1, journal.files.length, journal);
      dependencies.afterPublish?.({ target: file.target });
      await yieldLoop();
    }
    withDatabase(path.join(input.dataDir, 'codeflowai.db'), true, db => {
      for (const source of journal.source.workspaces) if (!new WorkspaceRepo(db).getIncludingDeleted(mappedWorkspaceId(source.id, journal.source.sourceClientId, input.targetClientId) as WorkspaceId)) fail('MIGRATION_REGISTRATION_INCOMPLETE');
    });
    journal.completed = true; journal.stage = 'completed'; journal.errorCode = null; writeJournal(input, journal);
    validateCompleted(input, journal);
    return await journalResult(journal, dependencies);
  } catch (error) {
    failure = error; journal.errorCode = errorCode(error); writeJournal(input, journal); throw error;
  } finally {
    const errors: unknown[] = [];
    for (const lock of locks.reverse()) { try { lock.release(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...errors], 'MIGRATION_LOCK_RELEASE_FAILED', { cause: failure });
  }
}

/** 扫描仅限当前用户的已知目录；先排除明确加密，再向原 Server 只读确认账号。 */
async function discoverSource(input: Input, dependencies: LegacyClientMigrationDependencies): Promise<Source | null> {
  checkpoint(dependencies);
  const home = path.resolve(dependencies.homeDir ?? os.homedir()), sourceDir = path.join(home, '.codeflowai');
  const configPath = path.join(sourceDir, 'config.json');
  if (!exists(configPath)) return null;
  const config = readSourceConfig(configPath);
  const paths = [path.join(sourceDir, 'codeflowai.db')];
  const accounts = path.join(sourceDir, 'client-dbs');
  if (exists(accounts)) {
    assertDirectory(accounts);
    for (const entry of fs.readdirSync(accounts, { withFileTypes: true })) {
      if (!/^acct_[A-Za-z0-9_-]{8,80}$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('SOURCE_PATH_UNSAFE');
      paths.push(path.join(accounts, entry.name, 'codeflowai.db'));
    }
  }
  const plain: Array<{ dbPath: string; meta: Row }> = [];
  let encrypted = false;
  for (const dbPath of paths) {
    if (!exists(dbPath) && !exists(`${dbPath}.meta.json`)) continue;
    const meta = exists(`${dbPath}.meta.json`) ? readObject(`${dbPath}.meta.json`) : {};
    if (meta.encryptionMode === 'server_managed_sqlcipher' && meta.cipher === 'sqlcipher'
      && typeof meta.dbId === 'string' && Number.isSafeInteger(meta.keyVersion) && meta.keyVersion > 0) { encrypted = true; continue; }
    plain.push({ dbPath, meta });
  }
  if (!plain.length) return null;
  if (!config.clientId) fail('SOURCE_CLIENT_ID_MISSING');
  let accountNamespace: string;
  try { accountNamespace = await (dependencies.resolveNamespace ?? resolveNamespace)(config); }
  catch (error) {
    checkpoint(dependencies);
    if (!encrypted || errorCode(error) !== 'SOURCE_ACCOUNT_UNRESOLVED') throw error;
    // 用户确认：仅混合目录的账号认证不可用允许本次不提醒；不猜归属、不写标记，下次启动重新只读检测。
    process.stderr.write(`${JSON.stringify({ event: 'LEGACY_MIGRATION_DISCOVERY_DEFERRED', errorCode: 'SOURCE_ACCOUNT_UNRESOLVED',
      requestId: 'legacy-discovery', sourceClientId: config.clientId, targetClientId: input.targetClientId, stage: 'discover',
      rootCause: { code: errorCode(error), type: error instanceof Error ? 'Error' : typeof error } })}\n`);
    return null;
  }
  if (!/^acct_[A-Za-z0-9_-]{8,80}$/.test(accountNamespace)) fail('SOURCE_ACCOUNT_UNRESOLVED');
  const matching = plain.filter(entry => entry.meta.accountNamespace === accountNamespace
    || path.basename(path.dirname(entry.dbPath)) === accountNamespace);
  if (matching.length > 1) fail('SOURCE_ACCOUNT_AMBIGUOUS');
  if (!matching.length) {
    if (plain.some(entry => entry.meta.accountNamespace === undefined)) fail('SOURCE_OWNERSHIP_UNKNOWN');
    return null;
  }
  const entry = matching[0]!, meta = entry.meta;
  if (!exists(entry.dbPath)) fail('SOURCE_FILE_MISSING');
  assertFile(entry.dbPath);
  if (!plainHeader(entry.dbPath)) fail('SOURCE_FORMAT_UNKNOWN');
  if (meta.schemaVersion !== 2 || meta.storageMode !== 'plain_sqlite' || meta.initializationState !== 'ready'
    || !['ed25519', 'runtime'].includes(meta.deviceAuthMode)) fail('SOURCE_META_UNSUPPORTED');
  if (samePath(entry.dbPath, path.join(input.dataDir, 'codeflowai.db'))) fail('SOURCE_TARGET_OVERLAP');
  const source = withDatabase(entry.dbPath, true, db => {
    assertApplicationSource(db); integrity(db);
    if (metaValue(db, 'client_id') !== config.clientId) fail('SOURCE_CLIENT_ID_MISMATCH');
    const workspaces = new WorkspaceRepo(db).list({ includeDeleted: true }).map(inspectSourceWorkspace);
    if (!workspaces.length) return null;
    const identity = workspaces.map(work => ({ id: work.id, path: fs.realpathSync.native(work.path), workspaceDbPath: work.workspaceDbPath }));
    const candidateId = sha256(JSON.stringify({ dbPath: fs.realpathSync.native(entry.dbPath), accountNamespace, clientId: config.clientId, identity }));
    return { dbPath: entry.dbPath, configPath, accountNamespace, sourceClientId: config.clientId, serverWs: config.serverWs, workspaces, candidateId };
  });
  return source;
}

/** 独占应用库后刷新最终注册清单，关闭期间新增的已提交工作区也进入同一闭包。 */
function refreshFrozenSource(source: Source): void {
  const meta = readObject(`${source.dbPath}.meta.json`), config = readSourceConfig(source.configPath);
  if (meta.accountNamespace !== source.accountNamespace || config.clientId !== source.sourceClientId || config.serverWs !== source.serverWs) fail('SOURCE_IDENTITY_CHANGED');
  source.workspaces = withDatabase(source.dbPath, true, db => {
    assertApplicationSource(db);
    if (metaValue(db, 'client_id') !== source.sourceClientId) fail('SOURCE_CLIENT_ID_MISMATCH');
    return new WorkspaceRepo(db).list({ includeDeleted: true }).map(inspectSourceWorkspace);
  });
  const paths = source.workspaces.map(work => pathKey(fs.realpathSync.native(work.path)));
  if (new Set(paths).size !== paths.length) fail('SOURCE_WORKSPACE_PATH_AMBIGUOUS');
}

/** 已注册物理工作区及其分库必须能证明归属；同路径不明数据不能认领。 */
function inspectSourceWorkspace(work: PersistedWorkspace): Source['workspaces'][number] {
  assertDirectory(work.path);
  const directory = inspectExistingWorkspaceCodeflowaiDirectory(work.path, '.codeflow');
  const workspaceDbPath = directory ? inspectWorkspaceCodeflowaiFile(directory, 'workspace.db')?.path ?? null : null;
  if (directory && !workspaceDbPath && SIDECARS.some(suffix => inspectWorkspaceCodeflowaiFile(directory, `workspace.db${suffix}`))) fail('SOURCE_ORPHAN_SIDECAR');
  if (workspaceDbPath) withDatabase(workspaceDbPath, true, workspace => { assertWorkspaceDbReadOnlySchema(workspace); assertWorkspaceOwnership(workspace, work.id); integrity(workspace); });
  return { ...work, workspaceDbPath };
}

/** 只读既有账号命名空间入口；失败不暴露远端正文或回显 Key。 */
async function resolveNamespace(config: SourceConfig): Promise<string> {
  const url = new URL(config.serverWs);
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('SOURCE_SERVER_INVALID');
  url.protocol = url.protocol.replace('ws', 'http'); url.pathname = '/api/client-db/startup-context'; url.search = ''; url.hash = '';
  let response: Response;
  try { response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: process.platform, arch: process.arch }), signal: AbortSignal.timeout(10_000), redirect: 'error' }); }
  catch (error) { throw migrationError('SOURCE_ACCOUNT_UNRESOLVED', error); }
  if (!response.ok) fail('SOURCE_ACCOUNT_UNRESOLVED');
  let body: Row;
  try { body = await response.json() as Row; } catch (error) { throw migrationError('SOURCE_ACCOUNT_UNRESOLVED', error); }
  if (body?.ok !== true || typeof body.accountNamespace !== 'string') fail('SOURCE_ACCOUNT_UNRESOLVED');
  return body.accountNamespace;
}

/** 只停止来源 DB 锁与 daemon owner 能互证的实例，拒绝未知前台进程。 */
async function stopLegacyOwner(source: Source, dependencies: LegacyClientMigrationDependencies): Promise<void> {
  const sourceDir = path.dirname(source.configPath), daemonPath = path.join(sourceDir, 'client-daemon.json');
  const liveLocks = [source.dbPath, ...source.workspaces.flatMap(work => work.workspaceDbPath ? [work.workspaceDbPath] : [])]
    .map(dbPath => ({ dbPath, lockPath: buildClientProcessLockPath(dbPath) }))
    .filter(entry => exists(entry.lockPath)).map(entry => ({ ...entry, lock: readObject(entry.lockPath) }))
    .filter(entry => processRunning(entry.lock.pid));
  const state = exists(daemonPath) ? readObject(daemonPath) : null;
  if (!state) { if (liveLocks.length) fail('SOURCE_OWNER_UNVERIFIED'); return; }
  if (!processRunning(state.supervisorPid ?? state.pid) && !processRunning(state.clientPid ?? state.pid)) {
    if (liveLocks.length) fail('SOURCE_OWNER_UNVERIFIED'); return;
  }
  if (state.schemaVersion !== 2 || typeof state.supervisorToken !== 'string' || !Number.isInteger(state.supervisorPid)
    || !liveLocks.length || liveLocks.some(entry => entry.lock.pid !== state.clientPid || entry.lock.clientId !== source.sourceClientId
      || !samePath(entry.lock.dbPath, entry.dbPath))) fail('SOURCE_OWNER_UNVERIFIED');
  const supervisorLock = path.join(sourceDir, 'client-daemon-supervisor.lock');
  const owner = readObject(supervisorLock);
  if (owner.token !== state.supervisorToken || owner.pid !== state.supervisorPid) fail('SOURCE_OWNER_UNVERIFIED');
  const { requestVerifiedDaemonSupervisorStop } = await import('../clientDaemon.js');
  await requestVerifiedDaemonSupervisorStop(supervisorLock, state.supervisorToken, state.supervisorPid);
  const deadline = Date.now() + 15_000;
  while (processRunning(state.supervisorPid) || processRunning(state.clientPid)) {
    checkpoint(dependencies); if (Date.now() >= deadline) fail('SOURCE_STOP_TIMEOUT'); await delay(50);
  }
}

/** SQLite 自身生成含 WAL 已提交内容的一致性副本；已存在归档只接受完整有效库。 */
function snapshot(source: string, target: string): void {
  assertFile(source);
  if (exists(target)) { withDatabase(target, true, integrity); return; }
  const temporary = `${target}.snapshot`;
  if (exists(temporary)) fs.unlinkSync(temporary);
  withDatabase(source, true, db => { integrity(db); db.prepare('VACUUM INTO ?').run(temporary); });
  withDatabase(temporary, true, integrity); syncFile(temporary); fs.renameSync(temporary, target); syncDirectory(path.dirname(target));
}

/** 使用现有 schema 转换快照；覆盖基线固定取原始归档，不接纳中断后的来源写入。 */
async function convertSnapshots(input: Input, journal: Journal, dependencies: LegacyClientMigrationDependencies): Promise<PublishedFile[]> {
  const archive = archiveDirectory(input, journal), appPath = path.join(archive, 'target-application.db');
  removeOwnedTemporary(appPath);
  fs.copyFileSync(path.join(snapshotDirectory(input, journal), 'source-application.db'), appPath, fs.constants.COPYFILE_EXCL);
  const files: PublishedFile[] = [];
  const eventSequences = new Set<number>();
  const app = openSqliteDb(appPath, { fileMustExist: true });
  let failure: unknown;
  try {
    assertApplicationSource(app); migrateClientDb(app); dropRetiredTables(app);
    assertKnownTables(app);
    if ((app.prepare("SELECT operation_id FROM workspace_directory_migrations WHERE state NOT IN ('completed','cancelled','failed') LIMIT 1").get())) fail('SOURCE_WORKSPACE_MOVE_ACTIVE');
    const mapping = new Map(journal.source.workspaces.map(work => [String(work.id), mappedWorkspaceId(work.id, journal.source.sourceClientId, input.targetClientId)]));
    for (const [oldId, newId] of mapping) new WorkspaceRepo(app).migrateWorkspaceId(oldId as WorkspaceId, newId as WorkspaceId);
    rewriteBusinessReferences(app, mapping);
    let highWater = validCounter(metaValue(app, 'event_seq'));
    for (let index = 0; index < journal.source.workspaces.length; index++) {
      checkpoint(dependencies);
      const source = journal.source.workspaces[index]!, id = mapping.get(source.id)!;
      const target = path.join(source.path, '.codeflow', 'workspace.db');
      const directory = ensureWorkspaceCodeflowaiDirectory(source.path, '.codeflow');
      const staged = path.join(directory.directoryPath, `legacy-migration-${journal.migrationId}.db`);
      removeOwnedTemporary(staged);
      const workspace = openSqliteDb(staged);
      let workFailure: unknown;
      try {
        migrateClientDb(workspace, { scope: 'workspace' }); ensureWorkspaceCoreQueueTables(workspace); ensureWorkspaceAdditionalTables(workspace);
        copyWorkspaceRows(app, workspace, id, false);
        if (source.workspaceDbPath) {
          const converted = path.join(archive, `converted-workspace-${index}.db`); removeOwnedTemporary(converted);
          fs.copyFileSync(path.join(snapshotDirectory(input, journal), `source-workspace-${index}.db`), converted, fs.constants.COPYFILE_EXCL);
          withDatabase(converted, false, previous => {
            assertKnownTables(previous); assertWorkspaceOwnership(previous, source.id);
            dropRetiredTables(previous);
            migrateClientDb(previous, { scope: 'workspace' }); ensureWorkspaceCoreQueueTables(previous); ensureWorkspaceAdditionalTables(previous);
            rewriteBusinessReferences(previous, mapping);
            for (const table of listTables(previous)) {
              const cols = columns(previous, table);
              if (cols.includes('workspace_id')) previous.prepare(`UPDATE ${quote(table)} SET workspace_id=? WHERE workspace_id=?`).run(id, source.id);
              if (cols.includes('workspace_scope_id')) previous.prepare(`UPDATE ${quote(table)} SET workspace_scope_id=? WHERE workspace_scope_id=?`).run(id, source.id);
            }
            copyWorkspaceRows(previous, workspace, id, true);
            const oldFloor = readWorkspaceEventSeqFloor(previous);
            if (oldFloor > 0) recordWorkspaceEventSeqFloor(workspace, oldFloor);
          });
        }
        pauseExecution(workspace, input, id);
        await verifyWorkspace(workspace, id, source.path);
        for (const row of workspace.prepare('SELECT seq FROM conversation_events UNION ALL SELECT seq FROM raw_engine_events').all() as Row[]) {
          if (eventSequences.has(row.seq)) fail('SOURCE_EVENT_SEQUENCE_CONFLICT'); eventSequences.add(row.seq);
        }
        const floor = referenceHighWater(workspace); if (floor > 0) recordWorkspaceEventSeqFloor(workspace, floor);
        highWater = Math.max(highWater, floor);
        integrity(workspace);
      } catch (error) { workFailure = error; throw error; }
      finally { closeDatabase(workspace, workFailure); }
      syncFile(staged); assertWorkspaceCodeflowaiDirectory(directory);
      files.push({ target, staged, sha256: sha256File(staged), originalSha256: source.workspaceDbPath
        ? sha256File(path.join(snapshotDirectory(input, journal), `original-workspace-${index}.db`)) : null, published: false });
      progress(dependencies, 'convert', index + 1, journal.source.workspaces.length, journal);
      await yieldLoop();
    }
    cleanApplicationWorkspaceRows(app, mapping);
    pauseExecution(app, input, null);
    app.prepare("UPDATE meta SET value=? WHERE key='client_id'").run(input.targetClientId);
    app.prepare("UPDATE meta SET value=? WHERE key='event_seq'").run(String(highWater));
    app.prepare("UPDATE engine_keys SET is_active=0, api_key='', secret_ref=NULL WHERE source='builtin'").run();
    integrity(app);
    app.pragma('wal_checkpoint(TRUNCATE)'); app.pragma('journal_mode = DELETE');
  } catch (error) { failure = error; throw error; }
  finally { closeDatabase(app, failure); }
  syncFile(appPath);
  const targetConfig = path.join(input.dataDir, 'config.json');
  if (exists(targetConfig) && readObject(targetConfig).clientId !== input.targetClientId) fail('TARGET_IDENTITY_CONFLICT');
  const configStaged = path.join(archive, 'target-config.json');
  writeAtomic(configStaged, { ...(exists(targetConfig) ? readObject(targetConfig) : {}), clientId: input.targetClientId, apiKey: '', serverWs: readSourceConfig(journal.source.configPath).serverWs });
  files.push({ target: targetConfig, staged: configStaged, sha256: sha256File(configStaged), originalSha256: exists(targetConfig) ? sha256File(targetConfig) : null, published: false });
  const metaStaged = path.join(archive, 'target-meta.json');
  writeAtomic(metaStaged, { schemaVersion: 3, storageMode: 'plain_sqlite', ownership: 'local_os_user', initializationState: 'ready' });
  files.push({ target: path.join(input.dataDir, 'codeflowai.db.meta.json'), staged: metaStaged, sha256: sha256File(metaStaged), originalSha256: journal.targetInitialization?.metaSha256 ?? null, published: false });
  files.push({ target: path.join(input.dataDir, 'codeflowai.db'), staged: appPath, sha256: sha256File(appPath), originalSha256: journal.targetInitialization?.dbSha256 ?? null, published: false });
  return files;
}

/** 表清单限定当前支持语义；按 workspace/thread/父实体闭包提取，冲突绝不忽略。 */
function copyWorkspaceRows(source: SqliteDb, target: SqliteDb, id: string, whole: boolean): void {
  source.pragma('foreign_keys = ON'); target.pragma('foreign_keys = OFF');
  try {
    target.transaction(() => {
      for (const table of WORKSPACE_TABLES) {
        if (!hasTable(source, table)) continue;
        const predicate = whole ? '1' : workspacePredicate(source, table, id);
        if (!predicate) fail('SOURCE_TABLE_OWNERSHIP_UNSUPPORTED');
        const rows = source.prepare(`SELECT * FROM ${quote(table)} WHERE ${predicate}`).all() as Row[];
        if (!rows.length) continue;
        const names = columns(source, table), targetNames = columns(target, table);
        if (names.some(name => !targetNames.includes(name))) fail('SOURCE_SCHEMA_UNSUPPORTED');
        const before = tableCount(target, table);
        const insert = target.prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`);
        for (const row of rows) {
          try { insert.run(...names.map(name => row[name])); }
          catch (error) { throw migrationError('SOURCE_LAYOUT_CONFLICT', error); }
        }
        const count = Number((target.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as Row).count);
        if (count - before !== rows.length) fail('MIGRATION_ROW_COUNT_MISMATCH');
      }
      if (whole && hasTable(source, 'meta')) {
        for (const row of source.prepare('SELECT key,value FROM meta').all() as Array<{ key: string; value: string }>) {
          if (!row.key.startsWith('engine_native_fallback_block:')) continue;
          target.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(row.key, row.value);
        }
      }
    })();
  } finally { target.pragma('foreign_keys = ON'); }
}

/** 集中库按已有实体键关联；无 FK 的业务表在这里明确归属，禁止扫表后默认丢弃。 */
function workspacePredicate(db: SqliteDb, table: string, id: string): string | null {
  const literal = sqlString(id), cols = columns(db, table);
  if (table === 'scheduled_task_runtime_states') {
    const accountKeys = (db.prepare('SELECT * FROM scheduled_task_account_configs WHERE workspace_id=?').all(id) as Row[])
      .map(row => sqlString(scheduledTaskAccountRuntimeKey(row.task_id, { serverOrigin: row.server_origin, ownerUserId: row.owner_user_id, clientId: row.client_id, deviceId: row.device_id })));
    return `task_id IN (SELECT '__local_scheduled_task__:' || id FROM scheduled_task_configs WHERE workspace_scope_id=${literal})${accountKeys.length ? ` OR task_id IN (${accountKeys.join(',')})` : ''}`;
  }
  if (table === 'workspace_execution_profiles') return `(scope_type='local_workspace' AND scope_id=${literal})
    OR (scope_type='shared_workspace' AND scope_id IN (SELECT shared_workspace_id FROM threads WHERE workspace_id=${literal}
      UNION SELECT shared_workspace_id FROM thread_groups WHERE workspace_id=${literal}))`;
  if (table === 'scheduled_task_configs') return `workspace_scope_type='local_workspace' AND workspace_scope_id=${literal}`;
  if (cols.includes('workspace_id')) return `workspace_id=${literal}`;
  const threads = `SELECT id FROM threads WHERE workspace_id=${literal}`;
  if (table === 'file_blobs') return `blob_id IN (
    SELECT before_blob_id FROM turn_file_changes WHERE thread_id IN (${threads}) UNION
    SELECT after_blob_id FROM turn_file_changes WHERE thread_id IN (${threads}) UNION
    SELECT accepted_blob_id FROM turn_file_changes WHERE thread_id IN (${threads}) UNION
    SELECT blob_id FROM thread_draft_attachments WHERE thread_id IN (${threads}) UNION
    SELECT a.blob_id FROM thread_message_queue_attachments a JOIN thread_message_queue q ON q.id=a.queue_item_id WHERE q.thread_id IN (${threads}))`;
  if (table === 'thread_message_queue_attachments') return `queue_item_id IN (SELECT id FROM thread_message_queue WHERE workspace_id=${literal})`;
  if (table === 'chat_workflow_actions') return `task_id IN (SELECT id FROM chat_workflow_tasks WHERE workspace_id=${literal})`;
  if (cols.includes('instance_id')) return `instance_id IN (SELECT id FROM orch_instances WHERE workspace_id=${literal})`;
  if (cols.includes('artifact_id')) return `artifact_id IN (SELECT id FROM orch_artifacts WHERE instance_id IN (SELECT id FROM orch_instances WHERE workspace_id=${literal}))`;
  if (cols.includes('session_id')) return `session_id IN (SELECT id FROM orch_requirement_analysis_sessions WHERE workspace_id=${literal})`;
  if (cols.includes('job_id')) return `job_id IN (SELECT id FROM orch_asset_generation_jobs WHERE workspace_id=${literal})`;
  if (cols.includes('skill_id')) return `skill_id IN (SELECT id FROM orch_skills WHERE workspace_id=${literal})`;
  if (cols.includes('snapshot_id')) return `snapshot_id IN (SELECT id FROM controlled_experiment_snapshots WHERE workspace_id=${literal})`;
  if (cols.includes('thread_id')) return `thread_id IN (${threads})`;
  return null;
}

/** 移出的工作区事实只留在 W；个人资产和应用定时历史仍由现有应用库拥有。 */
function cleanApplicationWorkspaceRows(db: SqliteDb, mapping: Map<string, string>): void {
  const selected = new Map<string, Row[]>();
  for (const table of WORKSPACE_TABLES) {
    if (!hasTable(db, table)) continue;
    const conditions = [...mapping.values()].map(id => workspacePredicate(db, table, id)).filter(Boolean);
    if (conditions.length) selected.set(table, db.prepare(`SELECT rowid AS migration_rowid FROM ${quote(table)} WHERE ${conditions.map(value => `(${value})`).join(' OR ')}`).all() as Row[]);
  }
  db.pragma('foreign_keys = OFF');
  try { db.transaction(() => {
    for (const [table, rows] of selected) {
      const statement = db.prepare(`DELETE FROM ${quote(table)} WHERE rowid=?`);
      for (const row of rows) statement.run(row.migration_rowid);
    }
    for (const table of CACHE_TABLES) db.prepare(`DELETE FROM ${quote(table)}`).run();
  })(); } finally { db.pragma('foreign_keys = ON'); }
}

/** 结构化 ID 字段才改写；原始 trace、提示词和自由正文保留原字节语义。 */
function rewriteBusinessReferences(db: SqliteDb, mapping: Map<string, string>): void {
  for (const table of listTables(db)) {
    if (CACHE_TABLES.includes(table) || table.endsWith('_fts') || table.includes('_fts_')) continue;
    const jsonColumns = columns(db, table).filter(column => column.endsWith('_json'));
    if (!jsonColumns.length) continue;
    const digestColumn = table === 'orch_node_attempts' ? 'submission_hash' : table === 'code_attribution_outbox' ? 'content_sha256' : null;
    for (const row of db.prepare(`SELECT rowid AS migration_rowid, ${[...jsonColumns, ...(digestColumn ? [digestColumn] : [])].map(quote).join(',')} FROM ${quote(table)}`).all() as Row[]) {
      for (const column of jsonColumns) {
        const raw = row[column]; if (raw === null || raw === undefined || raw === '') continue;
        let value: any; try { value = JSON.parse(raw); } catch (error) { throw migrationError('SOURCE_JSON_INVALID', error); }
        if (table === 'orch_node_attempts' && column === 'submission_json'
          && hashOrchNodeAttemptSubmission(value).submissionHash !== row.submission_hash) fail('SOURCE_SUBMISSION_HASH_INVALID');
        if (table === 'code_attribution_outbox' && column === 'payload_json') {
          serializeCodeAttributionOutboxPayload(value);
          if (sha256(raw) !== row.content_sha256) fail('SOURCE_ATTRIBUTION_HASH_INVALID');
        }
        if (table === 'raw_engine_events') {
          if (value && mapping.has(value.workspaceId)) value.workspaceId = mapping.get(value.workspaceId);
        } else rewriteJson(value, mapping);
        const changed = JSON.stringify(value);
        if (changed !== JSON.stringify(JSON.parse(raw))) {
          if (table === 'controlled_experiment_snapshots') fail('SOURCE_HASHED_REFERENCE_UNSUPPORTED');
          if (table === 'orch_node_attempts' && column === 'submission_json') {
            const hashed = hashOrchNodeAttemptSubmission(value);
            db.prepare('UPDATE orch_node_attempts SET submission_json=?,submission_hash=? WHERE rowid=?').run(hashed.submissionJson, hashed.submissionHash, row.migration_rowid);
          } else if (table === 'code_attribution_outbox' && column === 'payload_json') {
            const serialized = serializeCodeAttributionOutboxPayload(value);
            db.prepare('UPDATE code_attribution_outbox SET payload_json=?,content_sha256=? WHERE rowid=?').run(serialized, sha256(serialized), row.migration_rowid);
          } else db.prepare(`UPDATE ${quote(table)} SET ${quote(column)}=? WHERE rowid=?`).run(changed, row.migration_rowid);
        }
      }
    }
  }
  for (const [oldId, newId] of mapping) {
    if (hasTable(db, 'scheduled_task_configs')) db.prepare('UPDATE scheduled_task_configs SET workspace_scope_id=? WHERE workspace_scope_id=?').run(newId, oldId);
    if (hasTable(db, 'workspace_execution_profiles')) db.prepare("UPDATE workspace_execution_profiles SET scope_id=? WHERE scope_type='local_workspace' AND scope_id=?").run(newId, oldId);
  }
}

/** 仅递归已声明的业务 ID 键及 ID 数组，不替换文本内容或原始协议载荷。 */
function rewriteJson(value: any, mapping: Map<string, string>): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, current] of Object.entries(value)) {
    if (REFERENCE_KEYS.has(key) && typeof current === 'string') {
      if (mapping.has(current)) value[key] = mapping.get(current);
      else if ([...mapping.keys()].some(id => id.includes(':') && current.startsWith(id.slice(0, id.indexOf(':') + 1)))) fail('SOURCE_REFERENCE_INVALID');
    }
    else if (key === 'workspaceIds' && Array.isArray(current)) value[key] = current.map(id => typeof id === 'string' ? mapping.get(id) ?? id : id);
    else if (!['raw', 'rawEvent', 'prompt', 'text', 'content'].includes(key)) rewriteJson(current, mapping);
  }
}

/** 执行入口暂停并沿原仓储收口未完成启动；卡片状态与 JSON 保持一致，不重跑成功事实。 */
function pauseExecution(db: SqliteDb, input: Input, workspaceId: string | null): void {
  removeRemoteMetadata(db, workspaceId !== null);
  const now = Date.now();
  const queue = new ThreadQueueStateRepo(db);
  for (const row of db.prepare('SELECT id,workspace_id FROM threads').all() as Row[]) queue.pause(row.id as ThreadId, row.workspace_id as WorkspaceId, 'user_pause');
  db.prepare("UPDATE thread_turns SET status='error', ended_at=? WHERE status='started' AND ended_at IS NULL").run(now);
  db.prepare("UPDATE thread_message_queue SET status='failed',failure_code='LEGACY_MIGRATION_SEND_INTERRUPTED',failure_reason='迁移前发送结果未确认，请核对历史后处理',updated_at=? WHERE status='sending'").run(now);
  const summaries = new OrchInstanceSummaryProjectionReader(db);
  const instances = new OrchInstanceRepo(db, new OrchIntakeListStateRepo(db, summaries), summaries);
  for (const row of db.prepare("SELECT id FROM orch_instances WHERE status IN ('pending','running','waiting-start','waiting-approval','waiting-feedback')").all() as Row[]) instances.updateStatus(row.id as OrchestrationId, 'paused');
  db.prepare("UPDATE orch_asset_generation_jobs SET status='failed',failure_json=?,updated_at=? WHERE status IN ('queued','planning','collecting_context','generating','validating')")
    .run(JSON.stringify({ code: 'LEGACY_MIGRATION_PAUSED', message: '迁移后需人工恢复' }), now);
  new ChatWorkflowRepo(db).recoverStarts();
  db.prepare("UPDATE chat_workflow_actions SET state='interrupted',updated_at=? WHERE state='processing'").run(now);
  db.prepare("UPDATE scheduled_task_configs SET enabled=0,client_id=?,device_id=?").run(input.targetClientId, input.targetDeviceId);
  db.prepare("UPDATE scheduled_task_runs SET client_id=?,device_id=? WHERE source='local'").run(input.targetClientId, input.targetDeviceId);
  db.prepare("UPDATE scheduled_task_runs SET status='failed',finished_at=?,duration_ms=CASE WHEN started_at IS NULL THEN NULL ELSE MAX(0,?-started_at) END,error_message='LEGACY_MIGRATION_PAUSED' WHERE status='running'").run(now, now);
  db.prepare("UPDATE scheduled_task_runtime_states SET running_run_id=NULL,queued_scheduled_at=NULL,queued_reason=NULL,queued_operation_id=NULL,client_id=?,device_id=? WHERE task_id LIKE '__local_scheduled_task__:%'").run(input.targetClientId, input.targetDeviceId);
  for (const table of ['code_attribution_outbox', 'code_attribution_retention_tasks']) {
    db.prepare(`UPDATE ${quote(table)} SET status='failed',available_at=?,lease_owner=NULL,lease_expires_at=NULL,last_error_code='LEGACY_MIGRATION_PAUSED'`).run(Number.MAX_SAFE_INTEGER);
  }
  db.prepare('UPDATE code_attribution_outbox SET association_expires_at=0').run();
  db.prepare("UPDATE controlled_experiment_runs SET status='cancelled',completed_at=?,error_code='LEGACY_MIGRATION_PAUSED',status_version=status_version+1 WHERE status IN ('dispatched','running','cancel_requested')").run(now);
}

/** 核对信封及正文引用；产物沿工作区真实路径解析，越界或摘要损坏均阻断发布。 */
async function verifyWorkspace(db: SqliteDb, id: string, workspacePath: string): Promise<void> {
  assertWorkspaceOwnership(db, id);
  for (const table of ['conversation_events', 'raw_engine_events']) {
    for (const row of db.prepare(`SELECT e.seq,e.thread_id,e.workspace_id,e.engine,e.event_json,
      t.workspace_id AS parent_workspace_id,t.engine AS parent_engine FROM ${table} e LEFT JOIN threads t ON t.id=e.thread_id`).all() as Row[]) {
      const value = JSON.parse(row.event_json);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.workspaceId !== row.workspace_id
        || value.threadId !== row.thread_id || value.seq !== row.seq) fail('SOURCE_EVENT_REFERENCE_INVALID');
      if (table === 'conversation_events' && (value.schema !== 1 || !Number.isSafeInteger(value.seq) || value.seq <= 0
        || typeof value.workspaceId !== 'string' || !value.workspaceId.trim() || row.workspace_id !== row.parent_workspace_id
        || !['codex', 'claude'].includes(value.engine) || value.engine !== row.engine || row.engine !== row.parent_engine
        || !Number.isSafeInteger(value.ts) || value.ts < 0 || typeof value.type !== 'string' || !value.type.trim()
        || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload))) fail('SOURCE_CANONICAL_EVENT_INVALID');
    }
  }
  const blobs = new FileBlobRepo(db);
  const threads = (db.prepare('SELECT id FROM threads').all() as Row[]).map(row => row.id as ThreadId);
  const canonical = new ConversationEventRepo(db);
  const raw = new RawEngineEventRepo(db);
  for (const threadId of threads) {
    try { await canonical.ensurePresentation(threadId); }
    catch (error) { throw migrationError('SOURCE_CANONICAL_EVENT_INVALID', error); }
    let beforeSeq: number | null = null;
    do {
      let page;
      try { page = raw.pageByThread(threadId, { beforeSeq, limit: 2_000 }); }
      catch (error) { throw migrationError('SOURCE_RAW_EVENT_INVALID', error); }
      beforeSeq = page.events.length ? page.nextBeforeSeq : null;
    } while (beforeSeq !== null);
  }
  for (const reference of blobs.collectReferencedByThreadIds(threads)) {
    const blob = blobs.get(reference.blobId);
    if (!blob || blob.data.length !== blob.byteLen || sha256(blob.data) !== blob.blobId) fail('SOURCE_BLOB_INVALID');
  }
  for (const table of ['thread_draft_attachments', 'thread_message_queue_attachments']) {
    if (db.prepare(`SELECT 1 FROM ${table} a LEFT JOIN file_blobs b ON b.blob_id=a.blob_id WHERE b.blob_id IS NULL OR a.size<>b.byte_len LIMIT 1`).get()) fail('SOURCE_BLOB_INVALID');
  }
  if (db.prepare('SELECT 1 FROM chat_workflow_actions a LEFT JOIN chat_workflow_tasks t ON t.id=a.task_id WHERE t.id IS NULL LIMIT 1').get()) fail('SOURCE_REFERENCE_INVALID');
  for (const row of db.prepare('SELECT staging_path,published_path,content_hash,size_bytes FROM orch_artifact_files').all() as Row[]) {
    const storedPath = row.published_path || row.staging_path;
    if (!storedPath) continue;
    const file = resolveWorkspaceReadPath(workspacePath, storedPath);
    assertFile(file);
    if (row.size_bytes !== null && fs.statSync(file).size !== row.size_bytes || row.content_hash && sha256File(file) !== row.content_hash) fail('SOURCE_ARTIFACT_INVALID');
  }
}

/** 远端投递/权限缓存不授予新身份；工作区仅保留已知本地 schema 与提交下界。 */
function removeRemoteMetadata(db: SqliteDb, workspace: boolean): void {
  db.prepare(`UPDATE orch_instances SET asset_runtime_snapshot_json=json_remove(asset_runtime_snapshot_json,'$.executionAuthorization')
    WHERE asset_runtime_snapshot_json IS NOT NULL AND json_type(asset_runtime_snapshot_json,'$.executionAuthorization') IS NOT NULL`).run();
  for (const row of db.prepare('SELECT key FROM meta').all() as Array<{ key: string }>) {
    if (row.key.startsWith('conversation_relay:') || /^(?:last_acked_|last_ack_|raw_event_ack|conversation_event_ack|shared_lease:|shared_auth:|asset_cache:)/.test(row.key)
      || workspace && ['client_id', 'event_seq'].includes(row.key)) db.prepare('DELETE FROM meta WHERE key=?').run(row.key);
  }
}

/** 发布前复核归档与原目标；rename 后崩溃可由相同摘要认领，其他目标永不覆盖。 */
function publishFile(input: Input, journal: Journal, file: PublishedFile): void {
  if (file.published) { if (!exists(file.target) || sha256File(file.target) !== file.sha256) fail('MIGRATION_PUBLISHED_FILE_CHANGED'); return; }
  if (!exists(file.staged) && exists(file.target) && sha256File(file.target) === file.sha256) { file.published = true; writeJournal(input, journal); return; }
  if (exists(file.target)) {
    if (file.originalSha256 === null || sha256File(file.target) !== file.originalSha256) fail('TARGET_CONFLICT');
    if (path.basename(file.target) === 'codeflowai.db' && journal.targetInitialization) {
      for (const suffix of SIDECARS) {
        const sidecar = `${file.target}${suffix}`, archived = path.join(archiveDirectory(input, journal), `original-empty-application.db${suffix}`);
        if (!exists(sidecar)) continue;
        if (!exists(archived) || sha256File(sidecar) !== sha256File(archived)) fail('TARGET_CONFLICT');
        fs.unlinkSync(sidecar);
      }
    } else if (path.basename(file.target) === 'workspace.db') {
      const index = journal.source.workspaces.findIndex(work => samePath(path.join(work.path, '.codeflow', 'workspace.db'), file.target));
      const archived = path.join(snapshotDirectory(input, journal), `source-workspace-${index}.db`);
      if (index < 0 || !exists(archived)) fail('MIGRATION_ARCHIVE_MISSING');
      withDatabase(archived, true, integrity);
      for (const suffix of SIDECARS) {
        const sidecar = `${file.target}${suffix}`;
        if (!exists(sidecar)) continue;
        assertFile(sidecar);
        const archivedSidecar = path.join(snapshotDirectory(input, journal), `original-workspace-${index}.db${suffix}`);
        if (!exists(archivedSidecar) || sha256File(sidecar) !== sha256File(archivedSidecar)) fail('SOURCE_SIDECAR_CHANGED');
        fs.unlinkSync(sidecar);
      }
    }
  }
  fs.renameSync(file.staged, file.target); syncFile(file.target); syncDirectory(path.dirname(file.target));
  file.published = true; writeJournal(input, journal);
}

/** 完成事实只验稳定身份、完整性与已知版本；后续 schema 升级仍归正常 Client。 */
function validateCompleted(input: Input, journal: Journal): void {
  const config = readObject(path.join(input.dataDir, 'config.json'));
  if (config.clientId !== input.targetClientId) fail('TARGET_IDENTITY_CONFLICT');
  const meta = readObject(path.join(input.dataDir, 'codeflowai.db.meta.json'));
  if (meta.schemaVersion !== 3 || meta.ownership !== 'local_os_user' || meta.initializationState !== 'ready') fail('TARGET_META_CONFLICT');
  withDatabase(path.join(input.dataDir, 'codeflowai.db'), true, db => {
    if (metaValue(db, 'client_id') !== input.targetClientId) fail('TARGET_IDENTITY_CONFLICT');
    const version = Number(db.pragma('user_version', { simple: true }));
    if (db.pragma('application_id', { simple: true }) !== 0 || !Number.isInteger(version) || version < 83 || version > CLIENT_DB_SCHEMA_VERSION) fail('TARGET_SCHEMA_UNSUPPORTED');
    integrity(db);
  });
}

/** 完成响应的凭据只从原配置即时读取，绝不进入迁移记录。 */
async function journalResult(journal: Journal, dependencies: LegacyClientMigrationDependencies): Promise<LegacyClientMigrationResult> {
  const result: LegacyClientMigrationResult = { candidateId: journal.candidateId, workspaceCount: journal.source.workspaces.length,
    migrationId: journal.migrationId, completed: true };
  try {
    const config = readSourceConfig(journal.source.configPath);
    if (config.clientId !== journal.source.sourceClientId || config.serverWs !== journal.source.serverWs
      || await (dependencies.resolveNamespace ?? resolveNamespace)(config) !== journal.source.accountNamespace) fail('SOURCE_ACCOUNT_CHANGED');
    result.accountSource = { sourceClientId: config.clientId, apiKey: config.apiKey, serverWs: config.serverWs };
  } catch (error) {
    // 已确认仅账号恢复允许失败；本地完成仍放行，由宿主显示失败并提供账号重试/正常登录。
    process.stderr.write(`${JSON.stringify({ errorCode: 'SOURCE_ACCOUNT_SOURCE_UNAVAILABLE', requestId: journal.migrationId,
      migrationId: journal.migrationId, sourceClientId: journal.source.sourceClientId, stage: 'account_source',
      rootCause: { code: errorCode(error), type: error instanceof Error ? error.name : typeof error } })}\n`);
  }
  return result;
}

/** 普通库从已验证的历史 v83 起；未知表、列和高版本绝不借正常修复猜测。 */
function assertApplicationSource(db: SqliteDb): void {
  const version = Number(db.pragma('user_version', { simple: true }));
  if (db.pragma('application_id', { simple: true }) !== 0 || !Number.isInteger(version) || version < 83 || version > CLIENT_DB_SCHEMA_VERSION) fail('SOURCE_SCHEMA_UNSUPPORTED');
  assertKnownTables(db);
}

/** 退役表只保留在来源快照；FTS shadow 只接受已声明虚表对应的 SQLite 内部表。 */
function assertKnownTables(db: SqliteDb): void {
  const reference = openSqliteDb(':memory:');
  try {
    migrateClientDb(reference);
    const known = new Set(listTables(reference));
    for (const table of listTables(db)) {
      if (RETIRED_TABLES.includes(table)) continue;
      if (!known.has(table)) fail('SOURCE_TABLE_UNSUPPORTED');
      const expected = columns(reference, table);
      if (columns(db, table).some(column => !expected.includes(column))) fail('SOURCE_SCHEMA_UNSUPPORTED');
    }
  } finally { reference.close(); }
}

/** 只从目标临时副本移除已确认退役的表，来源数据库及其只读归档保持完整。 */
function dropRetiredTables(db: SqliteDb): void {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of RETIRED_TABLES) db.exec(`DROP TABLE IF EXISTS ${quote(table)}`);
  } finally { db.pragma('foreign_keys = ON'); }
}

/** 工作区库的所有直接归属必须与注册表一致，阻止认领同路径的其他 Client 数据。 */
function assertWorkspaceOwnership(db: SqliteDb, id: string): void {
  for (const table of listTables(db)) {
    if (table.includes('_fts_')) continue;
    const names = columns(db, table);
    for (const column of ['workspace_id', 'workspace_scope_id']) {
      if (names.includes(column) && db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL AND ${quote(column)}<>? LIMIT 1`).get(id)) fail('SOURCE_WORKSPACE_OWNERSHIP_CONFLICT');
    }
  }
}

/** 已提交事件及回滚/turn 引用保持同一序号空间，不使用远端 ACK 作为高水位。 */
function referenceHighWater(db: SqliteDb): number {
  let maximum = readWorkspaceEventSeqFloor(db);
  for (const [table, column] of [['thread_turns', 'start_event_seq'], ['thread_turns', 'end_event_seq'], ['thread_rollbacks', 'dropped_event_seq_gt']]) {
    const row = db.prepare(`SELECT MAX(${column}) AS maximum FROM ${table}`).get() as Row;
    if (row.maximum !== null) maximum = Math.max(maximum, validCounter(String(row.maximum)));
  }
  return maximum;
}

/** 新安装只能接收空目标；已持久身份允许复用，已有业务及 sidecar 一律冲突。 */
function assertEmptyTarget(input: Input): Journal['targetInitialization'] {
  const config = path.join(input.dataDir, 'config.json');
  if (exists(config) && (readObject(config).clientId !== input.targetClientId || readObject(config).apiKey)) fail('TARGET_IDENTITY_CONFLICT');
  const target = path.join(input.dataDir, 'codeflowai.db'), metaPath = `${target}.meta.json`;
  if (!exists(target)) {
    for (const suffix of [...SIDECARS, '.meta.json']) if (exists(`${target}${suffix}`)) fail('TARGET_CONFLICT');
    return null;
  }
  if (!exists(metaPath) || !plainHeader(target)) fail('TARGET_CONFLICT');
  const meta = readObject(metaPath);
  if (meta.schemaVersion !== 3 || meta.ownership !== 'local_os_user' || meta.storageMode !== 'plain_sqlite' || meta.initializationState !== 'ready') fail('TARGET_CONFLICT');
  withDatabase(target, true, db => {
    if (metaValue(db, 'client_id') !== input.targetClientId || db.pragma('user_version', { simple: true }) !== CLIENT_DB_SCHEMA_VERSION) fail('TARGET_CONFLICT');
    integrity(db); assertKnownTables(db);
    for (const table of listTables(db)) {
      if (['meta', 'workspaces', 'local_quick_phrase_collection'].includes(table) || table.includes('_fts_')) continue;
      if (tableCount(db, table)) fail('TARGET_CONFLICT');
    }
    const workspaces = new WorkspaceRepo(db).list({ includeDeleted: true });
    if (workspaces.length > 1 || workspaces.some(work => work.isDeleted || !samePath(work.path, path.join(input.dataDir, 'workspace')))) fail('TARGET_CONFLICT');
    if (exists(path.join(input.dataDir, 'workspace', '.codeflow', 'workspace.db'))) fail('TARGET_CONFLICT');
    for (const row of db.prepare('SELECT key,value FROM meta').all() as Row[]) {
      if (!['client_id', 'event_seq', 'conversation_presentation_schema_version'].includes(row.key)
        || row.key === 'event_seq' && row.value !== '0') fail('TARGET_CONFLICT');
    }
  });
  return { dbSha256: sha256File(target), metaSha256: sha256File(metaPath) };
}

/** 接管仅限已证明没有业务的默认初始化库，原字节和sidecar先归档。 */
function archiveEmptyInitialization(input: Input, journal: Journal): void {
  if (!journal.targetInitialization || journal.files.some(file => file.published && path.basename(file.target) === 'codeflowai.db')) return;
  const root = archiveDirectory(input, journal), target = path.join(input.dataDir, 'codeflowai.db');
  if (!exists(path.join(root, 'original-empty-application.db'))) {
    if (sha256File(target) !== journal.targetInitialization.dbSha256) fail('TARGET_CONFLICT');
    for (const suffix of ['', ...SIDECARS, '.meta.json']) {
      if (!exists(`${target}${suffix}`)) continue;
      fs.copyFileSync(`${target}${suffix}`, path.join(root, `original-empty-application.db${suffix}`), fs.constants.COPYFILE_EXCL);
      syncFile(path.join(root, `original-empty-application.db${suffix}`));
    }
  }
}

/** 同一迁移编号和安装身份才可接管 journal，损坏记录永不当作首次安装。 */
function readJournal(input: Input): Journal | null {
  const filename = path.join(input.dataDir, JOURNAL); if (!exists(filename)) return null;
  const journal = readObject(filename) as Journal;
  if (journal.schemaVersion !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.migrationId)
    || journal.snapshotGeneration !== null && !/^[0-9a-f-]{36}$/i.test(journal.snapshotGeneration)
    || !journal.source || !Array.isArray(journal.source.workspaces) || !Array.isArray(journal.files) || !Array.isArray(journal.snapshotHashes)
    || journal.targetClientId !== input.targetClientId || journal.targetDeviceId !== input.targetDeviceId
    || input.migrationId && input.migrationId !== journal.migrationId) fail('MIGRATION_JOURNAL_CONFLICT');
  for (const file of journal.files) {
    const targets = [path.join(input.dataDir, 'codeflowai.db'), path.join(input.dataDir, 'config.json'), path.join(input.dataDir, 'codeflowai.db.meta.json'),
      ...journal.source.workspaces.map(work => path.join(work.path, '.codeflow', 'workspace.db'))];
    const workspaceTarget = journal.source.workspaces.find(work => samePath(path.join(work.path, '.codeflow', 'workspace.db'), file.target));
    const staged = workspaceTarget ? path.join(workspaceTarget.path, '.codeflow', `legacy-migration-${journal.migrationId}.db`)
      : path.join(archiveDirectory(input, journal), path.basename(file.target) === 'config.json' ? 'target-config.json'
        : path.basename(file.target) === 'codeflowai.db.meta.json' ? 'target-meta.json' : 'target-application.db');
    if (!targets.some(target => samePath(target, file.target)) || !samePath(staged, file.staged)
      || !/^[0-9a-f]{64}$/.test(file.sha256) || typeof file.published !== 'boolean'
      || file.originalSha256 !== null && !/^[0-9a-f]{64}$/.test(file.originalSha256)) fail('MIGRATION_JOURNAL_INVALID');
  }
  return journal;
}

/** 所有迁移事实使用同目录临时文件 + fsync + rename 持久化。 */
function writeJournal(input: Input, journal: Journal): void { writeAtomic(path.join(input.dataDir, JOURNAL), journal); }
/** 临时归档只由固定迁移编号派生，不能接受页面路径。 */
function archiveDirectory(input: Input, journal: Journal): string { return path.join(input.dataDir, 'legacy-client-migration', journal.migrationId); }
/** 每次未封存快照重试创建新代，保留前次原始归档且绝不拼接不同时刻的库。 */
function snapshotDirectory(input: Input, journal: Journal): string { if (!journal.snapshotGeneration) fail('MIGRATION_SNAPSHOT_MISSING'); return path.join(archiveDirectory(input, journal), journal.snapshotGeneration); }
/** 原 Client 命名空间替换为稳定桌面身份，未知第三方前缀显式失败。 */
function mappedWorkspaceId(id: string, sourceClientId: string, targetClientId: string): string {
  if (id.startsWith(`${sourceClientId}:`)) return `${targetClientId}:${id.slice(sourceClientId.length + 1)}`;
  if (!id.includes(':')) return `${targetClientId}:${id}`;
  fail('SOURCE_WORKSPACE_ID_UNSUPPORTED');
}
/** 校验宿主隔离目录与稳定身份，防止退回普通 Client 默认库。 */
function validateInput(input: Input): void {
  parseLegacyClientMigrationRequest({ ...input, action: 'discover' });
  if (!path.isAbsolute(input.dataDir)) fail('MIGRATION_REQUEST_INVALID');
  if (exists(input.dataDir)) assertDirectory(input.dataDir);
}
/** 原配置只读且保留秘密在内存；格式错误不能生成替代身份。 */
function readSourceConfig(filename: string): SourceConfig {
  const config = readObject(filename);
  if (typeof config.apiKey !== 'string' || typeof config.serverWs !== 'string' || typeof config.clientId !== 'string') fail('SOURCE_CONFIG_INVALID');
  const url = new URL(config.serverWs);
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('SOURCE_SERVER_INVALID');
  return { apiKey: config.apiKey, serverWs: config.serverWs, clientId: config.clientId };
}
/** 每次短连接都显式收口，关闭失败保留业务根因。 */
function withDatabase<T>(filename: string, readonly: boolean, operation: (db: SqliteDb) => T): T {
  assertFile(filename); const db = openSqliteDb(filename, { readonly, fileMustExist: true }); let failure: unknown;
  try { return operation(db); } catch (error) { failure = error; throw error; } finally { closeDatabase(db, failure); }
}
/** SQLite 关闭失败不得覆盖原错误或伪造安全释放。 */
function closeDatabase(db: SqliteDb, failure: unknown): void {
  try { db.close(); } catch (error) { throw failure === undefined ? error : new AggregateError([failure, error], 'MIGRATION_DB_CLOSE_FAILED', { cause: failure }); }
}
/** 完整性及 FK 校验同时成立才允许提交转换结果。 */
function integrity(db: SqliteDb): void {
  const result = db.pragma('integrity_check', { simple: true }), foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (result !== 'ok' || foreignKeys.length) throw Object.assign(migrationError('SOURCE_INTEGRITY_INVALID'), { check: result, foreignKeys: foreignKeys.slice(0, 10) });
}
/** 返回实际表清单，SQLite 自有 sequence 不属于迁移业务。 */
function listTables(db: SqliteDb): string[] { return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map(row => row.name); }
/** 列名来自受核验 schema，后续 SQL 统一转义。 */
function columns(db: SqliteDb, table: string): string[] { return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Row[]).map(row => row.name); }
/** 仅检查真实表，不触发建表修复。 */
function hasTable(db: SqliteDb, table: string): boolean { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined; }
/** 统计阶段读取真实记录数量。 */
function tableCount(db: SqliteDb, table: string): number { return hasTable(db, table) ? Number((db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as Row).count) : 0; }
/** 标量元数据缺失显式保留为空，调用边界决定是否允许。 */
function metaValue(db: SqliteDb, key: string): string { return String((db.prepare('SELECT value FROM meta WHERE key=?').get(key) as Row | undefined)?.value ?? ''); }
/** 序号只接受非负安全整数，不把损坏计数降成零。 */
function validCounter(value: string): number { if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('SOURCE_EVENT_SEQUENCE_INVALID'); return Number(value); }
/** SQL 标识符只来自固定清单或 SQLite 结构。 */
function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
/** 仅用于已校验的内部 ID 常量条件，绝不接受页面 SQL。 */
function sqlString(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
/** 摘要不包含源凭据，仅用于文件或业务字节完整性。 */
function sha256(value: string | Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
/** 文件摘要采用分块读取，避免大 SQLite 全部进内存。 */
function sha256File(filename: string): string {
  assertFile(filename); const hash = crypto.createHash('sha256'), fd = fs.openSync(filename, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { let size: number; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size)); return hash.digest('hex'); }
  finally { fs.closeSync(fd); }
}
/** 缺失与权限失败严格区分，不将读取失败当成无数据。 */
function exists(filename: string): boolean { try { fs.lstatSync(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
/** 普通文件必须无符号链接及硬链接，避免替换或越界读写。 */
function assertFile(filename: string): void { const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(fs.realpathSync.native(filename), filename)) fail('SOURCE_PATH_UNSAFE'); }
/** 受管目录必须是物理目录，父链链接也不得把操作导向别处。 */
function assertDirectory(filename: string): void { const stat = fs.lstatSync(filename); if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(filename), filename)) fail('SOURCE_PATH_UNSAFE'); }
/** 读取元数据只接受对象，解析根因不上抛含秘密正文的 message。 */
function readObject(filename: string): Row { assertFile(filename); let value: unknown; try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch (error) { throw migrationError('MIGRATION_JSON_INVALID', error); } if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MIGRATION_JSON_INVALID'); return value as Row; }
/** 比较路径沿当前 OS 大小写口径。 */
function samePath(left: string, right: string): boolean { return pathKey(left) === pathKey(right); }
/** Windows 路径比较保持与现有来源锁相同的大小写口径。 */
function pathKey(value: string): string { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
/** SQLite 文件头只是普通格式证据，未知头不等同于加密。 */
function plainHeader(filename: string): boolean { const fd = fs.openSync(filename, 'r'), header = Buffer.alloc(16); try { return fs.readSync(fd, header, 0, 16, 0) === 16 && header.toString('ascii') === 'SQLite format 3\0'; } finally { fs.closeSync(fd); } }
/** 只删除本迁移固定临时文件，sidecar 同时清理避免副本重试污染。 */
function removeOwnedTemporary(filename: string): void { for (const suffix of ['', ...SIDECARS]) { const target = `${filename}${suffix}`; if (exists(target)) { assertFile(target); fs.unlinkSync(target); } } }
/** 原子持久化JSON；失败回收本次临时文件，保留写入及清理的全部错误。 */
function writeAtomic(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true }); assertDirectory(path.dirname(filename));
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`, fd = fs.openSync(temporary, 'wx', 0o600);
  let failure: unknown;
  try {
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8'); fs.fsyncSync(fd); }
    catch (error) { failure = error; throw error; }
    finally {
      try { fs.closeSync(fd); }
      catch (error) { throw failure === undefined ? error : new AggregateError([failure, error], 'MIGRATION_JSON_CLOSE_FAILED', { cause: failure }); }
    }
    if (exists(filename)) assertFile(filename);
    fs.renameSync(temporary, filename); syncDirectory(path.dirname(filename));
  } catch (error) {
    try { if (exists(temporary)) { assertFile(temporary); fs.unlinkSync(temporary); } }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'MIGRATION_JSON_CLEANUP_FAILED', { cause: error }); }
    throw error;
  }
}
/** 文件持久提交后才更新 journal 的可见事实。 */
function syncFile(filename: string): void { const fd = fs.openSync(filename, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
/** POSIX 持久化 rename 的目录项；Windows 的目录句柄不支持 fsync。 */
function syncDirectory(filename: string): void { if (process.platform === 'win32') return; const fd = fs.openSync(filename, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
/** 只用 PID 探活，不把它当作发送停止信号的授权证据。 */
function processRunning(pid: unknown): boolean { if (!Number.isInteger(pid) || Number(pid) <= 0) return false; try { process.kill(Number(pid), 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; throw error; } }
/** 取消会保留 journal，下一次继续原任务而非重复导入。 */
function checkpoint(dependencies: LegacyClientMigrationDependencies): void { dependencies.signal?.throwIfAborted(); }
/** 进度仅来自已完成的工作单元，不使用时间插值。 */
function progress(dependencies: LegacyClientMigrationDependencies, stage: string, completed: number, total: number | null, journal: Journal): void { dependencies.onProgress?.({ stage, completed, total, workspaceCount: journal.source.workspaces.length }); }
/** 对外错误只携带固定码，原异常由受管 Worker 边界安全记录。 */
function migrationError(code: string, cause?: unknown): Error & { code: string } { return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code }); }
/** 无法验证的事实必须立即失败。 */
function fail(code: string): never { throw migrationError(code); }
/** journal 只保存稳定错误码，不保存可能含凭据的异常原文。 */
function errorCode(error: unknown): string { const code = (error as { code?: unknown })?.code; return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'LEGACY_MIGRATION_FAILED'; }
