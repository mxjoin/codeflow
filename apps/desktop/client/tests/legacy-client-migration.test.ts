import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalizeOrchAssetJson, type ChatWorkflowTask, type NodeFinalAnswerPayload, type OrchestrationId } from '@codeflowai/shared';
import { CLIENT_DB_SCHEMA_VERSION, migrateClientDb, ensureWorkspaceCoreQueueTables, ensureWorkspaceAdditionalTables } from '../src/db/migrateClientDb.js';
import { openSqliteDb, type SqliteDb } from '../src/db/sqliteDb.js';
import { buildClientProcessLockPath } from '../src/startup/clientStartupGuards.js';
import { ConversationEventRepo } from '../src/db/repos/eventRepo.js';
import { hashOrchNodeAttemptSubmission } from '../src/db/repos/orchNodeAttemptRepo.js';
import { serializeCodeAttributionOutboxPayload, hashCodeAttributionOutboxPayload } from '../src/db/repos/codeAttributionOutboxRepo.js';
import { OrchInstanceSummaryProjectionReader, parseOrchInstanceSummarySourceRow, upsertOrchInstanceSummaryProjection } from '../src/db/orchInstanceSummaryProjection.js';
import { OrchInstanceRepo } from '../src/db/repos/orchInstanceRepo.js';
import { OrchIntakeListStateRepo } from '../src/db/repos/orchIntakeListStateRepo.js';
import { ChatWorkflowRepo } from '../src/db/repos/chatWorkflowRepo.js';
import { OrchArtifactRepo } from '../src/db/repos/orchArtifactRepo.js';
import { OrchArtifactFileRepo } from '../src/db/repos/orchArtifactFileRepo.js';
import { createLegacyClientMigration, type LegacyMigrationExecutor, type LegacyMigrationResult } from '../../src/legacyClientMigration.js';
import { runDesktopUninstallCleanup, runDesktopReinstallLocalTasks } from '../src/desktopUninstallWorker.js';

const clientId = 'old-client';
const targetClientId = 'local_11111111-1111-4111-8111-111111111111';
const targetDeviceId = '22222222-2222-4222-8222-222222222222';
const namespace = 'acct_currentaccount';
const apiKey = 'codeflowai_123456789012345678901234';

/** 每例使用真实磁盘库；关闭连接后再清理，绝不访问用户旧目录。 */
function fixture(t: test.TestContext, initialize: (db: SqliteDb) => void = migrateClientDb) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-client-migration-'));
  const homeDir = path.join(root, 'home'), dataDir = path.join(root, 'desktop');
  const sourceDir = path.join(homeDir, '.codeflowai'), workspacePath = path.join(root, 'project');
  fs.mkdirSync(sourceDir, { recursive: true }); fs.mkdirSync(workspacePath); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(sourceDir, 'config.json'), JSON.stringify({ apiKey, serverWs: 'ws://localhost:39280/ws/client', clientId }));
  const dbPath = path.join(sourceDir, 'client-dbs', namespace, 'codeflowai.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const connections: SqliteDb[] = [];
  t.after(() => { for (const db of connections) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const db = openSqliteDb(dbPath); connections.push(db); initialize(db);
  db.prepare("INSERT INTO meta(key,value) VALUES('client_id',?)").run(clientId);
  db.prepare("INSERT INTO workspaces(id,title,path,is_deleted,created_at,updated_at) VALUES('old-client:one','中文项目',?,0,1,2)").run(workspacePath);
  fs.writeFileSync(`${dbPath}.meta.json`, JSON.stringify({ schemaVersion: 2, storageMode: 'plain_sqlite', accountNamespace: namespace,
    initializationState: 'ready', deviceAuthMode: 'runtime', deviceId: 'runtime_old' }));
  const input = { dataDir, targetClientId, targetDeviceId };
  const dependencies = { homeDir, resolveNamespace: async () => namespace };
  return { root, homeDir, dataDir, sourceDir, dbPath, db, workspacePath, input, dependencies,
    open(file: string) { const opened = openSqliteDb(file, { fileMustExist: true }); connections.push(opened); return opened; } };
}

/** 冻结真实 v83 DDL，让浅克隆 CI 也能验证历史库而不依赖 Git 旧对象。 */
function initializeLegacy83(db: SqliteDb): void {
  db.exec(fs.readFileSync(new URL('./fixtures/legacy-client-schema-83.sql', import.meta.url), 'utf8'));
}

/** 缺少迁移入口必须先产生断言失败，后续用例直接消费真实导出。 */
async function service() {
  assert.ok(fs.existsSync(fileURLToPath(new URL('../src/legacy-migration/legacyClientMigration.ts', import.meta.url))), '迁移服务尚未实现');
  return await import('../src/legacy-migration/legacyClientMigration.js');
}

/** 写入一组可独立核验的 canonical/raw、草稿附件和排队消息。 */
function history(db: SqliteDb, workspaceId = 'old-client:one') {
  db.prepare("INSERT INTO threads(id,workspace_id,engine,title,created_at,updated_at) VALUES('thread',?,'codex','保留会话',1,2)").run(workspaceId);
  const envelope = { schema: 1, seq: 700, workspaceId, threadId: 'thread', engine: 'codex', type: 'message.user', ts: 1,
    payload: { itemId: 'user', text: '原文 old-client:one 不得替换' } };
  db.prepare('INSERT INTO conversation_events VALUES(?,?,?,?,?,?,?)').run(700, 'thread', workspaceId, 'codex', 'message.user', JSON.stringify(envelope), 1);
  db.prepare('INSERT INTO raw_engine_events VALUES(?,?,?,?,?,?,?)').run(701, 'thread', workspaceId, 'codex', 'app-server', JSON.stringify({ ...envelope, seq: 701,
    source: 'app-server', handled: true, action: 'mapped', emittedTypes: ['message.user'], data: { text: 'old-client:one' } }), 2);
  const data = Buffer.from('附件正文'), blobId = crypto.createHash('sha256').update(data).digest('hex');
  db.prepare("INSERT INTO file_blobs VALUES(?,?,'utf8',?,1)").run(blobId, data.length, data);
  db.prepare("INSERT INTO thread_drafts(thread_id,workspace_id,text,updated_at) VALUES('thread',?,'草稿',1)").run(workspaceId);
  db.prepare("INSERT INTO thread_draft_attachments(thread_id,attachment_id,kind,order_index,name,size,blob_id) VALUES('thread','attachment','file',0,'note.txt',?,?)").run(data.length, blobId);
  db.prepare("INSERT INTO thread_message_queue(id,thread_id,workspace_id,position,status,text,attachments_json,path_references_json,skill_mentions_json,send_options_json,enqueued_at,updated_at,attempt_count) VALUES('queue','thread',?,1,'pending','禁止自动发送','[]','[]','[]','{}',1,1,0)").run(workspaceId);
  db.prepare("UPDATE meta SET value='900' WHERE key='event_seq'").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('conversation_relay:scope:old','{\"cursor\":999}')").run();
  return { blobId, data };
}

/** 构造含结构化工作区引用的真实 Attempt 和已冻结外部投递证据。 */
function orchestrationHistory(db: SqliteDb) {
  const submission: NodeFinalAnswerPayload = { answer: { mode: 'structured', data: { workspaceId: 'old-client:one', text: 'old-client:one' } },
    control: { nextAction: 'continue' }, review: { verdict: 'pass', summary: '历史结果' } };
  const hashed = hashOrchNodeAttemptSubmission(submission);
  db.prepare(`INSERT INTO orch_instances(id,workspace_id,workflow_id,workflow_snapshot_json,intake_snapshot_json,status,created_at,updated_at)
    VALUES('instance','old-client:one','workflow',?,?,'completed',1,2)`)
    .run(JSON.stringify({ id: 'workflow', nodes: [], edges: [] }), JSON.stringify({ id: 'intake', title: '历史任务', workspaceId: 'old-client:one' }));
  upsertOrchInstanceSummaryProjection(db, parseOrchInstanceSummarySourceRow(db.prepare("SELECT * FROM orch_instances WHERE id='instance'").get() as Record<string, unknown>));
  db.prepare(`INSERT INTO orch_node_attempts(id,instance_id,node_id,attempt_no,status,submission_json,submission_hash,created_at,updated_at)
    VALUES('attempt','instance','node',1,'completed',?,?,1,2)`).run(hashed.submissionJson, hashed.submissionHash);
  const payload: Parameters<typeof serializeCodeAttributionOutboxPayload>[0] = { commit: { sourceWorkspaceId: 'old-client:one', sourceInstanceId: 'instance',
    repository: 'repository', commitSha: 'a'.repeat(40), disposition: 'matched', qualityStatus: 'complete', qualityReasons: [], commitEvidenceSha256: 'b'.repeat(64), observedAt: 1 }, facts: [] };
  db.prepare(`INSERT INTO code_attribution_outbox(id,source_batch_id,workspace_id,instance_id,repository,commit_sha,content_sha256,payload_json,association_id,association_expires_at,status,available_at,created_at,updated_at)
    VALUES('outbox','batch','old-client:one','instance','repository',?,?,?,'previous-authorization',9999999999999,'pending',1,1,2)`)
    .run(payload.commit.commitSha, hashCodeAttributionOutboxPayload(payload), serializeCodeAttributionOutboxPayload(payload));
  return { submission, payload };
}

test('发现只读、只选当前账号，并且不改配置或创建桌面库', async t => {
  const f = fixture(t), { discoverLegacyClientMigration } = await service();
  const beforeConfig = fs.readFileSync(path.join(f.sourceDir, 'config.json'));
  const other = path.join(f.sourceDir, 'client-dbs', 'acct_otheraccount'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'codeflowai.db'), '其他账号不应打开');
  const result = await discoverLegacyClientMigration(f.input, f.dependencies);
  assert.equal(result.workspaceCount, 1); assert.match(result.candidateId!, /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(path.join(f.sourceDir, 'config.json')), beforeConfig);
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
});

test('真实历史 schema83 普通库保留历史并迁入桌面', async t => {
    const f = fixture(t, initializeLegacy83), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
    assert.equal(f.db.pragma('user_version', { simple: true }), 83);
    fs.writeFileSync(`${f.dbPath}.meta.json`, JSON.stringify({ schemaVersion: 2, storageMode: 'plain_sqlite', accountNamespace: namespace,
      initializationState: 'ready', deviceAuthMode: 'ed25519', deviceId: crypto.randomUUID() }));
    const attachment = history(f.db), candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
    assert.ok(candidate.candidateId);
    await migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
    const work = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db'));
    assert.equal((work.prepare('SELECT workspace_id FROM threads').get() as { workspace_id: string }).workspace_id, `${targetClientId}:one`);
    assert.equal(work.prepare('SELECT seq FROM conversation_events').all().length, 1);
    assert.equal(work.prepare('SELECT seq FROM raw_engine_events').all().length, 1);
    assert.deepEqual((work.prepare('SELECT data FROM file_blobs WHERE blob_id=?').get(attachment.blobId) as { data: Buffer }).data, attachment.data);
    assert.equal(f.db.pragma('user_version', { simple: true }), 83);
});

for (const initialize of [initializeLegacy83, migrateClientDb]) test(`卸载清除所有迁移归档凭据但保留历史及原Client：${initialize.name}`, async t => {
  const f = fixture(t, initialize), api = await service(); history(f.db);
  f.db.prepare("INSERT INTO engine_keys(id,label,engine,provider_id,api_key,base_url,is_active,created_at,updated_at) VALUES('archived-key','保留标签','codex','openai','archived-fixture-secret','https://fixture.invalid',1,1,1)").run();
  const candidate = await api.discoverLegacyClientMigration(f.input, f.dependencies);
  const migrationId = crypto.randomUUID();
  await api.migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId }, f.dependencies);
  const journalPath = path.join(f.dataDir, 'legacy-client-migration-journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  const archive = path.join(f.dataDir, 'legacy-client-migration', migrationId), previous = crypto.randomUUID();
  fs.cpSync(path.join(archive, journal.snapshotGeneration), path.join(archive, previous), { recursive: true });
  const live = f.open(path.join(archive, journal.snapshotGeneration, 'source-application.db'));
  live.pragma('journal_mode=WAL'); live.pragma('wal_autocheckpoint=0');
  live.prepare("UPDATE engine_keys SET api_key='archived-wal-secret' WHERE id='archived-key'").run();
  const walArchive = path.join(archive, previous, 'original-workspace-0.db');
  for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(path.join(archive, journal.snapshotGeneration, `source-application.db${suffix}`), `${walArchive}${suffix}`);
  live.close();
  const sourceBefore = fs.readFileSync(path.join(f.sourceDir, 'config.json'));
  const input = { schemaVersion: 1 as const, requestId: 'review:archive', dataDir: f.dataDir, clientId: targetClientId, deviceId: targetDeviceId };
  runDesktopUninstallCleanup(input); runDesktopUninstallCleanup(input);
  for (const generation of [journal.snapshotGeneration, previous]) {
    const filename = path.join(archive, generation, 'source-application.db'), db = openSqliteDb(filename, { readonly: true, fileMustExist: true });
    try {
      assert.equal((db.prepare("SELECT count(*) AS n FROM engine_keys WHERE api_key <> '' OR is_active <> 0").get() as { n: number }).n, 0);
      assert.equal((db.prepare("SELECT label FROM engine_keys WHERE id='archived-key'").get() as { label: string }).label, '保留标签');
      assert.equal((db.prepare('SELECT count(*) AS n FROM conversation_events').get() as { n: number }).n, 1);
    } finally { db.close(); }
    assert.equal(fs.readFileSync(filename).includes(Buffer.from('archived-fixture-secret')), false);
  }
  const original = f.open(walArchive);
  assert.equal((original.prepare("SELECT api_key FROM engine_keys WHERE id='archived-key'").get() as { api_key: string }).api_key, '');
  original.close();
  for (const suffix of ['', '-wal', '-shm', '-journal']) if (fs.existsSync(`${walArchive}${suffix}`)) {
    assert.equal(fs.readFileSync(`${walArchive}${suffix}`).includes(Buffer.from('archived-wal-secret')), false);
    assert.equal(fs.readFileSync(`${walArchive}${suffix}`).includes(Buffer.from('archived-fixture-secret')), false);
  }
  const updated = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  for (const file of updated.snapshotHashes) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(archive, updated.snapshotGeneration, file.name))).digest('hex'), file.sha256);
  assert.deepEqual(fs.readFileSync(path.join(f.sourceDir, 'config.json')), sourceBefore);
  assert.equal((f.db.prepare("SELECT api_key FROM engine_keys WHERE id='archived-key'").get() as { api_key: string }).api_key, 'archived-fixture-secret');
});

