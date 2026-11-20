import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/features/orchestration/components/role-definition-form.vue", import.meta.url), "utf8");

test("角色表单 tab 可点击时显示手型光标", () => {
  assert.match(source, /\.role-form__tab\s*\{[^}]*cursor\s*:\s*pointer/u);
});
