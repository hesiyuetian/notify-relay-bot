# AGENTS.md

本文件适用于整个仓库。开发或改动部署前，先阅读对应的任务入口、测试和部署配置。[README](README.md) 提供安装、运维和迁移的详细步骤。

## 开发规范

- 使用 Node.js ≥ 22.18、TypeScript 和 ESM。[tsconfig.json](tsconfig.json) 使用 `NodeNext` 和严格类型检查。源码的相对导入沿用 `.ts` 扩展名，由编译器在输出时改写为 `.js`。
- 在 `src/<任务>/` 修改任务代码。沿用现有的采集、格式化、推送分工，`main.ts` 负责串联步骤和处理命令行选项。跨任务逻辑放在 `src/tools/`，优先复用环境变量读取、收件人解析、HTML 转义、北京时间及推送工具。
- 使用 `npm run build` 将源码编译到 `dist/`。npm 任务、PM2、系统 cron 和 GitHub Actions 的正式运行入口都使用编译产物。修改源码后重新编译，`dist/` 由构建生成并保持在 Git 忽略范围内。
- 新建或调整依赖时同步更新 `package.json` 和 `pnpm-lock.yaml`。构建阶段安装开发依赖，TypeScript 编译器在 `devDependencies`。
- 变更保持在需求范围内。调整任务名称、入口、参数、排期或配置时，核对相关的 npm 脚本、GitHub workflow、PM2 调度表、crontab 模板和 README，更新受影响的地方。
- 新增功能或调整已有行为时，同一提交或 PR 同步更新相关文档（如 `README.md`、`.env.example`、`AGENTS.md` 等），保持功能说明、配置项、目录结构、入口命令和排期与代码一致。

## 新增服务的部署要求

新增需要独立部署或定时运行的服务时，**同一个提交或 PR 必须在 `.github/workflows/` 新增或更新对应的工作流**，并同步更新适用的 PM2、系统 cron 入口及部署说明。即使首次只上线服务器，GitHub Actions 的部署配置也要随代码交付。

- 在工作流中接好编译后的入口、运行参数及所需的 Secrets 和 Variables。定时服务还要核对手动触发、计划触发、时区及并发设置。涉及持久状态的服务要接好状态的读取和保存。
- 提交前核对工作流引用的脚本、参数和配置名。从干净检出的环境安装依赖、编译并运行新服务的预览或模拟测试，确认工作流能找到并启动 `dist/` 入口。交付时注明对应工作流文件和验证结果。

## 配置和投递

- 服务器通过项目根目录的 `.env` 配置。GitHub Actions 用 **Secrets** 保存凭据和收件人，用 **Variables** 配置 `TELEGRAM_CHANNEL`、`*_CHANNELS` 等非敏感选项。新增配置时同步更新适用的部署入口、`.env.example` 和说明，示例只填写公开默认值或占位值。
- `MAIL_TO` 支持逗号分隔的多个地址，每位收件人单独投递。Telegram Bot 收件人用 `TELEGRAM_CHAT_ID`，转发来源用 `TELEGRAM_CHANNEL`，个人微信用 `SERVERCHAN_SENDKEY`。凭据、真实收件地址和聊天 ID 留在部署配置中，日志使用渠道名、收件人序号和帖子编号。
- Telegram 频道按频道和接收端分别保存投递进度。首次启用的频道或接收端从当时的最新帖建立基线，已有进度的按帖子编号补发。只在服务接受投递后推进该接收端的进度，保留失败或限流后的重试行为。
- 币安监控每轮查询带单组合最近 2 天内的最新 10 条成交，账户凭据无需注入。首次启用的组合或接收端用当前记录建立基线。按组合和接收端保存进度，发送失败时保留已采集记录，来源限流后保留退避时间。
- 日期、显示时间和服务器排期使用 `Asia/Shanghai`。GitHub workflow 中现有 cron 表达式用 UTC，修改时做好换算。潜力股正式任务保留交易日检查和 09:15 的行情采集截止判断，默认 09:20 推送。
- 保留本地预览和正式投递的区别。`--dry-run` 可请求公开数据并输出内容，遇到需要验证发送的改动时，优先使用模拟接口或测试收件人。GitHub 的 `test`、`test-wechat` 和 `test-feishu` 会真实投递，使用前确认运行意图。

## 验证与交付