test('迁移完成后保留数据卸载重装可接续新设备且不会重复导入', async t => {
  const f = fixture(t), api = await service(); history(f.db);
  const candidate = await api.discoverLegacyClientMigration(f.input, f.dependencies), migrationId = crypto.randomUUID();
  await api.migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId }, f.dependencies);
  runDesktopUninstallCleanup({ schemaVersion: 1, requestId: 'review:keep', dataDir: f.dataDir, clientId: targetClientId, deviceId: targetDeviceId });
  const nextDeviceId = crypto.randomUUID(), input = { schemaVersion: 1 as const, action: 'reinstall_local_tasks' as const,
    requestId: 'review:reinstall', dataDir: f.dataDir, clientId: targetClientId, oldDeviceId: targetDeviceId, nextDeviceId };
  runDesktopReinstallLocalTasks(input); runDesktopReinstallLocalTasks(input);
  const result = await api.discoverLegacyClientMigration({ ...f.input, targetDeviceId: nextDeviceId }, f.dependencies);
  assert.equal(result.completed, true); assert.equal(result.migrationId, migrationId);
  const work = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db'));
  assert.equal((work.prepare('SELECT count(*) AS n FROM conversation_events').get() as { n: number }).n, 1);
  assert.throws(() => runDesktopReinstallLocalTasks({ ...input, oldDeviceId: crypto.randomUUID(), nextDeviceId: crypto.randomUUID() }), /MIGRATION_JOURNAL_CONFLICT/u);
});

for (const action of ['migration_credentials', 'reinstall_local_tasks'] as const) test(`历史keep接续${action}补清归档且不再清当前凭据`, async t => {
  const f = fixture(t), api = await service();
  f.db.prepare("INSERT INTO engine_keys(id,label,engine,provider_id,api_key,base_url,is_active,created_at,updated_at) VALUES('archived-key','保留标签','codex','openai','legacy-keep-secret','https://fixture.invalid',1,1,1)").run();
  const candidate = await api.discoverLegacyClientMigration(f.input, f.dependencies), migrationId = crypto.randomUUID();
  await api.migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId }, f.dependencies);
  const config = path.join(f.dataDir, 'config.json'), dbFile = path.join(f.dataDir, 'codeflowai.db');
  fs.writeFileSync(config, JSON.stringify({ clientId: targetClientId, apiKey: 'current-credential-preserved' }));
  const configBefore = fs.readFileSync(config), dbBefore = fs.readFileSync(dbFile);
  const input = { schemaVersion: 1 as const, requestId: 'review:legacy-keep', dataDir: f.dataDir, clientId: targetClientId };
  if (action === 'migration_credentials') runDesktopUninstallCleanup({ ...input, action, deviceId: targetDeviceId });
  else runDesktopReinstallLocalTasks({ ...input, action, oldDeviceId: targetDeviceId, nextDeviceId: crypto.randomUUID() });
  const journal = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'legacy-client-migration-journal.json'), 'utf8'));
  for (const item of journal.snapshotHashes) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(f.dataDir,
    'legacy-client-migration', migrationId, journal.snapshotGeneration, item.name))).digest('hex'), item.sha256);
  const archived = f.open(path.join(f.dataDir, 'legacy-client-migration', migrationId, journal.snapshotGeneration, 'source-application.db'));
  assert.equal((archived.prepare("SELECT api_key FROM engine_keys WHERE id='archived-key'").get() as { api_key: string }).api_key, '');
  assert.deepEqual(fs.readFileSync(config), configBefore);
  if (action === 'migration_credentials') assert.deepEqual(fs.readFileSync(dbFile), dbBefore);
});

