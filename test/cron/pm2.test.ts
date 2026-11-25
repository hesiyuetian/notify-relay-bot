import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("PM2 部署预检检查所选任务，显示北京排期并立即退出", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2 config "));
  try {
    const root = new URL("../../", import.meta.url);
    const entry = join(dir, "dist/pm2-scheduler.js");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    copyFileSync(new URL("dist/pm2-scheduler.js", root), entry);
    symlinkSync(new URL("node_modules/", root), join(dir, "node_modules"), "dir");
    symlinkSync(new URL("dist/tools/", root), join(dir, "dist/tools"), "dir");
    const check = (configuration: string) => {
      writeFileSync(join(dir, ".env"), configuration);
      return spawnSync(process.execPath, [entry, "--check"], { cwd: tmpdir(), env: { TZ: "UTC" }, encoding: "utf8", timeout: 5000 });
    };
    const valid = check("SMTP_HOST=test\nSMTP_USER=test\nSMTP_PASS=test\nMAIL_TO=test@example.test\n");
    assert.equal(valid.status, 0, valid.error?.message ?? valid.stderr);
    assert.match(valid.stdout, /telegram-email  \* \* \* \* \*/);
    assert.match(valid.stdout, /github-trending  0 22 \* \* \*.*22:00:00/);
    assert.doesNotMatch(valid.stdout, /stocks|ai-news/);
    assert.equal(check("PM2_TASKS=telegram-email\nSERVERCHAN_SENDKEY=test\n").status, 0);
    assert.match(check("PM2_TASKS=unknown").stderr, /未知任务/);
    assert.match(check("PM2_TASKS=github-trending\nSERVERCHAN_SENDKEY=test").stderr, /配置可用的推送渠道/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
