import test from "node:test";
import assert from "node:assert/strict";

import {
  extractCliVersion,
  handleClientExit,
  resolveAlreadyInstalledCliVersion,
  resolveClientUpgradeInstallUrl,
  verifyInstalledCliPackage,
} from "../../apps/desktop/client/src/app/handlers/softwareUpdateHandlers.ts";

test("extractCliVersion normalizes cli version text", () => {
  assert.equal(extractCliVersion("2.1.92 (Claude Code)"), "2.1.92");
  assert.equal(extractCliVersion("codex-cli 0.98.0"), "0.98.0");
  assert.equal(extractCliVersion(""), null);
});

test("verifyInstalledCliPackage rejects a broken local claude install", async () => {
  const result = await verifyInstalledCliPackage({
    npmPackage: "@anthropic-ai/claude-code",
    probes: {
      claude: async () => ({
        installed: false,
        version: null,
        binPath: "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
        error: "Error: Cannot find module 'C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'",
      }),
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.installedVersion, null);
  assert.match(result.error ?? "", /Cannot find module/);
});

test("verifyInstalledCliPackage rejects a mismatched requested version", async () => {
  const result = await verifyInstalledCliPackage({
    npmPackage: "@anthropic-ai/claude-code",
    requestedVersion: "2.1.91",
    probes: {
      claude: async () => ({
        installed: true,
        version: "2.1.92",
        binPath: "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
        error: null,
      }),
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.installedVersion, "2.1.92");
  assert.match(result.error ?? "", /版本不匹配/);
});

test("verifyInstalledCliPackage rejects stale codex after upgrade", async () => {
  const result = await verifyInstalledCliPackage({
    npmPackage: "@openai/codex",
    requestedVersion: "0.147.0",
    probes: {
      codex: async () => ({
        installed: true,
        version: "0.146.0",
        binPath: "/usr/local/bin/codex",
        error: null,
      }),
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.installedVersion, "0.146.0");
  assert.match(result.error ?? "", /期望 0\.147\.0，实际 0\.146\.0/);
  assert.match(result.error ?? "", /PATH/);
});

test("verifyInstalledCliPackage accepts a verified local codex install", async () => {
  const result = await verifyInstalledCliPackage({
    npmPackage: "@openai/codex",
    requestedVersion: "0.98.0",
    probes: {
      codex: async () => ({
        installed: true,
        version: "0.98.0",
        binPath: "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        error: null,
      }),
    },
  });

  assert.deepEqual(result, {
    success: true,
    installedVersion: "0.98.0",
    binPath: "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    error: null,
  });
});

test("resolveAlreadyInstalledCliVersion returns no-op when codex already matches target version", async () => {
  const result = await resolveAlreadyInstalledCliVersion({
    npmPackage: "@openai/codex",
    requestedVersion: "0.147.0",
    probes: {
      codex: async () => ({
        installed: true,
        version: "0.147.0",
        binPath: "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        error: null,
      }),
    },
  });

  assert.deepEqual(result, {
    installedVersion: "0.147.0",
    binPath: "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    message: "无需升级，当前已是 0.147.0",
  });
});

test("resolveAlreadyInstalledCliVersion returns null when codex version differs", async () => {
  const result = await resolveAlreadyInstalledCliVersion({
    npmPackage: "@openai/codex",
    requestedVersion: "0.147.0",
    probes: {
      codex: async () => ({
        installed: true,
        version: "0.146.0",
        binPath: "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        error: null,
      }),
    },
  });

  assert.equal(result, null);
});

test("handleClientExit responds before requesting shutdown", async () => {
  const messages: any[] = [];
  const shutdownReasons: string[] = [];

  await handleClientExit(
    {
      send(message: unknown) {
        messages.push(message);
      },
      requestShutdown(reason: string) {
        shutdownReasons.push(String(reason ?? ""));
      },
    } as any,
    {
      id: "req-client-exit",
      body: { clientId: "client-exit-1" },
    } as any,
  );

  assert.deepEqual(messages, [
    {
      t: "api.res",
      id: "req-client-exit",
      status: 200,
      body: { ok: true, clientId: "client-exit-1", exiting: true },
    },
  ]);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(shutdownReasons, ["client.exit:client-exit-1"]);
});

test("resolveClientUpgradeInstallUrl prefers the connected server address plus downloadPath", () => {
  assert.equal(
    resolveClientUpgradeInstallUrl({
      serverWsUrl: "wss://codeflowai.cn/ws/client",
      downloadPath: "/downloads/codeflowai-2026.04.17.09.tgz",
      installUrl: "https://evil.example/codeflowai-2026.04.17.09.tgz",
    }),
    "https://codeflowai.cn/downloads/codeflowai-2026.04.17.09.tgz",
  );
  assert.equal(
    resolveClientUpgradeInstallUrl({
      serverWsUrl: "wss://codeflowai.cn/ws/client",
      downloadPath: "/downloads/codeflowai-2026.04.17.09-win32-x64.tgz",
    }),
    "https://codeflowai.cn/downloads/codeflowai-2026.04.17.09-win32-x64.tgz",
  );
  assert.equal(
    resolveClientUpgradeInstallUrl({
      serverWsUrl: "wss://codeflowai.cn/ws/client",
      downloadPath: "/downloads/codeflowai-latest-win32-x64.tgz",
    }),
    "https://codeflowai.cn/downloads/codeflowai-latest-win32-x64.tgz",
  );
});

test("resolveClientUpgradeInstallUrl allows localhost and private-network http upgrade sources", () => {
  assert.equal(
    resolveClientUpgradeInstallUrl({
      serverWsUrl: "ws://127.0.0.1:39280/ws/client",
      downloadPath: "/downloads/codeflowai-2026.04.17.09.tgz",
    }),
    "http://127.0.0.1:39280/downloads/codeflowai-2026.04.17.09.tgz",
  );
  assert.equal(
    resolveClientUpgradeInstallUrl({
      serverWsUrl: "ws://192.168.1.25:39280/ws/client",
      downloadPath: "/downloads/codeflowai-2026.04.17.09.tgz",
    }),
    "http://192.168.1.25:39280/downloads/codeflowai-2026.04.17.09.tgz",
  );
});

test("resolveClientUpgradeInstallUrl falls back to a trusted absolute installUrl when downloadPath is unavailable", () => {
  assert.equal(
    resolveClientUpgradeInstallUrl({
      serverWsUrl: null,
      downloadPath: null,
      installUrl: "https://downloads.safe.example/codeflowai-2026.04.17.09.tgz",
    }),
    "https://downloads.safe.example/codeflowai-2026.04.17.09.tgz",
  );
});

test("resolveClientUpgradeInstallUrl validates paths, protocols, and same-server public HTTP", () => {
  assert.equal(
    resolveClientUpgradeInstallUrl({
      serverWsUrl: "wss://codeflowai.cn/ws/client",
      downloadPath: "/downloads/skills-bin/manifest.json",
      installUrl: "file:///tmp/payload.tgz",
    }),
    null,
  );
  assert.equal(
    resolveClientUpgradeInstallUrl({
      serverWsUrl: "ws://codeflowai.cn/ws/client",
      downloadPath: "/downloads/codeflowai-2026.04.17.09.tgz",
    }),
    "http://codeflowai.cn/downloads/codeflowai-2026.04.17.09.tgz",
  );
  assert.equal(
    resolveClientUpgradeInstallUrl({
      serverWsUrl: null,
      downloadPath: null,
      installUrl: "http://evil.example/codeflowai-2026.04.17.09.tgz",
    }),
    null,
  );
});