for (const action of ['uninstall', 'reinstall'] as const) test(`迁移${action}记录写失败停止后续写入且可重试`, async t => {
  const f = fixture(t), api = await service(), candidate = await api.discoverLegacyClientMigration(f.input, f.dependencies);
  await api.migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
  const journalPath = path.join(f.dataDir, 'legacy-client-migration-journal.json'), before = fs.readFileSync(journalPath);
  const config = path.join(f.dataDir, 'config.json'), configBefore = fs.readFileSync(config), stages: string[] = [];
  const rename = fs.renameSync, failure = new Error('controlled migration journal write failure');
  const fault = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
    if (args[1] === journalPath) throw failure;
    return rename(...args);
  });
  const nextDeviceId = crypto.randomUUID();
  const run = () => action === 'uninstall'
    ? runDesktopUninstallCleanup({ schemaVersion: 1, requestId: 'review:write-failure', dataDir: f.dataDir, clientId: targetClientId, deviceId: targetDeviceId }, { onStage: stage => stages.push(stage) })
    : runDesktopReinstallLocalTasks({ schemaVersion: 1, action: 'reinstall_local_tasks', requestId: 'review:write-failure', dataDir: f.dataDir,
      clientId: targetClientId, oldDeviceId: targetDeviceId, nextDeviceId }, { onStage: stage => stages.push(stage) });
  assert.throws(run, error => error === failure);
  assert.equal(stages.includes('database_open'), false);
  assert.deepEqual(fs.readFileSync(journalPath), before); assert.deepEqual(fs.readFileSync(config), configBefore);
  assert.equal(fs.readdirSync(f.dataDir).some(name => name.startsWith('legacy-client-migration-journal.json.') && name.endsWith('.tmp')), false);
  fault.mock.restore(); run(); run();
});

for (const defect of ['hardlink', 'unknown', 'corrupt', 'unfinished'] as const) test(`迁移归档${defect}失败阻断清理且保留当前凭据`, async t => {
  const f = fixture(t), api = await service(), candidate = await api.discoverLegacyClientMigration(f.input, f.dependencies);
  const migrationId = crypto.randomUUID();
  await api.migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId }, f.dependencies);
  const journalPath = path.join(f.dataDir, 'legacy-client-migration-journal.json'), journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  const archive = path.join(f.dataDir, 'legacy-client-migration', migrationId), snapshot = path.join(archive, journal.snapshotGeneration, 'source-application.db');
  if (defect === 'hardlink') fs.linkSync(snapshot, path.join(f.root, 'unowned-copy.db'));
  if (defect === 'unknown') fs.writeFileSync(path.join(archive, 'user-owned.txt'), 'preserve');
  if (defect === 'corrupt') fs.writeFileSync(snapshot, 'broken snapshot');
  if (defect === 'unfinished') fs.writeFileSync(journalPath, JSON.stringify({ ...journal, completed: false }));
  const config = path.join(f.dataDir, 'config.json'), before = JSON.stringify({ clientId: targetClientId, apiKey: 'current-fixture-secret' });
  fs.writeFileSync(config, before);
  assert.throws(() => runDesktopUninstallCleanup({ schemaVersion: 1, requestId: 'review:archive-failure', dataDir: f.dataDir, clientId: targetClientId, deviceId: targetDeviceId }));
  assert.equal(fs.readFileSync(config, 'utf8'), before);
  if (defect === 'unfinished') assert.throws(() => runDesktopReinstallLocalTasks({ schemaVersion: 1, action: 'reinstall_local_tasks',
    requestId: 'review:unfinished', dataDir: f.dataDir, clientId: targetClientId, oldDeviceId: targetDeviceId, nextDeviceId: crypto.randomUUID() }), /MIGRATION_NOT_COMPLETED/u);
});

test('退役笔记与资产同步状态不导入新库，其他工作区数据迁移且旧库保留', async t => {
  const f = fixture(t, initializeLegacy83), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  f.db.prepare("INSERT INTO notes(id,workspace_id,title,content,created_at,updated_at) VALUES('note','old-client:one','笔记','必须保留',1,1)").run();
  f.db.prepare('INSERT INTO orch_asset_bundle_sync(workspace_id,bundle_id,bundle_version,synced_at) VALUES(?,?,?,?)')
    .run('old-client:one', 'bundle', 7, 123);
  history(f.db);
  f.db.prepare("INSERT INTO engine_events VALUES(702,'thread','old-client:one','codex','message.user','{}',1)").run();
  f.db.prepare("INSERT INTO conversation_items VALUES('old-item','thread','message','{}',1,1,1)").run();
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  assert.ok(candidate.candidateId);
  const migrationId = crypto.randomUUID();
  await migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId }, f.dependencies);

  const migratedApp = f.open(path.join(f.dataDir, 'codeflowai.db'));
  for (const table of ['notes', 'orch_asset_bundle_sync', 'engine_events', 'conversation_items']) {
    assert.equal(migratedApp.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined,
      `${table} remained in target schema ${migratedApp.pragma('user_version', { simple: true })}`);
  }
  const migratedWorkspace = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db'));
  assert.equal((migratedWorkspace.prepare('SELECT count(*) AS count FROM threads').get() as { count: number }).count, 1);
  assert.equal((migratedWorkspace.prepare('SELECT count(*) AS count FROM conversation_events').get() as { count: number }).count, 1);

  const journal = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'legacy-client-migration-journal.json'), 'utf8'));
  const sourceSnapshot = f.open(path.join(f.dataDir, 'legacy-client-migration', migrationId, journal.snapshotGeneration, 'source-application.db'));
  assert.equal((sourceSnapshot.prepare('SELECT count(*) AS count FROM notes').get() as { count: number }).count, 1);
  assert.equal((sourceSnapshot.prepare('SELECT count(*) AS count FROM orch_asset_bundle_sync').get() as { count: number }).count, 1);
  assert.equal((sourceSnapshot.prepare('SELECT count(*) AS count FROM engine_events').get() as { count: number }).count, 1);
  assert.equal((sourceSnapshot.prepare('SELECT count(*) AS count FROM conversation_items').get() as { count: number }).count, 1);
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM notes').get() as { count: number }).count, 1);
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM orch_asset_bundle_sync').get() as { count: number }).count, 1);
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM engine_events').get() as { count: number }).count, 1);
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM conversation_items').get() as { count: number }).count, 1);
});

test('Attempt和代码归因结构化引用重算原有摘要规则，投递保持暂停', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); orchestrationHistory(f.db);
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  await migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
  const work = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db'));
  const attempt = work.prepare('SELECT submission_json,submission_hash FROM orch_node_attempts').get() as { submission_json: string; submission_hash: string };
  const submission = JSON.parse(attempt.submission_json);
  assert.equal(submission.answer.data.workspaceId, `${targetClientId}:one`); assert.equal(submission.answer.data.text, 'old-client:one');
  assert.equal(attempt.submission_hash, hashOrchNodeAttemptSubmission(submission).submissionHash);
  const outbox = work.prepare('SELECT payload_json,content_sha256,status,available_at,association_expires_at FROM code_attribution_outbox').get() as any;
  assert.equal(JSON.parse(outbox.payload_json).commit.sourceWorkspaceId, `${targetClientId}:one`);
  assert.equal(outbox.content_sha256, hashCodeAttributionOutboxPayload(JSON.parse(outbox.payload_json)));
  assert.equal(outbox.status, 'failed'); assert.equal(outbox.available_at, Number.MAX_SAFE_INTEGER); assert.equal(outbox.association_expires_at, 0);
});

test('Attempt原始摘要损坏不能在重算中被洗成有效历史', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); orchestrationHistory(f.db);
  f.db.prepare("UPDATE orch_node_attempts SET submission_hash=?").run('0'.repeat(64));
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies), { code: 'SOURCE_SUBMISSION_HASH_INVALID' });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'codeflowai.db')), false);
});

test('损坏的原始事件基础信封在发布前失败', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); history(f.db);
  f.db.prepare("UPDATE raw_engine_events SET event_json=json_remove(event_json,'$.handled')").run();
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies), { code: 'SOURCE_RAW_EVENT_INVALID' });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'codeflowai.db')), false);
});

for (const defect of ['缺基础信封', '父会话引擎不符', '最新diff快照缺失', '最新diff正文摘要损坏'] as const) {
  test(`复核修正：canonical${defect}必须拒迁并保留来源`, async t => {
    const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); history(f.db);
    if (defect === '缺基础信封') {
      f.db.prepare('UPDATE conversation_events SET event_json=?').run(JSON.stringify({ seq: 700, threadId: 'thread', workspaceId: 'old-client:one' }));
    } else if (defect === '父会话引擎不符') {
      f.db.prepare("UPDATE conversation_events SET engine='claude',event_json=json_set(event_json,'$.engine','claude')").run();
    } else {
      f.db.prepare('DELETE FROM conversation_events').run();
      new ConversationEventRepo(f.db).appendEnvelope({ schema: 1, seq: 700, ts: 1, workspaceId: 'old-client:one', threadId: 'thread', engine: 'codex',
        type: 'item.diff.created', payload: { itemId: 'diff', diff: '原始diff正文' } } as Parameters<ConversationEventRepo['appendEnvelope']>[0]);
      f.db.exec(defect === '最新diff快照缺失' ? 'DELETE FROM conversation_diff_snapshots' : "UPDATE conversation_diff_snapshots SET diff_text='损坏正文'");
    }
    const original = f.db.prepare('SELECT * FROM conversation_events').all(), candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
    await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies), { code: 'SOURCE_CANONICAL_EVENT_INVALID' });
    assert.deepEqual(f.db.prepare('SELECT * FROM conversation_events').all(), original);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'codeflowai.db')), false);
  });
}

