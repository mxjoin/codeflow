import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyNpmPackage } from "../scripts/cli-runtime-resources.mjs";

// Mac npm 的 .bin 链接必须实体化，包外目标仍明确拒绝。
test("materializes npm bin links and rejects targets outside the package", { skip: process.platform === "win32" && "POSIX file symlink fixture" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-links-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "npm"), target = path.join(root, "out");
  await fs.mkdir(path.join(source, "bin"), { recursive: true });
  await fs.mkdir(path.join(source, "node_modules", ".bin"), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "npm", version: "12.2.2" }));
  await fs.writeFile(path.join(source, "bin", "npm-cli.js"), "fixture npm", "utf8");
  await fs.symlink("../../bin/npm-cli.js", path.join(source, "node_modules", ".bin", "arborist"));
  await copyNpmPackage({ npmPackageDir: source, targetDir: target, expectedVersion: "12.2.2" });
  const installed = path.join(target, "node_modules", ".bin", "arborist");
  assert.equal((await fs.lstat(installed)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(installed, "utf8"), "fixture npm");
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "must not be bundled", "utf8");
  await fs.symlink(outside, path.join(source, "node_modules", ".bin", "outside"));
  await assert.rejects(copyNpmPackage({ npmPackageDir: source, targetDir: path.join(root, "rejected"), expectedVersion: "12.2.2" }),
    { code: "DESKTOP_NPM_LINK_OUTSIDE_PACKAGE" });
});

test("copies the bundled npm package and rejects version mismatch", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-resources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "npm"), target = path.join(root, "out");
  await fs.mkdir(path.join(source, "bin"), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "npm", version: "12.2.2" }));
  await fs.writeFile(path.join(source, "bin", "npm-cli.js"), "fake npm cli", "utf8");
  await copyNpmPackage({ npmPackageDir: source, targetDir: target, expectedVersion: "12.2.2" });
  assert.equal(await fs.readFile(path.join(target, "bin", "npm-cli.js"), "utf8"), "fake npm cli");
  await assert.rejects(
    () => copyNpmPackage({ npmPackageDir: source, targetDir: path.join(root, "bad"), expectedVersion: "11.0.0" }),
    (error: unknown) => (error as { code?: string; message?: string }).code === "DESKTOP_NPM_VERSION_MISMATCH"
      && /DESKTOP_NPM_VERSION_MISMATCH/u.test(String((error as { message?: string }).message)),
  );
});

test("rejects an npm package without bin/npm-cli.js before copying", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-resources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "npm-without-bin"), target = path.join(root, "out");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "npm", version: "12.2.2" }), "utf8");
  await assert.rejects(
    () => copyNpmPackage({ npmPackageDir: source, targetDir: target, expectedVersion: "12.2.2" }),
    (error: unknown) => (error as { code?: string }).code === "DESKTOP_NPM_PACKAGE_INVALID",
  );
  await assert.rejects(fs.access(target), { code: "ENOENT" });
});

test("rejects a non-npm package with a coded error before copying", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-resources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "not-npm"), target = path.join(root, "out");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "not-npm", version: "12.2.2" }), "utf8");
  await assert.rejects(
    () => copyNpmPackage({ npmPackageDir: source, targetDir: target, expectedVersion: "12.2.2" }),
    (error: unknown) => (error as { code?: string; message?: string }).code === "DESKTOP_NPM_PACKAGE_INVALID"
      && /DESKTOP_NPM_PACKAGE_INVALID/u.test(String((error as { message?: string }).message)),
  );
  await assert.rejects(fs.access(target), { code: "ENOENT" });
});
