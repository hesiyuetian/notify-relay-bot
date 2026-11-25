import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Exercise the production Linux utilities and Node's dotenv loading without contacting a delivery service.
test("服务器 cron 在独立工作目录读取配置，加锁并按任务保存成功状态", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "server cron "));
  try {
    const tasks = ["telegram-email", "github-trending", "ai-news", "stocks"];
    mkdirSync(join(dir, "deploy"));
    const script = join(dir, "deploy/run-task.sh");
    copyFileSync(new URL("../../deploy/run-task.sh", import.meta.url), script);
    writeFileSync(join(dir, ".env"), "TEST_SERVER_ENV=loaded\n");
    for (const task of tasks) {
      const dist = join(dir, "dist", task);
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "main.js"), `
        if (process.env.TEST_SERVER_ENV !== "loaded") process.exit(1);
        if (process.env.FAIL_TASK) process.exit(17);
        console.log(JSON.stringify(process.argv.slice(2)));
      `);
    }
    const options = { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin", NODE_BIN: process.execPath }, encoding: "utf8" as const };
    const run = (...args: string[]) => {
      const result = spawnSync("sh", [script, ...args], options);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.equal(run("github-trending", "--dry-run"), '["--dry-run"]');
    assert.equal(spawnSync("sh", [script, "stocks"], {
      ...options, env: { ...options.env, FAIL_TASK: "1" },
    }).status, 17);
    for (const task of ["github-trending", "ai-news", "stocks"]) {
      assert.equal(run(task), "[]");
      assert.match(readFileSync(join(dir, ".cron", task + ".last-success"), "utf8"), /^\d{4}-\d{2}-\d{2}\n$/);
      assert.equal(run(task), "");
    }
    assert.equal(run("telegram-email"), "[]");
    assert.equal(run("telegram-email"), "[]");
    const held = spawnSync("flock", [join(dir, ".cron/telegram-email.lock"), "sh", script, "telegram-email"], options);
    assert.equal(held.status, 0, held.stderr);
    assert.equal(held.stdout, "");
    assert.equal(spawnSync("sh", [script, "stocks", "--force"], options).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