test('复核修正：被最新快照合法替代的旧diff仍可迁移', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); history(f.db);
  f.db.prepare('DELETE FROM conversation_events').run();
  const events = new ConversationEventRepo(f.db);
  for (const [seq, diff] of [[698, '旧diff正文'], [700, '最新diff正文']] as const) events.appendEnvelope({ schema: 1, seq, ts: 1,
    workspaceId: 'old-client:one', threadId: 'thread', engine: 'codex', type: 'item.diff.created', payload: { itemId: 'diff', diff } } as Parameters<ConversationEventRepo['appendEnvelope']>[0]);
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  await migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
  const work = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db'));
  assert.deepEqual(work.prepare('SELECT seq FROM conversation_events ORDER BY seq').all(), [{ seq: 698 }, { seq: 700 }]);
  assert.equal((work.prepare('SELECT diff_text FROM conversation_diff_snapshots').get() as { diff_text: string }).diff_text, '最新diff正文');
});

for (const status of ['waiting-approval', 'waiting-feedback'] as const) {
  test(`复核修正：${status}编排暂停且保留恢复事实`, async t => {
    const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); orchestrationHistory(f.db);
    const nodeStates = JSON.stringify({ node: { nodeId: 'node', status, threadId: 'old-thread', turnId: 'old-turn', retryCount: 1 } });
    f.db.prepare("UPDATE orch_instances SET status=?,node_states_json=? WHERE id='instance'").run(status, nodeStates);
    upsertOrchInstanceSummaryProjection(f.db, parseOrchInstanceSummarySourceRow(f.db.prepare("SELECT * FROM orch_instances WHERE id='instance'").get() as Record<string, unknown>));
    const original = f.db.prepare("SELECT status,node_states_json FROM orch_instances WHERE id='instance'").get();
    const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
    await migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
    const work = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db'));
    assert.deepEqual(work.prepare("SELECT status,node_states_json FROM orch_instances WHERE id='instance'").get(), { status: 'paused', node_states_json: nodeStates });
    assert.equal((work.prepare("SELECT status FROM orch_instance_summaries WHERE instance_id='instance'").get() as { status: string }).status, 'paused');
    assert.equal((work.prepare("SELECT status FROM orch_node_attempts WHERE id='attempt'").get() as { status: string }).status, 'completed');
    assert.deepEqual(f.db.prepare("SELECT status,node_states_json FROM orch_instances WHERE id='instance'").get(), original);
  });
}

test('冻结资产正文和来源摘要保留，旧执行授权不授予新桌面身份', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); orchestrationHistory(f.db);
  const definition = { id: 'workflow', workspaceId: 'old-client:one', name: '冻结流程', description: '正文 old-client:one', version: 1, nodes: [], edges: [] };
  const contentHash = crypto.createHash('sha256').update(canonicalizeOrchAssetJson(definition)).digest('hex');
  const snapshot = { authorityMode: 'server', workflow: { assetType: 'workflow', assetId: 'workflow', definition,
    source: { authorityMode: 'server', metadata: { revision: 1, scopeType: 'user', syncChangeSeq: 7, contentHash, cacheStatus: 'ready' } } },
    roles: {}, knowledgeBundles: {}, toolsets: {}, skills: {}, executionAuthorization: {
      serverOrigin: 'https://example.test', userId: 'old-user', deviceId: 'old-device', clientId, hostBindingId: 'old-host', hostScopeEpoch: 1,
      sharedWorkspaceId: 'shared', runtimeWorkspaceId: 'old-client:one', contextKey: 'context', authorityEpoch: 1, appliedChangeSeq: 7,
      revisionSetHash: 'a'.repeat(64), snapshotHash: 'b'.repeat(64) } };
  const original = JSON.stringify(snapshot);
  f.db.prepare("UPDATE orch_instances SET asset_runtime_snapshot_json=?,workflow_snapshot_json=? WHERE id='instance'").run(original, JSON.stringify(definition));
  upsertOrchInstanceSummaryProjection(f.db, parseOrchInstanceSummarySourceRow(f.db.prepare("SELECT * FROM orch_instances WHERE id='instance'").get() as Record<string, unknown>));
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  await migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
  const work = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db')), summaries = new OrchInstanceSummaryProjectionReader(work);
  const instance = new OrchInstanceRepo(work, new OrchIntakeListStateRepo(work, summaries), summaries).get('instance' as OrchestrationId)!;
  assert.equal(instance.assetRuntimeSnapshot?.executionAuthorization, undefined);
  assert.equal(instance.assetRuntimeSnapshot?.workflow.definition.workspaceId, `${targetClientId}:one`);
  assert.equal(instance.assetRuntimeSnapshot?.workflow.definition.description, definition.description);
  assert.deepEqual(instance.assetRuntimeSnapshot?.workflow.source, snapshot.workflow.source);
  assert.equal((f.db.prepare("SELECT asset_runtime_snapshot_json FROM orch_instances WHERE id='instance'").get() as { asset_runtime_snapshot_json: string }).asset_runtime_snapshot_json, original);
});

test('有明确SQLCipher元数据时联网前排除，未知格式显式失败', async t => {
  const f = fixture(t), { discoverLegacyClientMigration } = await service(); f.db.close();
  fs.writeFileSync(f.dbPath, 'encrypted bytes'); fs.writeFileSync(`${f.dbPath}.meta.json`, JSON.stringify({ encryptionMode: 'server_managed_sqlcipher', cipher: 'sqlcipher', dbId: crypto.randomUUID(), keyVersion: 1, migrationState: 'ready' }));
  const result = await discoverLegacyClientMigration(f.input, { homeDir: f.homeDir, resolveNamespace: async () => { throw new Error('不应联网'); } });
  assert.equal(result.candidateId, null);
  fs.writeFileSync(`${f.dbPath}.meta.json`, '{}');
  await assert.rejects(discoverLegacyClientMigration(f.input, f.dependencies), { code: 'SOURCE_FORMAT_UNKNOWN' });
});

/** 混合历史目录保留明确加密事实；普通库仍使用真实当前账号 SQLite。 */
function addEncryptedCandidate(sourceDir: string): void {
  const dbPath = path.join(sourceDir, 'client-dbs', 'acct_encryptedaccount', 'codeflowai.db');
  fs.mkdirSync(path.dirname(dbPath));
  fs.writeFileSync(dbPath, 'encrypted fixture');
  fs.writeFileSync(`${dbPath}.meta.json`, JSON.stringify({ encryptionMode: 'server_managed_sqlcipher', cipher: 'sqlcipher', dbId: crypto.randomUUID(), keyVersion: 1 }));
}

/** 核对只读检测前后来源文件、字节和mtime，不以查询结果代替零写入证据。 */
function sourceSnapshot(directory: string): Array<{ file: string; sha256: string; modifiedAt: number }> {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => { const file = path.join(entry.parentPath, entry.name); return { file: path.relative(directory, file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), modifiedAt: fs.statSync(file).mtimeMs }; })
    .sort((left, right) => left.file.localeCompare(right.file));
}

test('混合离线：真实owner本次无候选放行且零来源写入，重开恢复认证后仍提醒当前普通库', async t => {
  const f = fixture(t), { discoverLegacyClientMigration } = await service();
  addEncryptedCandidate(f.sourceDir); f.db.pragma('journal_mode=DELETE'); f.db.close();
  const before = sourceSnapshot(f.sourceDir), logs: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk, encoding, callback) => {
    if (!String(chunk).includes('"event":"LEGACY_MIGRATION_DISCOVERY_DEFERRED"')) return write(chunk, encoding, callback);
    logs.push(String(chunk));
    if (typeof encoding === 'function') encoding(); else callback?.();
    return true;
  });
  let online = false, calls = 0;
  /** 仅替换当前账号认证，owner及磁盘发现保持真实。 */
  const execute: LegacyMigrationExecutor = async request => {
    assert.equal(request.action, 'discover');
    return await discoverLegacyClientMigration(request, { homeDir: f.homeDir, resolveNamespace: async () => {
      calls++;
      if (!online) throw Object.assign(new Error(`offline ${apiKey}`), { code: 'SOURCE_ACCOUNT_UNRESOLVED' });
      return namespace;
    } });
  };
  const options = { dataDir: f.dataDir, workerEntry: 'unused', identity: { deviceId: targetDeviceId, createdAt: new Date().toISOString(), publicKeyBase64: 'fixture' }, execute };
  const owner = createLegacyClientMigration(options);
  const first = owner.prepare(); await owner.whenDiscovered();
  assert.notEqual(owner.snapshot().status, 'failed', JSON.stringify(owner.snapshot()));
  await first;
  assert.equal(owner.snapshot().status, 'running'); assert.equal(owner.snapshot().candidateId, null);
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
  assert.deepEqual(sourceSnapshot(f.sourceDir), before);
  assert.equal(logs.length, 1);
  const log = JSON.parse(logs[0]!);
  assert.equal(log.event, 'LEGACY_MIGRATION_DISCOVERY_DEFERRED');
  assert.equal(log.errorCode, 'SOURCE_ACCOUNT_UNRESOLVED'); assert.equal(log.requestId, 'legacy-discovery');
  assert.equal(log.sourceClientId, clientId); assert.ok(log.targetClientId); assert.equal(log.stage, 'discover');
  assert.ok(log.rootCause); assert.ok(!logs.join('').includes(apiKey));
  await owner.stop(); online = true;
  const reopened = createLegacyClientMigration(options), next = reopened.prepare();
  await reopened.whenDiscovered();
  assert.equal(reopened.snapshot().status, 'available'); assert.equal(reopened.snapshot().workspaceCount, 1);
  assert.ok(reopened.snapshot().candidateId); assert.equal(calls, 2);
  await reopened.defer(); await next; await reopened.stop();
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
  assert.deepEqual(sourceSnapshot(f.sourceDir), before);
});

