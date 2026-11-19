import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const webRequire = createRequire(new URL("../../../web/package.json", import.meta.url));
const { _electron: electron, expect } = webRequire("@playwright/test");
const executablePath = createRequire(import.meta.url)("electron");
const desktopMain = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const DEFAULT_WEB_ENTRY = "http://localhost:39281";

export { expect };

/** 创建本次 UI 验收独占的临时根与干净环境，不继承用户或 Server 配置。 */
export async function createUiRoot(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("CODEFLOWAI_") && key !== "ELECTRON_RUN_AS_NODE"));
  return { root, env };
}

/** Windows 上 Electron profile 句柄释放有延迟，清理临时根时重试占用。 */
export async function removeUiRoot(root) {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

/** Web 入口不可用时明确失败，避免把前置缺失伪装成 UI 断言失败。 */
async function assertWebEntry(webEntry) {
  let response;
  try {
    response = await fetch(webEntry, { redirect: "manual" });
  } catch (error) {
    throw new Error(`DESKTOP_UI_WEB_ENTRY_UNAVAILABLE: ${webEntry}`, { cause: error });
  }
  if (!response.ok) throw new Error(`DESKTOP_UI_WEB_ENTRY_UNAVAILABLE: ${webEntry}`);
}

/** 等待聊天页后交回壳句柄；entry可指定隔离构建，失败保留启动及清理错误。 */
export async function launchDesktop({ root, env, webEntry = DEFAULT_WEB_ENTRY, entry = desktopMain }) {
  await assertWebEntry(webEntry);
  const application = await electron.launch({
    executablePath,
    args: [entry, `--user-data-dir=${path.join(root, "profile")}`],
    env: { ...env, CODEFLOWAI_DESKTOP_DATA_DIR: path.join(root, "runtime"), CODEFLOWAI_DESKTOP_WEB_ENTRY: webEntry },
    timeout: 60_000,
  });
  try {
    const page = await application.firstWindow({ timeout: 60_000 });
    await page.waitForURL("**/chat", { timeout: 60_000 });
    page.setDefaultTimeout(30_000);
    return { application, page };
  } catch (error) {
    try {
      await closeDesktop(application);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "DESKTOP_UI_STARTUP_AND_CLEANUP_FAILED");
    }
    throw error;
  }
}

/** 首装脚本显式等待并关闭原设置引导，不改设置或处理其他对话框。 */
export async function closeInitialSettings(page) {
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(settings).toBeVisible({ timeout: 30_000 });
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(settings).toBeHidden();
}

/** 沿顶部独立新建按钮打开工作区表单，不绕过界面禁用状态。 */
export async function openCreateWorkspaceDialog(page) {
  await page.getByRole("button", { name: "新建工作区", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建工作区", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 复用真实导航创建并切换到新工作区，断言切换器名称已更新。 */
export async function createWorkspace(page, { title, directory }) {
  const dialog = await openCreateWorkspaceDialog(page);
  await dialog.locator('input[name="codeflow-workspace-title"]').fill(title);
  await dialog.locator('input[name="codeflow-workspace-path"]').fill(directory);
  await dialog.getByRole("button", { name: /^创\s*建$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: new RegExp(`切换工作区，当前 ${escapeRegExp(title)}`) })).toBeVisible({ timeout: 30_000 });
}

/** 调用壳的正式退出入口，等待进程真正退出。 */
export async function closeDesktop(application) {
  if (!application) return;
  await Promise.all([
    application.waitForEvent("close", { timeout: 30_000 }),
    application.evaluate(({ app }) => { app.quit(); }),
  ]);
  // Windows Chromium 在 close 事件后仍会短暂写 profile；等待句柄释放，避免清理临时目录 EBUSY。
  await new Promise(resolve => setTimeout(resolve, 800));
}

/** 通过受限桌面桥读取事实，不注入业务状态。 */
export async function desktopRequest(page, input) {
  return await page.evaluate(input => window.codeflowDesktop.request(input), input);
}

/** 读取工作区列表，作为 UI 操作后的事实核对。 */
export async function listWorkspaces(page) {
  const response = await desktopRequest(page, { method: "workspaces.list" });
  if (response.status !== 200 || !Array.isArray(response.body?.workspaces)) throw new Error("DESKTOP_UI_WORKSPACES_INVALID");
  return response.body.workspaces;
}

/** 通过真实桌面 API 准备会话夹具；会话的切换与搜索仍由 UI 用例操作。 */
export async function createThreadFixture(page, { workspaceId, title, engine = "codex" }) {
  const response = await desktopRequest(page, { method: "threads.create", body: { workspaceId, engine, title } });
  if (response.status !== 200 || typeof response.body?.threadId !== "string") throw new Error("DESKTOP_UI_THREAD_CREATE_INVALID");
  return response.body.threadId;
}

/** 精确匹配包含特殊字符的工作区标题。 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
