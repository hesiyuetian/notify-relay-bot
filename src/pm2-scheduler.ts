import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Cron } from "croner";
import { portfolioId } from "./binance-copy/orders.ts";
import { configuredChannelsFor, env, type TaskName } from "./tools/channels.ts";
import { splitList } from "./tools/list.ts";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile(".env");

const BINANCE_MIN_INTERVAL_MS = 45_000;
const BINANCE_MAX_INTERVAL_MS = 60_000;
const BINANCE_INITIAL_JITTER_MS = 15_000;

const cronSchedules = new Map<TaskName, string>([
  ["telegram-email", "* * * * *"],
  ["github-trending", "0 22 * * *"],
  ["ai-news", "0 8 * * *"],
  ["stocks", "0 9 * * 1-5"],
]);
const knownTasks = new Set<TaskName>([...cronSchedules.keys(), "binance-copy"]);
const tasks = splitList(process.env.PM2_TASKS ?? "telegram-email,github-trending");
const checkOnly = process.argv.includes("--check");

const randomBetween = (minMs: number, maxMs: number): number =>
  minMs + Math.floor(Math.random() * (maxMs - minMs + 1));

function runTask(task: string, onDone?: () => void) {
  const child = spawn("./deploy/run-task.sh", [task], {
    detached: true,
    stdio: ["ignore", task === "telegram-email" || task === "binance-copy" ? "inherit" : "ignore", "inherit"],
    env: { ...process.env, NODE_BIN: process.execPath },
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone?.();
  };
  child.on("error", (error) => {
    console.error(`启动 ${task} 失败：${error.message}`);
    finish();
  });
  child.on("exit", (code, signal) => {
    if (code !== 0) console.error(`${task} 退出：${signal ?? code}`);
    finish();
  });
  // Self-scheduled tasks keep the child referenced so PM2 stays alive when they are the only enabled task.
  if (!onDone) child.unref();
}

function scheduleBinanceLoop(delayMs: number) {
  setTimeout(() => {
    runTask("binance-copy", () => {
      scheduleBinanceLoop(randomBetween(BINANCE_MIN_INTERVAL_MS, BINANCE_MAX_INTERVAL_MS));
    });
  }, delayMs);
}

if (!tasks.length) throw new Error("请在 .env 的 PM2_TASKS 中指定要运行的任务");
for (const task of tasks) {
  if (!knownTasks.has(task as TaskName)) throw new Error(`PM2_TASKS 包含未知任务：${task}`);
  if (task === "binance-copy") portfolioId(env("BINANCE_COPY_PORTFOLIO_ID"));
  if (configuredChannelsFor(task as TaskName).length === 0) {
    throw new Error(`请在 .env 中为 ${task} 配置可用的推送渠道`);
  }
}

for (const task of tasks) {
  if (task === "binance-copy") {
    if (checkOnly) {
      console.log("binance-copy  45-60s 随机间隔  启动抖动 0-15 秒后持续随机轮询（仅服务器运行）");
    } else {
      scheduleBinanceLoop(randomBetween(0, BINANCE_INITIAL_JITTER_MS));
    }
    continue;
  }
  const pattern = cronSchedules.get(task as TaskName)!;
  const job = new Cron(pattern, { timezone: "Asia/Shanghai", paused: checkOnly }, () => runTask(task));
  if (checkOnly) {
    const next = job.nextRun()!.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    console.log(`${task}  ${pattern}  下次运行（北京时间）${next}`);
    job.stop();
  }
}
if (!checkOnly) process.send?.("ready");