for (const reason of ['unknown', 'abort-error', 'cancel-signal', 'metadata', 'online-format'] as const) {
  test(`混合离线：${reason}不得被延期边界吞掉`, async t => {
    const f = fixture(t), { discoverLegacyClientMigration } = await service();
    addEncryptedCandidate(f.sourceDir); f.db.close();
    const controller = new AbortController(), unknown = new Error('unexpected namespace failure'), abort = new DOMException('fixture cancelled', 'AbortError');
    let calls = 0;
    if (reason === 'metadata') fs.writeFileSync(`${f.dbPath}.meta.json`, '{broken');
    if (reason === 'online-format') fs.writeFileSync(f.dbPath, 'unknown fixture format');
    const before = sourceSnapshot(f.sourceDir);
    await assert.rejects(discoverLegacyClientMigration(f.input, { homeDir: f.homeDir, signal: controller.signal, resolveNamespace: async () => {
      calls++;
      if (reason === 'unknown') throw unknown;
      if (reason === 'abort-error') throw abort;
      if (reason === 'online-format') return namespace;
      if (reason === 'cancel-signal') controller.abort(abort);
      throw Object.assign(new Error('offline'), { code: 'SOURCE_ACCOUNT_UNRESOLVED' });
    } }), reason === 'metadata' ? { code: 'MIGRATION_JSON_INVALID' } : reason === 'online-format' ? { code: 'SOURCE_FORMAT_UNKNOWN' }
      : reason === 'unknown' ? error => error === unknown : error => error === abort);
    assert.equal(calls, reason === 'metadata' ? 0 : 1);
    assert.deepEqual(fs.readdirSync(f.dataDir), []);
    assert.deepEqual(sourceSnapshot(f.sourceDir), before);
  });
}

test('混合离线：已有journal优先恢复和核验，不经过本次发现延期', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  addEncryptedCandidate(f.sourceDir);
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies), migrationId = crypto.randomUUID();
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId }, { ...f.dependencies,
    afterPublish: () => { throw new Error('fixture publish interrupted'); } }), /fixture publish interrupted/u);
  let calls = 0;
  const offline = { homeDir: f.homeDir, resolveNamespace: async (): Promise<string> => { calls++; throw Object.assign(new Error('offline'), { code: 'SOURCE_ACCOUNT_UNRESOLVED' }); } };
  const pending = await discoverLegacyClientMigration(f.input, offline);
  assert.equal(pending.resume, true); assert.equal(pending.migrationId, migrationId); assert.equal(calls, 0);
  await migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId }, f.dependencies);
  f.open(path.join(f.dataDir, 'codeflowai.db')).pragma(`user_version=${CLIENT_DB_SCHEMA_VERSION + 1}`);
  await assert.rejects(discoverLegacyClientMigration(f.input, offline), { code: 'TARGET_SCHEMA_UNSUPPORTED' });
  assert.equal(calls, 0);
});

test('集中库迁出WAL历史和附件，校准水位并暂停队列，来源保持原样', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  const attachment = history(f.db); const before = f.db.prepare('SELECT * FROM threads').all();
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  const progress: Array<{ stage: string; completed: number; total: number | null }> = [];
  const result = await migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, { ...f.dependencies, onProgress: value => progress.push(value) });
  assert.equal(result.completed, true); assert.equal(result.accountSource?.apiKey, apiKey);
  const app = f.open(path.join(f.dataDir, 'codeflowai.db')), work = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db'));
  const id = `${targetClientId}:one`;
  assert.equal((app.prepare('SELECT id FROM workspaces').get() as { id: string }).id, id);
  assert.equal((JSON.parse(fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8'))).clientId, targetClientId);
  assert.equal((app.prepare("SELECT value FROM meta WHERE key='client_id'").get() as { value: string }).value, targetClientId);
  assert.equal((app.prepare("SELECT value FROM meta WHERE key='event_seq'").get() as { value: string }).value, '900');
  assert.equal((work.prepare("SELECT value FROM meta WHERE key='event_seq_floor'").get() as { value: string }).value, '701');
  assert.equal(work.prepare("SELECT key FROM meta WHERE key LIKE 'conversation_relay:%'").get(), undefined);
  const event = JSON.parse((work.prepare('SELECT event_json FROM conversation_events WHERE seq=700').get() as { event_json: string }).event_json);
  assert.equal(event.workspaceId, id); assert.equal(event.payload.text, '原文 old-client:one 不得替换');
  assert.equal((work.prepare('SELECT paused FROM thread_queue_states').get() as { paused: number }).paused, 1);
  assert.deepEqual((work.prepare('SELECT data FROM file_blobs WHERE blob_id=?').get(attachment.blobId) as { data: Buffer }).data, attachment.data);
  assert.deepEqual(f.db.prepare('SELECT * FROM threads').all(), before);
  assert.deepEqual(work.prepare('PRAGMA foreign_key_check').all(), []);
  assert.ok(progress.some(value => value.stage === 'verify'));
  const journal = fs.readFileSync(path.join(f.dataDir, 'legacy-client-migration-journal.json'), 'utf8');
  assert.ok(!journal.includes(apiKey));
});

test('目标业务库冲突和候选变更均不写来源、不覆盖目标', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  fs.writeFileSync(path.join(f.dataDir, 'codeflowai.db'), 'existing target');
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies), { code: 'TARGET_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'codeflowai.db'), 'utf8'), 'existing target');
});

test('分库路径重合时先归档，并在发布中断后沿同一journal恢复', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  const directory = path.join(f.workspacePath, '.codeflow'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'workspace.db'), '');
  const work = f.open(path.join(directory, 'workspace.db')); migrateClientDb(work, { scope: 'workspace' }); ensureWorkspaceCoreQueueTables(work); ensureWorkspaceAdditionalTables(work); history(work); work.close();
  const original = fs.readFileSync(path.join(directory, 'workspace.db'));
  const migrationId = crypto.randomUUID(), candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId }, { ...f.dependencies,
    afterPublish: () => { throw new Error('simulated-interruption'); } }), /simulated-interruption/);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'codeflowai.db')), false);
  const recovered = await discoverLegacyClientMigration(f.input, f.dependencies);
  assert.equal(recovered.resume, true); assert.equal(recovered.migrationId, migrationId);
  const result = await migrateLegacyClientMigration({ ...f.input, candidateId: recovered.candidateId!, migrationId }, f.dependencies);
  assert.equal(result.completed, true);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'legacy-client-migration-journal.json'), 'utf8'));
  const archived = path.join(f.dataDir, 'legacy-client-migration', migrationId, saved.snapshotGeneration, 'original-workspace-0.db');
  assert.equal(fs.existsSync(archived), true);
  assert.deepEqual(fs.readFileSync(archived), original);
  const completed = await discoverLegacyClientMigration(f.input, f.dependencies);
  assert.equal(completed.completed, true); assert.equal(completed.resume, undefined);
});

for (const storage of ['main', 'wal'] as const) {
  test(`评审修复：快照后中断重试不覆盖旧工作区新增历史（${storage}）`, async t => {
    const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
    const directory = path.join(f.workspacePath, '.codeflow'); fs.mkdirSync(directory);
    const filename = path.join(directory, 'workspace.db'); fs.writeFileSync(filename, '');
    const work = f.open(filename); migrateClientDb(work, { scope: 'workspace' }); ensureWorkspaceCoreQueueTables(work); ensureWorkspaceAdditionalTables(work); history(work); work.close();
    const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
    const request = { ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() };
    await assert.rejects(migrateLegacyClientMigration(request, { ...f.dependencies, onProgress: value => {
      if (value.stage === 'convert') throw new Error('review-interrupted-after-snapshot');
    } }), /review-interrupted-after-snapshot/u);
    const resumedSource = f.open(filename);
    if (storage === 'wal') resumedSource.pragma('journal_mode=WAL');
    resumedSource.prepare("INSERT INTO threads(id,workspace_id,engine,title,created_at,updated_at) VALUES('after-snapshot','old-client:one','codex','中断后新增历史',3,4)").run();
    if (storage === 'main') resumedSource.close();
    const before = sourceSnapshot(directory).filter(file => file.file.startsWith('workspace.db'));
    await assert.rejects(migrateLegacyClientMigration(request, f.dependencies), { code: 'TARGET_CONFLICT' });
    assert.deepEqual(sourceSnapshot(directory).filter(file => file.file.startsWith('workspace.db')), before);
    const retained = storage === 'wal' ? resumedSource : f.open(filename);
    assert.equal((retained.prepare("SELECT title FROM threads WHERE id='after-snapshot'").get() as { title: string }).title, '中断后新增历史');
    assert.equal(fs.existsSync(path.join(f.dataDir, 'codeflowai.db')), false);
    const journal = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'legacy-client-migration-journal.json'), 'utf8'));
    assert.equal(journal.completed, false);
  });
}

