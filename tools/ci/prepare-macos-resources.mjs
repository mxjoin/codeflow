import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDesktopResources } from "../../apps/desktop/scripts/prepare-resources.mjs";
import { buildReleaseBundle } from "../../apps/desktop/scripts/build-release-bundle.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const schemaSource = await fs.readFile(path.join(repoRoot, "apps/desktop/client/src/db/clientDbSchemaVersion.ts"), "utf8");
const dbSchemaVersion = Number(schemaSource.match(/CLIENT_DB_SCHEMA_VERSION\s*=\s*(\d+)/u)?.[1]);
if (!Number.isSafeInteger(dbSchemaVersion) || dbSchemaVersion <= 0) throw new Error("CLIENT_DB_SCHEMA_VERSION_INVALID");
const [clientArchive, npmPackageDir, workDir] = process.argv.slice(2).map(value => value && path.resolve(value));
if (!clientArchive || !npmPackageDir || !workDir) {
  throw new Error("用法：prepare-macos-resources.mjs <Client.tgz> <npm 包目录> <工作目录>");
}
if (!["x64", "arm64"].includes(process.arch)) throw new Error(`不支持的 macOS 架构：${process.arch}`);

const pad = value => String(value).padStart(2, "0");
const now = new Date();
const version = process.env.CODEFLOWAI_DESKTOP_DMG_VERSION
  || `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}.01`;
const resources = path.join(repoRoot, "apps/desktop/dist/resources");
const first = path.join(workDir, "resources-first");
const baseline = path.join(workDir, "baseline-bundle");
const privateKeyFile = path.join(workDir, "dmg-private.pem");
const trustFile = path.join(workDir, "dmg-trust.json");
for (const target of [first, baseline, resources]) {
  try { await fs.lstat(target); throw new Error(`目标已存在：${target}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
await fs.mkdir(workDir, { recursive: true });

const keys = crypto.generateKeyPairSync("ed25519");
await fs.writeFile(privateKeyFile, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx" });
await fs.writeFile(trustFile, `${JSON.stringify({ dmgLocal: keys.publicKey.export({ format: "pem", type: "spki" }) })}\n`, { flag: "wx" });

const common = {
  archive: clientArchive,
  clientDir: path.join(repoRoot, "apps/desktop/client"),
  webDir: path.join(repoRoot, "apps/web/dist"),
  npmPackageDir,
  trustedReleaseKeysFile: trustFile,
  expectedClientVersion: version,
};
await prepareDesktopResources({ ...common, outputDir: first });
const bundle = await buildReleaseBundle({
  resourcesDir: first, outputDir: baseline, privateKeyFile,
  metadata: { releaseId: `dmg-local-${version}`, version, webVersion: version, clientVersion: version,
    protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion, platform: "darwin", arch: process.arch,
    keyId: "dmgLocal", createdAt: now.toISOString(), expiresAt: "2099-12-31T00:00:00.000Z" },
});
await prepareDesktopResources({ ...common, outputDir: resources, baselineReleaseManifestFile: path.join(bundle.outputDir, "manifest.json") });
console.log(JSON.stringify({ code: "MACOS_RESOURCES_READY", resources, version, arch: process.arch }));
