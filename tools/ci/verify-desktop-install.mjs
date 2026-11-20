import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bounded, isolatedEnvironment, launchPackagedApp } from "../../apps/desktop/tests/support/packaged-app.mjs";
import { closeDesktop, createWorkspace, expect, listWorkspaces } from "../../apps/desktop/tests/support/desktop-ui-smoke.mjs";
import { verifyDesktopClientRuntime } from "../../apps/desktop/scripts/prepare-resources.mjs";

const execute = promisify(execFile);
const requestId = crypto.randomUUID();

/** 报告保留完整错误链；安装、启动和清理故障均不得降级为通过。 */
function describeError(error) {
  return { message: error.message, stack: error.stack,
    ...(error.cause ? { cause: describeError(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(describeError) } : {}) };
}

/** Windows 运行真实 NSIS；Mac 挂载真实 DMG，并按拖拽安装语义复制应用。 */
async function install(metadata, installer, work, env) {
  if (process.platform === "win32") {
    const directory = path.join(work, "installation");
    await execute(installer, ["/S", `/D=${directory}`], { env, windowsHide: true, timeout: 300_000 });
    const executable = path.join(directory, "CodeFlowAI.exe");
    await fs.access(executable);
    assert.ok((await fs.readdir(directory)).some(file => /^Uninstall.*\.exe$/iu.test(file)));
    return { executable, resources: path.join(directory, "resources"), directory };
  }
  assert.equal(metadata.platform, "darwin");
  const mount = path.join(work, "mount");
  const directory = path.join(work, "Applications");
  await fs.mkdir(mount);
  await fs.mkdir(directory);
  await execute("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, installer], { timeout: 120_000 });
  let failure, application;
  try {
    const applications = (await fs.readdir(mount)).filter(file => file.endsWith(".app"));
    assert.equal(applications.length, 1, "DESKTOP_CI_DMG_APPLICATION_INVALID");
    application = path.join(directory, applications[0]);
    await execute("/usr/bin/ditto", [path.join(mount, applications[0]), application], { timeout: 120_000 });
  } catch (error) { failure = error; }
  try { await execute("/usr/bin/hdiutil", ["detach", mount], { timeout: 60_000 }); }
  catch (error) { failure = failure ? new AggregateError([failure, error], "DESKTOP_CI_DMG_DETACH_FAILED") : error; }
  if (failure) throw failure;
  const { stdout } = await execute("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleExecutable", path.join(application, "Contents/Info.plist")]);
  const executable = path.join(application, "Contents/MacOS", stdout.trim());
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", application], { timeout: 60_000 });
  return { executable, resources: path.join(application, "Contents/Resources"), directory: application };
}

/** 从安装位置验证桌面布局与工作区读写，两次启动检查真实持久化。 */
async function verify() {
  const [input, destination, ...extra] = process.argv.slice(2);
  if (!input || !destination || extra.length) throw new Error("用法：verify-desktop-install.mjs <构建输出目录> <新验收目录>");
  const build = path.resolve(input), work = path.resolve(destination);
  await fs.mkdir(work);
  const reportDir = path.join(work, "report");
  await fs.mkdir(reportDir);
  const report = { requestId, status: "running", steps: [], runs: [] };
  /** 每步完成即保存事实，runner 中断时仍保留最后成功阶段。 */
  async function checkpoint(step) {
    report.steps.push(step);
    await fs.writeFile(path.join(reportDir, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ code: "DESKTOP_CI_INSTALL_PROGRESS", requestId, step }));
  }
  let application, page, failure;
  await checkpoint("verification-started");
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(build, "build.json"), "utf8"));
    assert.equal(metadata.purpose, "ci-installation-test");
    assert.equal(metadata.platform, process.platform);
    assert.equal(metadata.arch, process.arch);
    assert.equal(path.basename(metadata.installer), metadata.installer);
    const installer = path.join(build, "installers", metadata.installer);
    const bytes = await fs.readFile(installer);
    assert.equal(bytes.length, metadata.size);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), metadata.sha256);
    report.build = metadata;
    const env = await isolatedEnvironment(work);
    const installed = await install(metadata, installer, work, env);
    report.installation = installed;
    await checkpoint("installer-executed");
    report.runtime = await verifyDesktopClientRuntime({ clientDir: path.join(installed.resources, "client"),
      runtimeExecutable: installed.executable, expectedClientVersion: metadata.version });
    await checkpoint("installed-native-runtime-verified");
    const project = path.join(work, "project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "keep.txt"), "desktop-installation-verification\n", { flag: "wx" });
    let workspaceId;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const launched = await launchPackagedApp({ executablePath: installed.executable, userDataDir: path.join(work, "profile"), env, cwd: work,
        timeoutMs: 120_000 });
      application = launched.application;
      report.runs.push(launched.run);
      const facts = await bounded(application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, executable: process.execPath,
        resources: process.resourcesPath, platform: process.platform, arch: process.arch, electron: process.versions.electron })),
      30_000, "DESKTOP_CI_MAIN_FACTS_TIMEOUT");
      assert.equal(facts.isPackaged, true);
      assert.equal(await fs.realpath(facts.executable), await fs.realpath(installed.executable));
      assert.equal(await fs.realpath(facts.resources), await fs.realpath(installed.resources));
      report.runs.at(-1).facts = facts;
      page = await application.firstWindow({ timeout: 120_000 });
      await page.waitForURL("**/chat", { timeout: 120_000 });
      // CI 虚拟屏幕默认宽 1024，固定原生窗口尺寸以验收桌面布局。
      report.runs.at(-1).window = await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setMinimumSize(1360, 800);
        window.setContentSize(1440, 900);
        return window.getContentBounds();
      });
      await expect(page.locator('[data-testid="desktop-main-pane"]')).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('[data-testid="left-sidebar"]')).toBeVisible({ timeout: 60_000 });
      const loginPrompt = page.locator(".desktop-auth-modal-host");
      if (attempt === 1) {
        await expect(loginPrompt).toBeVisible({ timeout: 60_000 });
        await loginPrompt.getByRole("checkbox", { name: "不再提醒登录", exact: true }).check();
        await loginPrompt.getByRole("button", { name: "Close", exact: true }).click();
      }
      await expect(loginPrompt).toBeHidden();
      const settings = page.getByRole("dialog", { name: "设置", exact: true });
      if (await settings.isVisible()) {
        await settings.getByRole("button", { name: "Close", exact: true }).click();
        await expect(settings).toBeHidden();
      }
      await page.screenshot({ path: path.join(reportDir, `installed-initial-${attempt}.png`) });
      await checkpoint(`desktop-ui-ready-${attempt}`);
      if (attempt === 1) {
        await createWorkspace(page, { title: "CI 安装验收", directory: project });
        const workspace = (await bounded(listWorkspaces(page), 45_000, "DESKTOP_CI_WORKSPACES_READ_TIMEOUT"))
          .find(item => item.title === "CI 安装验收");
        assert.ok(workspace?.id, "DESKTOP_CI_WORKSPACE_NOT_CREATED");
        workspaceId = workspace.id;
      } else {
        assert.ok((await bounded(listWorkspaces(page), 45_000, "DESKTOP_CI_WORKSPACES_READ_TIMEOUT"))
          .some(item => item.id === workspaceId && item.title === "CI 安装验收"),
          "DESKTOP_CI_WORKSPACE_NOT_PERSISTED");
      }
      await expect(page.getByRole("button", { name: /切换工作区，当前 CI 安装验收/u })).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: path.join(reportDir, `installed-launch-${attempt}.png`) });
      await checkpoint(`workspace-verified-${attempt}`);
      await bounded(closeDesktop(application), 35_000, "DESKTOP_CI_QUIT_TIMEOUT");
      application = undefined;
      await checkpoint(attempt === 1 ? "installed-ui-and-workspace-created" : "restart-and-persistence-verified");
    }
    assert.equal(await fs.readFile(path.join(project, "keep.txt"), "utf8"), "desktop-installation-verification\n");
  } catch (error) { failure = error; }
  if (failure && page && !page.isClosed()) {
    try {
      await page.screenshot({ path: path.join(reportDir, "failure.png") });
      await fs.writeFile(path.join(reportDir, "failure.html"), await bounded(page.content(), 15_000, "DESKTOP_CI_PAGE_READ_TIMEOUT"), { flag: "wx" });
    } catch (error) { failure = new AggregateError([failure, error], "DESKTOP_CI_PAGE_EVIDENCE_FAILED"); }
  }
  if (application) {
    try { await bounded(closeDesktop(application), 35_000, "DESKTOP_CI_CLEANUP_TIMEOUT"); }
    catch (error) {
      failure = failure ? new AggregateError([failure, error], "DESKTOP_CI_APP_CLEANUP_FAILED") : error;
      // 清理超时只终止本验收创建的应用进程，原始失败仍保留。
      try { application.process().kill("SIGKILL"); }
      catch (error) { failure = new AggregateError([failure, error], "DESKTOP_CI_PROCESS_CLEANUP_FAILED"); }
    }
  }
  try {
    for (const [source, target] of [["runtime/logs", "client-logs"], ["profile/logs", "shell-logs"]]) {
      const directory = path.join(work, source);
      let stat;
      try { stat = await fs.stat(directory); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (stat?.isDirectory()) await fs.cp(directory, path.join(reportDir, target), { recursive: true, errorOnExist: true, force: false });
    }
  } catch (error) { failure = failure ? new AggregateError([failure, error], "DESKTOP_CI_LOG_COLLECTION_FAILED") : error; }
  report.status = failure ? "failed" : "passed";
  if (failure) report.error = describeError(failure);
  try { await fs.writeFile(path.join(reportDir, "verification.json"), `${JSON.stringify(report, null, 2)}\n`); }
  catch (error) { failure = failure ? new AggregateError([failure, error], "DESKTOP_CI_REPORT_WRITE_FAILED") : error; }
  if (failure) throw failure;
  console.log(JSON.stringify({ code: "DESKTOP_CI_INSTALL_PASSED", requestId,
    report: path.join(reportDir, "verification.json"), steps: report.steps }));
}

try { await verify(); }
catch (error) {
  writeSync(2, `${JSON.stringify({ code: "DESKTOP_CI_VERIFICATION_FAILED", requestId, rootCause: error.message, error: describeError(error) })}\n`);
  // 独立验收进程已完成有界清理，失败时不让调试管道继续占住 runner。
  process.exit(1);
}