for (const persisted of [false, true]) {
  test(`评审修复：启动中的工作流卡片沿仓储恢复为可操作状态（实例${persisted ? '已保存' : '未保存'}）`, async t => {
    const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); history(f.db);
    const task: ChatWorkflowTask = { id: 'task', workspaceId: 'old-client:one', threadId: 'thread', sourceTurnId: 'turn', initiatorUserId: 'owner',
      version: 1, state: 'starting', title: '中断工作流', goal: '保留卡片', context: '', acceptanceCriteria: ['人工恢复'], rationale: '',
      workflow: { id: 'workflow', workspaceId: 'old-client:one', name: '工作流', description: '', family: 'feature-dev', version: 1, nodes: [], edges: [] },
      assetHash: 'asset-hash', proposalId: 'proposal', intakeId: null, instanceId: null,
      acceptedResultVersion: null, acceptedBy: null, acceptedAt: null, rework: null, createdAt: 1, updatedAt: 2 };
    new ChatWorkflowRepo(f.db).create(task);
    f.db.prepare("INSERT INTO chat_workflow_actions(request_id,task_id,actor_user_id,input_hash,state,created_at,updated_at) VALUES('start-task','task','owner','input','processing',1,2)").run();
    if (persisted) {
      f.db.prepare(`INSERT INTO orch_instances(id,workspace_id,workflow_id,workflow_snapshot_json,intake_snapshot_json,status,proposal_id,created_at,updated_at)
        VALUES('instance','old-client:one','workflow',?,?,'running','proposal',1,2)`).run(JSON.stringify(task.workflow), JSON.stringify({ id: 'intake', title: '历史任务', workspaceId: 'old-client:one' }));
      upsertOrchInstanceSummaryProjection(f.db, parseOrchInstanceSummarySourceRow(f.db.prepare("SELECT * FROM orch_instances WHERE id='instance'").get() as Record<string, unknown>));
    }
    const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
    await migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
    const work = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db')), repo = new ChatWorkflowRepo(work);
    const migrated = repo.get('task')!;
    assert.equal(migrated.state, persisted ? 'linked' : 'recommended');
    assert.equal(migrated.instanceId, persisted ? 'instance' : null);
    assert.equal(migrated.workspaceId, `${targetClientId}:one`);
    const row = work.prepare("SELECT state,version FROM chat_workflow_tasks WHERE id='task'").get() as { state: string; version: number };
    assert.equal(row.state, migrated.state); assert.equal(row.version, migrated.version);
    assert.equal((work.prepare("SELECT state FROM chat_workflow_actions WHERE request_id='start-task'").get() as { state: string }).state, persisted ? 'completed' : 'interrupted');
    if (persisted) assert.equal((work.prepare("SELECT status FROM orch_instances WHERE id='instance'").get() as { status: string }).status, 'paused');
    assert.deepEqual(repo.recoverStarts(), []);
    assert.equal(f.db.prepare("SELECT state FROM chat_workflow_tasks WHERE id='task'").get()?.state, 'starting');
  });
}

for (const mode of ['relative', 'absolute', 'staging', 'hash', 'traversal', 'link'] as const) {
  test(`评审修复：产物沿工作区真实路径校验且保留原路径语义（${mode}）`, async t => {
    const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); orchestrationHistory(f.db);
    const outside = path.join(f.root, 'outside'), documents = path.join(f.workspacePath, 'codeflow-docs');
    fs.mkdirSync(outside); fs.mkdirSync(documents);
    const content = Buffer.from('工作流交付内容'), filename = path.join(documents, 'result.md');
    fs.writeFileSync(filename, mode === 'hash' ? 'changed' : content);
    fs.writeFileSync(path.join(outside, 'result.md'), content);
    if (mode === 'link') fs.symlinkSync(outside, path.join(f.workspacePath, 'linked'), 'junction');
    const file = mode === 'absolute' ? filename : mode === 'traversal' ? '../outside/result.md' : mode === 'link' ? 'linked/result.md' : 'codeflow-docs/result.md';
    const artifact = new OrchArtifactRepo(f.db).create({ instanceId: 'instance' as OrchestrationId, nodeId: 'node', kind: 'document', version: 1,
      title: '历史产物', status: 'approved', contentJson: '{}', workspaceStatus: 'published' });
    new OrchArtifactFileRepo(f.db).replaceForArtifact(artifact.id, [{ relPath: 'result.md', stagingPath: mode === 'staging' ? file : null,
      publishedPath: mode === 'staging' ? null : file, status: mode === 'staging' ? 'staging' : 'published', contentHash: crypto.createHash('sha256').update(content).digest('hex'), sizeBytes: content.length }]);
    const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
    const migration = migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
    if (mode === 'hash' || mode === 'traversal' || mode === 'link') {
      await assert.rejects(migration, { code: mode === 'hash' ? 'SOURCE_ARTIFACT_INVALID' : 'FILE_TRANSFER_PATH_INVALID' });
      assert.equal(fs.existsSync(path.join(f.dataDir, 'codeflowai.db')), false);
    } else {
      assert.equal((await migration).completed, true);
      const work = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db'));
      const migrated = new OrchArtifactFileRepo(work).listByArtifact(artifact.id)[0]!;
      assert.equal(mode === 'staging' ? migrated.stagingPath : migrated.publishedPath, file);
      assert.deepEqual(fs.readFileSync(filename), content);
    }
  });
}

test('损坏附件失败，不发布半套数据', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); const attachment = history(f.db);
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  f.db.prepare("UPDATE file_blobs SET data=X'00' WHERE blob_id=?").run(attachment.blobId);
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies), { code: 'SOURCE_BLOB_INVALID' });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'codeflowai.db')), false);
});

test('未知表、高版本与metadata缺失必须保留原数据并显式失败', async t => {
  const f = fixture(t), { discoverLegacyClientMigration } = await service();
  f.db.exec('CREATE TABLE unknown_business(id TEXT);');
  await assert.rejects(discoverLegacyClientMigration(f.input, f.dependencies), { code: 'SOURCE_TABLE_UNSUPPORTED' });
  f.db.exec('DROP TABLE unknown_business; PRAGMA user_version=999');
  await assert.rejects(discoverLegacyClientMigration(f.input, f.dependencies), { code: 'SOURCE_SCHEMA_UNSUPPORTED' });
  f.db.exec('PRAGMA user_version=102'); fs.unlinkSync(`${f.dbPath}.meta.json`);
  await assert.rejects(discoverLegacyClientMigration(f.input, f.dependencies), { code: 'SOURCE_META_UNSUPPORTED' });
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
});

test('当前来源无法认证时不猜其他账号，活跃未知owner不会被停止', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  await assert.rejects(discoverLegacyClientMigration(f.input, { ...f.dependencies, resolveNamespace: async () => { throw Object.assign(new Error('offline'), { code: 'SOURCE_ACCOUNT_UNRESOLVED' }); } }), { code: 'SOURCE_ACCOUNT_UNRESOLVED' });
  const result = await discoverLegacyClientMigration(f.input, f.dependencies);
  fs.writeFileSync(buildClientProcessLockPath(f.dbPath), JSON.stringify({ pid: process.pid, token: 'unverified', clientId, dbPath: f.dbPath, startedAt: 1 }));
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: result.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies), { code: 'SOURCE_OWNER_UNVERIFIED' });
  assert.equal(process.kill(process.pid, 0), true);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'codeflowai.db')), false);
});

test('本机定时配置、runtime及历史随工作区迁入并禁用，应用副本不残留', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  f.db.prepare(`INSERT INTO scheduled_task_configs(id,source,client_id,device_id,workspace_scope_type,workspace_scope_id,name,task_type,cron_expr,timezone,enabled,payload_json,concurrency_policy,missed_policy,timeout_ms,revision,created_at,updated_at)
    VALUES('task','local','old-client','runtime_old','local_workspace','old-client:one','定时任务','script','* * * * *','UTC',1,'{}','skip_if_running','skip_missed',1000,1,1,1)`).run();
  f.db.prepare(`INSERT INTO scheduled_task_runtime_states(task_id,client_id,device_id,last_scheduled_at,updated_at)
    VALUES('__local_scheduled_task__:task','old-client','runtime_old',123,1)`).run();
  const result = await discoverLegacyClientMigration(f.input, f.dependencies);
  await migrateLegacyClientMigration({ ...f.input, candidateId: result.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
  const app = f.open(path.join(f.dataDir, 'codeflowai.db')), work = f.open(path.join(f.workspacePath, '.codeflow', 'workspace.db'));
  assert.deepEqual(work.prepare('SELECT enabled,client_id,device_id,workspace_scope_id FROM scheduled_task_configs').get(),
    { enabled: 0, client_id: targetClientId, device_id: targetDeviceId, workspace_scope_id: `${targetClientId}:one` });
  assert.deepEqual(work.prepare('SELECT client_id,device_id,last_scheduled_at FROM scheduled_task_runtime_states').get(),
    { client_id: targetClientId, device_id: targetDeviceId, last_scheduled_at: 123 });
  assert.equal(app.prepare("SELECT 1 FROM scheduled_task_runtime_states WHERE task_id='__local_scheduled_task__:task'").get(), undefined);
});

test('多工作区的序号空间冲突和结构化悬空引用阻止发布', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service(); history(f.db);
  f.db.prepare("UPDATE thread_drafts SET path_references_json=?").run(JSON.stringify([{ workspaceId: 'old-client:missing', path: 'note.txt' }]));
  const result = await discoverLegacyClientMigration(f.input, f.dependencies);
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: result.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies), { code: 'SOURCE_REFERENCE_INVALID' });
});