- 从项目根目录运行 `npm test`。它会通过 `pretest` 先执行 `npm run build`，再用 Node 内置测试框架执行 `test/**/*.test.ts`。改动入口或部署时，优先验证 `dist/` 中的实际运行路径。
- 按改动范围选择预览命令，例如 `npm run telegram-email:dry-run`。测试以固定样本或模拟网络响应为主。涉及频道投递时，核对连续新帖、重复检查、换频道以及接收端失败后的进度。
- 修改部署脚本时用 `sh -n` 检查语法。涉及 `flock`、`timeout` 或服务器 cron 的行为时，到 Linux 验证。部分服务器测试在 macOS 会跳过，交付时说明验证结果和边界。
- 提交代码和实际部署是两个动作。按本次任务的授权推送、触发线上工作流、修改 Secrets 或 Variables、启停生产任务及发送真实测试通知。交付时说明改动和测试结果，区分已上线与仅在工作区完成的内容。

## 任务与排期

下表记录代码和模板中的排期，生产启停以各部署环境的实际配置为准。服务器模板默认启用频道转发和 GitHub 涨星，其余任务按需开启。

| 任务名            | GitHub workflow      | 主排期（北京时间）                   | GitHub 自带计划 |
| ----------------- | -------------------- | ------------------------------------ | --------------- |
| `telegram-email`  | `telegram-relay.yml` | 每分钟检查                           | 每 5 分钟       |
| `binance-copy`    | `binance-copy.yml`   | Linux 每 30 秒，外部每分钟派发两轮   | 每 5 分钟       |
| `github-trending` | `daily.yml`          | 每天 22:00                           | 22:17           |
| `ai-news`         | `ai-news.yml`        | 每天 08:00                           | 08:17           |
| `stocks`          | `stocks.yml`         | 工作日 09:00 启动，交易日 09:20 推送 | 工作日 09:10    |

## GitHub Actions 部署流程

1. 配置仓库 Actions Secrets 和 Variables，确认对应任务已启用。发布到默认分支 `main` 后，后续运行使用对应版本的代码。
2. 由 cron-job.org 通过 `workflow_dispatch` 传入 `mode=scheduled`，GitHub 自带的 `schedule` 作为兜底。正式运行使用工作流的并发组。每日任务通过 [already-pushed.yml](.github/workflows/already-pushed.yml) 检查最近 12 小时内成功的正式推送。
3. Runner 安装依赖并执行 `npm test`，编译和测试通过后运行对应的 `dist/` 入口。频道转发和币安监控分别从 `telegram-email-state` 和 `binance-copy-state` 恢复 SQLite，在运行后保存投递进度，包括部分接收端成功的进度。币安正式任务通过 Actions Variable `BINANCE_COPY_ENABLED=true` 启用，每次派发约间隔 30 秒检查两轮。
4. 上线后检查相应工作流的构建、运行和进度保存结果。暂停一个任务时，同时停用对应的 cron-job.org 任务和 GitHub workflow。

## Linux 服务器部署流程

1. 用同一个部署账号拉取代码、配置 `.env` 和运行任务。服务器需要 Node.js ≥ 22.18、npm、`flock` 和 GNU `timeout`。按任务选择 PM2 或系统 cron。
2. **PM2**。安装 PM2，在 `.env` 设置 `PM2_TASKS`，运行 [pm2-deploy.sh](deploy/pm2-deploy.sh)。脚本依次安装依赖、编译、预检，用 PM2 启动或重启 `notify-relay-bot-scheduler` 并保存进程列表。调度器运行 `dist/pm2-scheduler.js`，按排期调用 [run-task.sh](deploy/run-task.sh)。更新用 `git pull --ff-only` 后重跑部署脚本，使用 `pm2 status notify-relay-bot-scheduler` 和 `pm2 logs notify-relay-bot-scheduler --lines 50` 验证。
3. **系统 cron**。安装含开发依赖的项目依赖，执行 `npm run build`，创建日志所需的 `.cron/`，再按 [crontab.example](deploy/crontab.example) 配置绝对路径和时区。每次触发由 `run-task.sh` 加载 `.env` 并运行编译产物。更新代码后先重新编译，再检查 cron 日志。
4. **运行状态**。PM2 与系统 cron 共用同一目录的任务锁和成功记录 `.cron/`。频道进度保存在 `.telegram-email/*.sqlite`，币安监控进度保存在 `.binance-copy/*.sqlite`。更新部署时保留这些目录和 `.env`。

## 调度交接

- 同一个任务只在一个部署环境中正式调度。可以把频道转发交给服务器，其他任务继续交给 GitHub。服务器上也按任务在 PM2 和系统 cron 中选定一个入口。
- 迁移频道时，先预览验证目标环境可读频道，再停用源环境的调度并等在途执行结束。把最后一次运行产生的 SQLite 进度从源环境同步到目标环境后，再打开目标调度。从 GitHub 到服务器从 `telegram-email-state` 导入，回切时把最终进度同步到该分支。[进度迁移步骤](README.md#投递进度与切换)
- 目标环境已有数据库时，交接前先保留原库并核对进度。每日任务安排在当天尚未投递时交接，或从次日开始，以免两端各发一次。
