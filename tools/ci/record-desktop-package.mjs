import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const requestId = crypto.randomUUID();

/** 记录当前构建的唯一 DMG，绑定 Git 提交、Client 版本和实际文件摘要供安装验收。 */
async function recordPackage() {
  if (process.argv.length !== 3) throw new Error("用法：record-desktop-package.mjs <DMG 输出目录>");
  const installers = path.resolve(process.argv[2]), output = path.dirname(installers);
  const files = (await fs.readdir(installers)).filter(file => file.endsWith(".dmg"));
  if (files.length !== 1) throw new Error("MACOS_DMG_COUNT_INVALID");
  const bytes = await fs.readFile(path.join(installers, files[0]));
  const metadata = { schemaVersion: 1, requestId, purpose: "ci-installation-test", sourceRepository: "hs-codeflow/codeflow",
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    platform: process.platform, arch: process.arch, version: process.env.CODEFLOWAI_DESKTOP_DMG_VERSION,
    installer: files[0], size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    developerIdSigned: false, notarized: false, published: false };
  if (!metadata.version || metadata.platform !== "darwin" || !["arm64", "x64"].includes(metadata.arch)) throw new Error("MACOS_DMG_METADATA_INVALID");
  await fs.writeFile(path.join(output, "build.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  await fs.writeFile(path.join(output, "SHA256SUMS"), `${metadata.sha256}  ${metadata.installer}\n`, { flag: "wx" });
  console.log(JSON.stringify({ code: "MACOS_DESKTOP_PACKAGE_READY", ...metadata }));
}

try { await recordPackage(); }
catch (error) {
  console.error(JSON.stringify({ code: "MACOS_PACKAGE_RECORD_FAILED", requestId, rootCause: error.message, stack: error.stack }));
  process.exitCode = 1;
}