test('发布完成前关闭后仍沿原编号恢复，篡改journal路径不能重命名任意文件', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  const result = await discoverLegacyClientMigration(f.input, f.dependencies), migrationId = crypto.randomUUID();
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: result.candidateId!, migrationId }, { ...f.dependencies,
    afterPublish: () => { throw new Error('interrupt'); } }), /interrupt/);
  const journalPath = path.join(f.dataDir, 'legacy-client-migration-journal.json'), journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.files[1].staged = path.join(f.sourceDir, 'config.json'); fs.writeFileSync(journalPath, JSON.stringify(journal));
  await assert.rejects(discoverLegacyClientMigration(f.input, f.dependencies), { code: 'MIGRATION_JOURNAL_INVALID' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.sourceDir, 'config.json'), 'utf8')).apiKey, apiKey);
});

test('完成后新增本地历史不会再次导入或被原始hash阻断，旧账号凭据缺失单独失败', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  const result = await discoverLegacyClientMigration(f.input, f.dependencies);
  await migrateLegacyClientMigration({ ...f.input, candidateId: result.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
  const app = f.open(path.join(f.dataDir, 'codeflowai.db'));
  app.prepare("UPDATE workspaces SET title='迁移后新标题'").run();
  fs.unlinkSync(path.join(f.sourceDir, 'config.json'));
  const completed = await discoverLegacyClientMigration(f.input, f.dependencies);
  assert.equal(completed.completed, true); assert.equal(completed.accountSource, undefined);
  assert.equal((app.prepare('SELECT title FROM workspaces').get() as { title: string }).title, '迁移后新标题');
  app.prepare('DELETE FROM workspaces').run();
  assert.equal((await discoverLegacyClientMigration(f.input, f.dependencies)).completed, true);
});

test('最终复核：完成库的已知低版本留给正常Client升级，过高或未知版本仍拒绝', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  const candidate = await discoverLegacyClientMigration(f.input, f.dependencies);
  await migrateLegacyClientMigration({ ...f.input, candidateId: candidate.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies);
  const app = f.open(path.join(f.dataDir, 'codeflowai.db'));
  app.exec('DROP TABLE local_model_context_preferences; DROP TABLE local_quick_phrase_collection; DROP TABLE local_quick_phrases; PRAGMA user_version=101');
  assert.equal((await discoverLegacyClientMigration(f.input, f.dependencies)).completed, true);
  assert.equal(app.pragma('user_version', { simple: true }), 101, '发现不得代替正常Client执行升级');
  migrateClientDb(app);
  assert.equal(app.pragma('user_version', { simple: true }), CLIENT_DB_SCHEMA_VERSION);
  for (const version of [82, CLIENT_DB_SCHEMA_VERSION + 1]) {
    app.pragma(`user_version=${version}`);
    await assert.rejects(discoverLegacyClientMigration(f.input, f.dependencies), { code: 'TARGET_SCHEMA_UNSUPPORTED' });
  }
});

test('稍后生成的空默认桌面库可以归档接管，包含历史时仍拒绝', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  fs.writeFileSync(path.join(f.dataDir, 'codeflowai.db'), '');
  const target = f.open(path.join(f.dataDir, 'codeflowai.db')); migrateClientDb(target);
  target.prepare("INSERT INTO meta(key,value) VALUES('client_id',?)").run(targetClientId);
  target.prepare("INSERT INTO workspaces(id,title,path,is_deleted,created_at,updated_at) VALUES(?,'默认工作区',?,0,1,1)")
    .run(`${targetClientId}:default`, path.join(f.dataDir, 'workspace')); target.close();
  fs.writeFileSync(path.join(f.dataDir, 'config.json'), JSON.stringify({ clientId: targetClientId, apiKey: '', serverWs: 'ws://localhost:39280/ws/client' }));
  fs.writeFileSync(path.join(f.dataDir, 'codeflowai.db.meta.json'), JSON.stringify({ schemaVersion: 3, storageMode: 'plain_sqlite', ownership: 'local_os_user', initializationState: 'ready' }));
  const result = await discoverLegacyClientMigration(f.input, f.dependencies), migrationId = crypto.randomUUID();
  await migrateLegacyClientMigration({ ...f.input, candidateId: result.candidateId!, migrationId }, f.dependencies);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'legacy-client-migration', migrationId, 'original-empty-application.db')), true);
  assert.equal((f.open(path.join(f.dataDir, 'codeflowai.db')).prepare('SELECT title FROM workspaces').get() as { title: string }).title, '中文项目');
});

test('rename已完成但journal提交未完成时，通过目标摘要恢复原任务', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  const result = await discoverLegacyClientMigration(f.input, f.dependencies), migrationId = crypto.randomUUID();
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: result.candidateId!, migrationId }, { ...f.dependencies,
    afterPublish: () => { throw new Error('interrupt'); } }), /interrupt/);
  const journalPath = path.join(f.dataDir, 'legacy-client-migration-journal.json'), journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.files[0].published = false; fs.writeFileSync(journalPath, JSON.stringify(journal));
  const resumed = await migrateLegacyClientMigration({ ...f.input, candidateId: result.candidateId!, migrationId }, f.dependencies);
  assert.equal(resumed.completed, true);
});

test('真实Worker发送加密排除结果后退出0，非法请求返回失败且不泄漏Key', async t => {
  const f = fixture(t); f.db.close(); fs.writeFileSync(f.dbPath, 'encrypted');
  fs.writeFileSync(`${f.dbPath}.meta.json`, JSON.stringify({ encryptionMode: 'server_managed_sqlcipher', cipher: 'sqlcipher', dbId: crypto.randomUUID(), keyVersion: 1 }));
  const entry = fileURLToPath(new URL('../src/legacy-migration/legacyClientMigrationWorker.ts', import.meta.url));
  /** 真正 fork 同一入口，断言 IPC 结果只有在正常退出后成立。 */
  const run = (request: unknown) => new Promise<{ code: number | null; messages: any[]; stderr: string }>((resolve, reject) => {
    const child = fork(entry, [], { execArgv: ['--conditions=development', '--import', 'tsx'],
      env: { ...process.env, USERPROFILE: f.homeDir, HOME: f.homeDir }, silent: true });
    const messages: any[] = []; let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; }); child.on('message', value => messages.push(value));
    child.once('error', reject); child.once('close', code => resolve({ code, messages, stderr })); child.send(request);
  });
  const success = await run({ ...f.input, action: 'discover' }); assert.equal(success.code, 0);
  assert.deepEqual(success.messages, [{ type: 'result', result: { candidateId: null, workspaceCount: 0 } }]);
  const failure = await run({ ...f.input, action: 'migrate' }); assert.equal(failure.code, 1);
  assert.equal(failure.messages[0].error.code, 'MIGRATION_REQUEST_INVALID'); assert.ok(!failure.stderr.includes(apiKey));
});

test('最终复核：真实owner稍后启动、取消账号并重开后沿正常Client身份接管空初始化', { timeout: 30_000 }, async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  const ids: string[] = [];
  /** 复用真实迁移服务，仅隔离旧HOME与namespace认证。 */
  const execute: LegacyMigrationExecutor = async request => {
    ids.push(request.targetClientId);
    return await (request.action === 'discover' ? discoverLegacyClientMigration : migrateLegacyClientMigration)(request, f.dependencies);
  };
  const identity = { deviceId: targetDeviceId, createdAt: new Date().toISOString(), publicKeyBase64: 'fixture' };
  const options = { dataDir: f.dataDir, workerEntry: 'unused', identity, execute };
  const owner = createLegacyClientMigration(options), preparation = owner.prepare();
  await owner.whenDiscovered();
  assert.equal(owner.snapshot().status, 'available');
  await owner.defer(); await preparation;
  fs.writeFileSync(path.join(f.dataDir, 'device-identity.json'), JSON.stringify({ deviceId: targetDeviceId, createdAt: new Date().toISOString() }));
  const defaultWorkspace = path.join(f.dataDir, 'workspace'); fs.mkdirSync(defaultWorkspace);
  const requestId = crypto.randomUUID(), env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODEFLOWAI_')));
  const child = fork(fileURLToPath(new URL('../src/index.ts', import.meta.url)), ['--foreground'], {
    execArgv: ['--conditions=development', '--import', 'tsx'], silent: true,
    env: { ...env, CODEFLOWAI_SERVER_WS: 'ws://127.0.0.1:1/ws/client', CODEFLOWAI_DESKTOP_REQUEST_ID: requestId, CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(f.dataDir, 'config.json'),
      CODEFLOWAI_CLIENT_DB_PATH: path.join(f.dataDir, 'codeflowai.db'), CODEFLOWAI_CLIENT_LOG_DIR: path.join(f.dataDir, 'logs'),
      CODEFLOWAI_WORKSPACES_JSON: JSON.stringify([{ path: defaultWorkspace, label: '默认工作区' }]),
      CODEFLOWAI_DESKTOP_BUILTIN_ASSET_DIR: fileURLToPath(new URL('../assets/orchestration-builtin', import.meta.url)) },
  });
  let stderr = ''; child.stdout!.resume(); child.stderr!.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`READY_TIMEOUT: ${stderr}`)), 15_000);
    child.on('message', (value: any) => { if (value.t === 'desktop.ready') { clearTimeout(timer); resolve(); } });
    void closed.then(code => { clearTimeout(timer); reject(new Error(`READY_EXIT: ${code}: ${stderr}`)); });
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  child.send({ t: 'desktop.shutdown', requestId }); assert.equal(await closed, 0, stderr);
  const normalClientId = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8')).clientId;
  assert.notEqual(normalClientId, ids[0]);
  await owner.runtimeReady(); await owner.cancelAccount(); await owner.stop();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'legacy-client-migration-account.json'), 'utf8')).migrationId, null);
  const reopened = createLegacyClientMigration(options), next = reopened.prepare();
  await reopened.whenDiscovered();
  assert.equal(reopened.snapshot().status, 'available');
  await reopened.start(reopened.snapshot().candidateId!); await next;
  assert.deepEqual(ids.slice(1), [normalClientId, normalClientId]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8')).clientId, normalClientId);
  await reopened.stop();
});

