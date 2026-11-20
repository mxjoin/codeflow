import fs from "node:fs/promises";
import path from "node:path";

/** 复制固定版本 npm 并展开包内链接，保证桌面资源签名库存只含普通文件。 */
export async function copyNpmPackage({ npmPackageDir, targetDir, expectedVersion }) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(npmPackageDir, "package.json"), "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`DESKTOP_NPM_PACKAGE_INVALID: ${error.message}`), { code: "DESKTOP_NPM_PACKAGE_INVALID", cause: error });
  }
  if (manifest?.name !== "npm" || typeof manifest.version !== "string" || typeof expectedVersion !== "string") {
    throw Object.assign(new Error("DESKTOP_NPM_PACKAGE_INVALID: expected package name npm with a string version"), { code: "DESKTOP_NPM_PACKAGE_INVALID" });
  }
  if (manifest.version !== expectedVersion) {
    throw Object.assign(new Error(`DESKTOP_NPM_VERSION_MISMATCH: expected ${expectedVersion}, found ${manifest.version}`), {
      code: "DESKTOP_NPM_VERSION_MISMATCH",
    });
  }
  // 打包只认 npm-cli.js 入口；仅有 package.json 的残缺包必须在复制前失败。
  try {
    await fs.access(path.join(npmPackageDir, "bin", "npm-cli.js"));
  } catch (error) {
    throw Object.assign(new Error(`DESKTOP_NPM_PACKAGE_INVALID: missing bin/npm-cli.js: ${error.message}`), {
      code: "DESKTOP_NPM_PACKAGE_INVALID", cause: error,
    });
  }
  const sourceRoot = await fs.realpath(npmPackageDir);
  await fs.cp(sourceRoot, targetDir, { recursive: true, force: false, errorOnExist: true, dereference: true,
    /** 展开链接前拒绝包外目标，避免外部文件进入桌面资源。 */
    filter: async source => {
      if ((await fs.lstat(source)).isSymbolicLink()) {
        const relative = path.relative(sourceRoot, await fs.realpath(source));
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw Object.assign(new Error("DESKTOP_NPM_LINK_OUTSIDE_PACKAGE"), { code: "DESKTOP_NPM_LINK_OUTSIDE_PACKAGE" });
        }
      }
      return true;
    },
  });
}
