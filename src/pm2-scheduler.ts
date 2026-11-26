import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Cron } from "croner";
import { portfolioId } from "./binance-copy/orders.ts";
import { configuredChannelsFor, env, type TaskName } from "./tools/channels.ts";
import { splitList } from "./tools/list.ts";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile(".env");

const schedules = new Map<TaskName, string>([
  ["telegram-email", "* * * * *"],
  ["binance-copy", "0,30 * * * * *"],
  ["github-trending", "0 22 * * *"],
  ["ai-news", "0 8 * * *"],
  ["stocks", "0 9 * * 1-5"],
]);
const tasks = splitList(process.env.PM2_TASKS ?? "telegram-email,github-trending");
const checkOnly = process.argv.includes("--check");

function runTask(task: string) {
  const child = spawn("./deploy/run-task.sh", [task], {
    detached: true,
    stdio: ["ignore", task === "telegram-email" || task === "binance-copy" ? "inherit" : "ignore", "inherit"],
    env: { ...process.env, NODE_BIN: process.execPath },
  });
  child.on("error", (error) => console.error(`启动 ${task} 失败：${error.message}`));
  child.on("exit", (code, signal) => {
    if (code !== 0) console.error(`${task} 退出：${signal ?? code}`);
  });
  child.unref();
}

if (!tasks.length) throw new Error("请在 .env 的 PM2_TASKS 中指定要运行的任务");
for (const task of tasks) {
  if (!schedules.has(task as TaskName)) throw new Error(`PM2_TASKS 包含未知任务：${task}`);
  if (task === "binance-copy") portfolioId(env("BINANCE_COPY_PORTFOLIO_ID"));
  if (configuredChannelsFor(task as TaskName).length === 0) {
    throw new Error(`请在 .env 中为 ${task} 配置可用的推送渠道`);
  }
}

for (const task of tasks) {
  const pattern = schedules.get(task as TaskName)!;
  const job = new Cron(pattern, { timezone: "Asia/Shanghai", paused: checkOnly }, () => runTask(task));
  if (checkOnly) {
    const next = job.nextRun()!.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    console.log(`${task}  ${pattern}  下次运行（北京时间）${next}`);
    job.stop();
  }
}
if (!checkOnly) process.send?.("ready");