test('分库全局事件序号冲突会失败而不是发布两个互相重叠的事件空间', async t => {
  const f = fixture(t), { discoverLegacyClientMigration, migrateLegacyClientMigration } = await service();
  const second = path.join(f.root, 'second'); fs.mkdirSync(second);
  f.db.prepare("INSERT INTO workspaces(id,title,path,is_deleted,created_at,updated_at) VALUES('old-client:two','第二项目',?,0,1,2)").run(second);
  for (const [root, id] of [[f.workspacePath, 'old-client:one'], [second, 'old-client:two']]) {
    const directory = path.join(root!, '.codeflow'); fs.mkdirSync(directory); const filename = path.join(directory, 'workspace.db'); fs.writeFileSync(filename, '');
    const db = f.open(filename); migrateClientDb(db, { scope: 'workspace' }); ensureWorkspaceCoreQueueTables(db); ensureWorkspaceAdditionalTables(db); history(db, id); db.close();
  }
  const result = await discoverLegacyClientMigration(f.input, f.dependencies);
  await assert.rejects(migrateLegacyClientMigration({ ...f.input, candidateId: result.candidateId!, migrationId: crypto.randomUUID() }, f.dependencies), { code: 'SOURCE_EVENT_SEQUENCE_CONFLICT' });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'codeflowai.db')), false);
});

test('宿主与已构建Worker迁移后真实Client读取历史，重开不重复导入', { timeout: 40_000 }, async t => {
  const f = fixture(t, initializeLegacy83); history(f.db);
  const workerEntry = fileURLToPath(new URL('../dist/legacyClientMigrationWorker.cjs', import.meta.url));
  assert.equal(fs.existsSync(workerEntry), true, `Worker缺失：${workerEntry}；测试模块：${import.meta.url}；先运行 node scripts/build-bundle.mjs`);
  const requests: string[] = [], children = new Map<ChildProcess, Promise<number | null>>();
  const server = createServer((request, response) => {
    requests.push(request.url!); request.resume();
    if (request.method !== 'POST' || request.url !== '/api/client-db/startup-context' || request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(403).end(); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, accountNamespace: namespace }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(f.sourceDir, 'config.json'), JSON.stringify({ apiKey, serverWs: `ws://127.0.0.1:${port}/ws/client`, clientId }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODEFLOWAI_'))), HOME: f.homeDir, USERPROFILE: f.homeDir };
  let migrateCount = 0, migratedClientId = '';
  /** IPC或关闭未收口时明确超时，finally仍可停止本例子进程。 */
  const bounded = <T>(pending: Promise<T>, code: string): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), 12_000);
    void pending.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  /** 适配器仅隔离 HOME 和收取真实 IPC，结果必须等 Worker close=0。 */
  const execute: LegacyMigrationExecutor = async (request, progress) => {
    if (request.action === 'migrate') { migrateCount++; migratedClientId = request.targetClientId; }
    const child = fork(workerEntry, [], { silent: true, execArgv: [], env });
    const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }); children.set(child, closed);
    let result: LegacyMigrationResult | undefined, failure: Error | undefined, stderr = '';
    child.stdout!.resume(); child.stderr!.on('data', chunk => { stderr += chunk; });
    child.on('message', (message: any) => {
      if (message.type === 'progress') progress(message.progress);
      else if (message.type === 'result') result = message.result;
      else if (message.type === 'error') failure = Object.assign(new Error(message.error.message), { code: message.error.code });
      else { failure = new Error('UNEXPECTED_WORKER_MESSAGE'); child.kill(); }
    });
    child.send(request, error => { if (error) { failure = error; child.kill(); } });
    const code = await bounded(closed, 'WORKER_CLOSE_TIMEOUT'); children.delete(child);
    if (failure) throw failure;
    assert.equal(code, 0, stderr); assert.ok(result); return result;
  };
  const identity = { deviceId: targetDeviceId, createdAt: new Date().toISOString(), publicKeyBase64: 'test-public-key' };
  const restoreAccount = async (): Promise<never> => { throw Object.assign(new Error('TEST_ACCOUNT_OFFLINE'), { code: 'TEST_ACCOUNT_OFFLINE' }); };
  try {
    const owner = createLegacyClientMigration({ dataDir: f.dataDir, workerEntry, identity, execute, restoreAccount });
    const preparation = owner.prepare(); await owner.whenDiscovered();
    assert.equal(owner.snapshot().status, 'available'); await owner.start(owner.snapshot().candidateId!); await preparation;
    assert.equal(migrateCount, 1);
    fs.writeFileSync(path.join(f.dataDir, 'device-identity.json'), JSON.stringify(identity));
    for (let opening = 0; opening < 2; opening++) {
      const requestId = crypto.randomUUID();
      const child = fork(fileURLToPath(new URL('../src/index.ts', import.meta.url)), ['--foreground'], { silent: true,
        execArgv: ['--conditions=development', '--import', 'tsx'], env: { ...env, CODEFLOWAI_DESKTOP_REQUEST_ID: requestId,
          CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(f.dataDir, 'config.json'), CODEFLOWAI_CLIENT_DB_PATH: path.join(f.dataDir, 'codeflowai.db'),
          CODEFLOWAI_CLIENT_LOG_DIR: path.join(f.dataDir, 'logs'), CODEFLOWAI_WORKSPACES_JSON: '[]',
          CODEFLOWAI_DESKTOP_BUILTIN_ASSET_DIR: fileURLToPath(new URL('../assets/orchestration-builtin', import.meta.url)) } });
      const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }); children.set(child, closed);
      let stderr = ''; child.stdout!.resume(); child.stderr!.on('data', chunk => { stderr += chunk; });
      /** 每个真实响应都绑定当前父进程和请求编号，并有独立等待预算。 */
      const response = <T>(match: (value: any) => T | undefined): Promise<T> => new Promise((resolve, reject) => {
        const finish = (error?: Error, value?: T) => { clearTimeout(timer); child.off('message', onMessage); error ? reject(error) : resolve(value!); };
        const onMessage = (value: any) => { const accepted = match(value); if (accepted !== undefined) finish(undefined, accepted); };
        const timer = setTimeout(() => finish(new Error(`CLIENT_IPC_TIMEOUT: ${stderr}`)), 12_000);
        child.on('message', onMessage); void closed.then(code => finish(new Error(`CLIENT_EARLY_EXIT:${code}: ${stderr}`)), finish);
      });
      await response(value => value.t === 'desktop.ready' && value.requestId === requestId ? true : undefined);
      if (opening === 0) { await owner.runtimeReady(); assert.equal(owner.snapshot().account.status, 'failed'); await owner.stop(); }
      /** 仅经运行中的业务 API 读取，不用直接查目标 SQLite 代替可用性。 */
      const api = async (method: string, body?: Record<string, unknown>): Promise<any> => {
        const id = crypto.randomUUID(), pending = response(value => value.t === 'desktop.api.res' && value.requestId === requestId && value.id === id ? value.response : undefined);
        child.send({ t: 'desktop.api.req', requestId, id, request: { method, ...(body ? { body } : {}) } });
        const result = await pending; assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
      };
      const workspaceId = `${migratedClientId}:one`, scope = { workspaceId, threadId: 'thread' };
      assert.ok((await api('workspaces.list')).workspaces.some((work: any) => work.id === workspaceId));
      assert.deepEqual((await api('threads.list', { workspaceId, scope: 'current' })).threads.map((thread: any) => thread.id), ['thread']);
      assert.deepEqual((await api('threads.load', scope)).events.map((event: any) => event.seq), [700]);
      assert.deepEqual((await api('threads.events', scope)).events.map((event: any) => event.seq), [701]);
      child.send({ t: 'desktop.shutdown', requestId }); assert.equal(await bounded(closed, 'CLIENT_CLOSE_TIMEOUT'), 0, stderr); children.delete(child);
      const reopened = createLegacyClientMigration({ dataDir: f.dataDir, workerEntry, identity, execute, restoreAccount });
      const next = reopened.prepare(); await reopened.whenDiscovered();
      assert.notEqual(reopened.snapshot().status, 'failed', JSON.stringify(reopened.snapshot()));
      await next; assert.equal(reopened.snapshot().status, 'running'); assert.equal(migrateCount, 1); await reopened.stop();
    }
    assert.ok(requests.length >= 3); assert.ok(requests.every(url => url === '/api/client-db/startup-context'));
  } finally {
    for (const [child, closed] of children) { if (child.exitCode === null && child.signalCode === null) child.kill(); await bounded(closed, 'TEST_CHILD_CLEANUP_TIMEOUT'); }
    server.closeAllConnections(); await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 'TEST_SERVER_CLOSE_TIMEOUT');
  }
});
