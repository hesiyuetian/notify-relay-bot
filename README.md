# notify-relay-bot

每天北京时间 22:00 抓取 [GitHub Trending](https://github.com/trending?since=daily)，按 **今日涨星数** 排序取前 10，推送到 Telegram Bot 和邮箱。每条包含：仓库名、说明、仓库地址、今日涨星、总星数、语言。

GitHub 没有 Trending 官方 API，所以脚本解析 Trending 页面（约 25 个仓库），再按 "stars today" 重新排序。

另外还有两个推送，三个任务共用同一套 Telegram / 邮箱配置：

- **每天北京时间 08:00**：AI 圈过去 24 小时的 10 条要闻，用 Claude 或 ChatGPT 挑选和写中文摘要（见下方「AI 圈每日要闻」）。
- **每个 A 股交易日北京时间 09:20**：10 只当日潜力股，每只附推荐理由，可选 AI 选股和点评（见下方「每日潜力股」）。

## 部署（GitHub Actions）

1. 新建一个 GitHub 仓库（私有也行），把本目录全部推上去。
2. 仓库 → **Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret                  | 说明                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`    | 找 [@BotFather](https://t.me/BotFather) 发 `/newbot` 拿到                                                                                           |
| `TELEGRAM_CHAT_ID`      | 多人用英文逗号分隔，如 `121321,4345345`。获取方式：先给你的 bot 发一条消息，然后打开 `https://api.telegram.org/bot<TOKEN>/getUpdates`，看 `chat.id` |
| `SMTP_HOST`             | Gmail: `smtp.gmail.com` · QQ 邮箱: `smtp.qq.com` · 163: `smtp.163.com`                                                                              |
| `SMTP_PORT`             | 可不填，默认 `465` (SSL)                                                                                                                            |
| `SMTP_USER`             | 发件邮箱地址                                                                                                                                        |
| `SMTP_PASS`             | **不是登录密码**：Gmail 用「应用专用密码」，QQ/163 用「SMTP 授权码」                                                                                |
| `MAIL_TO`               | 收件地址，多个用英文逗号分隔，每人单独发一封（互相看不到对方地址）                                                                                  |
| `FEISHU_WEBHOOK_URL`    | 可选，飞书群自定义机器人的 Webhook 地址                                                                                                             |
| `FEISHU_WEBHOOK_SECRET` | 使用机器人签名校验时填写机器人的签名密钥                                                                                                            |
| `ANTHROPIC_API_KEY`     | 可选，AI 要闻和潜力股 AI 选股用 Claude。在 [Claude Console](https://platform.claude.com) 创建，按用量单独计费，和 Claude Pro 订阅无关               |
| `OPENAI_API_KEY`        | 可选，AI 要闻和潜力股 AI 选股用 ChatGPT。在 [OpenAI Platform](https://platform.openai.com) 创建，同样和 ChatGPT Plus 订阅无关                       |

3. 打开 **Actions** 标签 → 选「GitHub 今日涨星推送」→ **Run workflow** 手动跑一次，确认收到。之后每天自动执行。「AI 圈每日要闻推送」「每日潜力股推送」同理，潜力股手动运行时会跳过交易日判断并立即推送。

邮箱、Telegram Bot 和飞书按任务启用且已配置的渠道独立投递。频道转发另外支持个人微信。各任务可通过环境变量或 GitHub Actions Variables 自定义推送渠道。

## 任务推送渠道

每个任务在 `src/tools/channels.ts` 中定义了默认推送渠道，也可以在服务器 `.env` 或仓库 **Settings → Secrets and variables → Actions → Variables** 中覆盖（英文逗号分隔；留空使用默认值）：

| 任务              | 变量名                     | 可选渠道                   | 默认值                  |
| ----------------- | -------------------------- | -------------------------- | ----------------------- |
| `github-trending` | `GITHUB_TRENDING_CHANNELS` | `telegram`, `email`, `feishu` | `telegram,email`（不推飞书） |
| `ai-news`         | `AI_NEWS_CHANNELS`         | `telegram`, `email`, `feishu` | `telegram,email,feishu` |
| `stocks`          | `STOCKS_CHANNELS`          | `telegram`, `email`, `feishu` | `telegram,email,feishu` |
| `telegram-email`  | `TELEGRAM_RELAY_CHANNELS`  | `email`, `wechat`, `feishu`   | `email,wechat,feishu`   |

- 只有同时满足「在任务推送渠道中启用」和「已配置对应凭据」的渠道才会发送（个人微信另需 `WECHAT_PUSH_ENABLED=true`）。
- 填写不支持的渠道名会在运行或 PM2 预检时报错；`telegram-relay` 的 `--test-*` 测试命令只检查被测试渠道本身，不受 `TELEGRAM_RELAY_CHANNELS` 限制。

## 飞书群推送

四个任务都支持推送到同一个配置的飞书群（其中 GitHub 今日涨星默认关闭飞书推送，可在上方 `GITHUB_TRENDING_CHANNELS` 中按需开启）。新启用的飞书接收端从 Telegram 频道当时的最新帖建立基线，之后按帖子编号独立保存投递进度。

1. 打开目标飞书群，在群设置的「群机器人」里添加「自定义机器人」，复制 Webhook。选择「签名校验」时，同时复制签名密钥。如使用自定义关键词，确保要接收的通知正文或标题包含其中一个关键词。[飞书配置说明](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
2. GitHub Actions 在仓库 Secrets 中添加 `FEISHU_WEBHOOK_URL` 和启用签名时所需的 `FEISHU_WEBHOOK_SECRET`。PM2 或系统 cron 在服务器 `.env` 填写同名变量。修改 PM2 配置后重跑 `./deploy/pm2-deploy.sh`，系统 cron 的下一次任务会读取新配置。
3. 在 Actions 的「Telegram 频道转发」选择 `test-feishu`，或在安装依赖并编译的服务器上运行下面的命令。该命令向飞书发送一条带「[测试]」的最新消息，正式投递进度独立保存。

```bash
node --env-file=.env dist/telegram-relay/main.js --test-feishu
```

## Telegram 频道转邮箱、个人微信和飞书

`telegram-relay.yml` 读取一个公开频道，按已配置的渠道转发新帖。通知包含频道发布时间（北京时间）、正文和原帖链接，纯媒体帖通过原帖查看。邮件收件人沿用 `MAIL_TO`，多个地址分别投递，发件使用上表的 SMTP 配置。默认频道为 [@aoying999](https://t.me/s/aoying999)。

- **更换订阅频道**：在仓库 Actions Variables 编辑 `TELEGRAM_CHANNEL`，可填 `aoying999`、`@aoying999` 或 `https://t.me/s/aoying999`。下一次运行使用新值，邮箱、微信和飞书同步切换。首次使用的频道从当时最新帖开始，切回曾用频道时从之前的进度补发。本地运行在 `.env` 设置同名变量。[仓库 Actions Variables](https://github.com/hesiyuetian/notify-relay-bot/settings/variables/actions)
- **测试到达**：在 Actions 选择「Telegram 频道转发」，运行默认的 `test`，会把最新一条发到 `MAIL_TO`，标题带「[测试]」。本地只预览可用 `npm run telegram-email:dry-run`。
- **个人微信**：在 Server酱 Turbo 的「消息通道」绑定方糖服务号。在 GitHub Actions Secrets 或服务器 `.env` 配置 `SERVERCHAN_SENDKEY`。个人微信默认暂停。在 GitHub Actions Variables 或服务器 `.env` 将 `WECHAT_PUSH_ENABLED` 设为 `true` 即可启用，设为 `false` 暂停。PM2 部署修改后需重启调度器。启用后可用 `test-wechat` 发送一条测试通知，恢复推送时沿用已有投递进度。[Server酱 Turbo](https://sct.ftqq.com/sendkey/)
- 微信首次启用时从当前最新帖开始，之后每条新帖都发给个人微信。邮箱和微信分别记录进度，发送失败时保留该渠道的待发帖子。Server酱接受请求后进度才会推进。免费版每天 5 条，日额度用尽后可能积压；服务返回限流时会延后重试。[服务额度与限制](https://sct.ftqq.com/docs/getting-started/faq/)
- **每分钟检查**：在 [cron-job.org 控制台](https://console.cron-job.org/) 复制本仓库已有的定时推送任务，名称改为「Telegram 频道转发」，URL 改为 `https://api.github.com/repos/hesiyuetian/notify-relay-bot/actions/workflows/telegram-relay.yml/dispatches`，周期选择 **Every minute**（`* * * * *`）。保留原有 GitHub 授权请求头、POST 方法，正文设为 `{"ref":"main","inputs":{"mode":"scheduled"}}`。启用后可在任务历史中查看每次调用结果，在 GitHub Actions 查看实际检查和发送结果。已有任务可直接编辑 URL，改为新的工作流文件名。
- **正式运行**：每次调用检查一次。GitHub 自带计划每 5 分钟兜底，两个入口共用进度。调度排队、网络或发信耗时可能使实际到达超过一分钟。每个新收件人从首次检查时的最新帖开始，后续按编号从旧到新补发。频道编辑和删除不会触发邮件。
- **发送进度**：Actions 自动创建 `telegram-email-state` 独立分支，需允许工作流向该分支写入。进度库保存收件人地址哈希和帖子编号。并发任务排队；某个邮箱发送失败会在下次检查时重试。如果 SMTP 已接受邮件后任务突然中止，或保存分支失败，下次可能重复发送。
- **本地运行**：在常开设备上先执行 `npm run build`，再用系统定时器每分钟从项目根目录运行一次 `node --env-file=.env dist/telegram-relay/main.js`。保留本地 `.telegram-email/` 目录。请在 Actions 和本地之间选一个正式运行位置，各自的进度独立。

## 准点触发（cron-job.org）

Actions 自带的定时任务不保证准点，高峰期可能延迟几个小时甚至被跳过，所以推送由 [cron-job.org](https://cron-job.org)（免费）到点调 GitHub API 触发，几十秒内就会开始运行。自带的定时任务保留作兜底：

| 工作流                            | cron-job.org 触发（北京时间）  | Actions 兜底 |
| --------------------------------- | ------------------------------ | ------------ |
| `telegram-relay.yml` Telegram 频道转发 | 每分钟                         | 每 5 分钟    |
| `daily.yml` GitHub 今日涨星       | 每天 22:00                     | 22:17        |
| `ai-news.yml` AI 圈每日要闻       | 每天 08:00                     | 08:17        |
| `stocks.yml` 每日潜力股           | 周一到周五 09:00（09:20 推送） | 09:10        |

同一工作流的运行按并发组排队。频道邮件按每个收件人的帖子编号去重。其他三个工作流发现 12 小时内已成功推送就跳过（判断逻辑在 `already-pushed.yml`）。

配置一次即可：

1. GitHub 头像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**：Repository access 只选本仓库，Permissions 里 **Actions** 选 **Read and write**，其他不给，有效期 1 年（到期前 GitHub 会邮件提醒）。这些任务共用这一个 token。
2. 在 cron-job.org 注册后，按上表每个工作流 **Create cronjob** 一次：
    - URL：`https://api.github.com/repos/<用户名>/<仓库名>/actions/workflows/<工作流文件名>/dispatches`
    - Schedule：按上表时间，时区选 **Asia/Shanghai**
    - Advanced：Request method 选 **POST**；Headers 加 `Authorization: Bearer <token>` 和 `Accept: application/vnd.github+json`；Request body 填 `{"ref":"main","inputs":{"mode":"scheduled"}}`
3. 保存后点 **Test run**，返回 204 即成功，Actions 页面会出现一条以「（定时）」结尾的运行。

在 Actions 页面手动点 **Run workflow** 默认是 `test` 模式：立即推送（潜力股还会跳过交易日判断），运行名以「（测试）」结尾，不影响正式推送的防重复判断。

## 部署到 Linux 服务器（PM2）

PM2 运行编译产物 `dist/pm2-scheduler.js`，进程名为 `notify-relay-bot-scheduler`，按北京时间调用现有的 `deploy/run-task.sh`。默认每分钟转发 Telegram 新帖、每天 22:00 推送 GitHub 涨星。AI 要闻和潜力股默认暂停。

1. 部署账号准备 Node.js ≥ 22.18、npm、PM2（可用 `npm install -g pm2` 安装）、`flock` 和 GNU `timeout`。新服务器先克隆仓库，已有部署直接进入项目目录。
2. 在项目根目录用 `umask 077; cp -n .env.example .env` 准备配置，填写所需的邮箱、微信或 Telegram 凭据。用 `PM2_TASKS=telegram-email,github-trending` 选择任务；只迁移频道时填 `PM2_TASKS=telegram-email`。按需加入 `ai-news`（08:00）或 `stocks`（工作日 09:00 启动）。
3. 先按下方「投递进度与切换」完成同一任务的调度交接。从本机系统 cron 迁入时注释对应的 crontab 行，沿用同一目录的 `.cron/` 和 `.telegram-email/`；从 Actions 迁入时按说明导入频道进度。
4. 运行部署脚本。它安装含 TypeScript 的构建依赖，执行 `npm run build`，校验编译后的调度器与配置，打印下一次执行时间，然后启动或重启同一个 PM2 进程，并用 `pm2 save` 保存部署账号的进程列表。编译或预检失败会在重启 PM2 前退出。每次触发直接运行对应的 `dist/` 入口。

```bash
./deploy/pm2-deploy.sh
pm2 status notify-relay-bot-scheduler
pm2 logs notify-relay-bot-scheduler --lines 50
```

更新时执行 `git pull --ff-only` 并重新运行部署脚本。修改 `.env` 后也请重新运行。临时暂停全部任务用 `pm2 stop notify-relay-bot-scheduler`，恢复用部署脚本。已启动的单次任务会继续执行至结束或超时。首次配置服务器重启自启时，运行 `pm2 startup` 并执行它输出的系统服务安装命令，然后执行 `pm2 save`。

仓库改名后，在原部署目录运行 `git remote set-url origin https://github.com/hesiyuetian/notify-relay-bot.git`，再更新和重跑部署脚本。新进程启动后，脚本会移除同一部署目录中的旧 PM2 进程 `ai-bot-scheduler`，继续使用原有的 `.env` 和投递进度。已有 cron-job.org 任务的 dispatch URL 里也应使用新仓库名。

## 部署到 Linux 服务器（系统 cron）

服务器 cron 和 GitHub Actions 共用四个编译后的 `dist/` 入口。每个任务可以单独选运行位置，例如让服务器每分钟转发频道，GitHub Actions 继续推送每日涨星。同一任务在两端都有正式调度时，两个环境的进度独立，可能重复发信。

### 首次部署

准备 Node.js ≥ 22.18、系统 cron、`flock`（util-linux）和 `timeout`（GNU coreutils）。以下以部署账号有权写入的 `/opt/notify-relay-bot` 为例。该账号负责安装依赖和运行 cron。

```bash
git clone https://github.com/hesiyuetian/notify-relay-bot.git /opt/notify-relay-bot
cd /opt/notify-relay-bot
npm install --include=dev --no-audit --no-fund
npm run build
umask 077
cp -n .env.example .env
mkdir -p .cron
command -v node flock timeout
node --version
```

在服务器的 `.env` 填入自己的 `MAIL_TO`、SMTP 配置、`TELEGRAM_CHANNEL` 和 `SERVERCHAN_SENDKEY` 等所需变量。GitHub Actions Secrets 只在对应工作流中注入，服务器需要单独配置。执行下面的预览命令可验证 Node 和频道网络访问。预览只打印内容。

```bash
./deploy/run-task.sh telegram-email --dry-run
```

### 定时和启停

用部署账号执行 `crontab -e`，把 [服务器 crontab 模板](deploy/crontab.example) 中需要的配置追加进去。将 `APP_DIR` 改成部署目录，`NODE_BIN` 改成上一步 `command -v node` 输出的绝对路径。使用 NVM 时也填写该路径。保存后用 `crontab -l` 核对，用 `tail -f /opt/notify-relay-bot/.cron/tasks.log` 查看运行结果。为该日志配置服务器的日志轮转。

模板启用每分钟频道检查和北京时间 22:00 的 GitHub 涨星。AI 要闻和潜力股两行默认注释。恢复时取消对应注释即可。潜力股正式任务在工作日 09:00 启动，沿用交易日判断和默认 09:20 推送时间。

模板按北京时间填写。`CRON_TZ` 需要 cron 守护进程支持（如 Cronie）。若服务器的 cron 使用 UTC 且不支持 `CRON_TZ`，将涨星、AI 要闻、潜力股的触发时间分别改为 **14:00、00:00、工作日 01:00 UTC**。每分钟任务无需换算。

### 投递进度与切换

每个服务器任务独立加锁。上一轮仍在运行时会跳过重叠触发。三个每日任务成功后在 `.cron/` 记录北京时间日期，同日再次触发会跳过。失败会返回非零状态，修复后可用同一命令重试。频道转发按 `.telegram-email/*.sqlite` 中每个频道、每个接收端的进度补发。更新代码时保留 `.env`、`.cron/` 和 `.telegram-email/`。

从 GitHub 切到服务器时，先用 `--dry-run` 验证连接，再暂停对应的 cron-job.org 任务和 GitHub 工作流，等已启动的运行结束。首次迁移频道且希望接续原进度时，在启用服务器 cron **之前**，从最新状态分支导入数据库到空的状态目录：

```bash
cd /opt/notify-relay-bot
git fetch origin refs/heads/telegram-email-state && mkdir .telegram-email &&
  git archive FETCH_HEAD -- '*.sqlite' | tar -x -C .telegram-email
```

以上导入用于首次迁移且尚无本地数据库的服务器。跳过导入时，首次运行从频道当前最新帖建立进度。每日任务建议在当天尚未推送时交接，或从次日开始。回切频道到 GitHub 时，先停止服务器任务，并把最终的 SQLite 文件同步回 `telegram-email-state` 分支，再恢复 GitHub 调度。

## 本地运行

需要 Node.js ≥ 22.18。首次安装和修改源码后运行 `npm run build`，生成的 JavaScript 模块放在 `dist/`。GitHub Actions 在每次运行任务前通过 `npm test` 的 pretest 步骤编译。

```bash
npm install --include=dev
npm run build
npm run dry-run        # 只打印榜单，不推送
npm run stocks:dry-run # 只打印潜力股，不推送
npm run ai-news:dry-run # 只打印 AI 要闻，不推送
cp .env.example .env   # 填好变量后：
node --env-file=.env dist/github-trending/main.js
npm test
```

## 可调整

- 推送时间：改 cron-job.org 上的任务时间，兜底时间改对应工作流里的 cron（UTC 时间，北京时间减 8 小时）。
- 数量：加一个 `TOP_COUNT` 环境变量。
- 翻译：英文说明默认用 Google 翻译成中文（免 key，失败时保留原文；被限流时会返回 HTTP 429）。邮件里中文下方附原文。设 `TRANSLATE=false` 可关闭。

## AI 圈每日要闻

工作流 `.github/workflows/ai-news.yml` 每天 08:00 运行：

1. **抓取**过去 24 小时的内容（论文 48 小时）：
    - 官方博客：OpenAI、Google DeepMind、Google AI、Hugging Face
    - 媒体：TechCrunch AI、量子位
    - 社区：Hacker News 上 80 分以上的 AI 相关帖子
    - 论文：Hugging Face Daily Papers（带点赞数）

    Anthropic 官网没有 RSS、机器之心 RSS 已下线、Reddit 拒绝脚本访问，所以没有收录。某个源挂了只会跳过它。

2. **合并打分**：同一事件被多个来源报道会合并（按链接和标题相似度），按来源权重 + HN 分数 / 论文点赞 + 报道家数打分。
3. **AI 挑选和总结**：把前 40 个事件交给 AI，选出最重要的 10 条，写中文标题、一句话摘要和「为什么值得关注」，并分为模型/产品发布、行业/公司动态、论文、开源/工具、社区热议。
    - 配了 `ANTHROPIC_API_KEY` 先用 Claude，配了 `OPENAI_API_KEY` 用 ChatGPT；两个都配时一个失败会自动换另一个。
    - 都没配或都失败时退回**规则排序**：按分数取前 10（每类最多 4 条），标题和简介用 Google 翻译成中文，没有点评。

可选的 Actions **Variables**（Settings → Secrets and variables → Actions → Variables）：

| Variable          | 说明                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`     | 设为 `openai` 则优先用 ChatGPT，默认优先 Claude                                                                                                      |
| `ANTHROPIC_MODEL` | 默认 `claude-sonnet-5-5`                                                                                                                             |
| `OPENAI_MODEL`    | 默认 `gpt-5-mini`                                                                                                                                    |
| `OPENAI_BASE_URL` | 默认 `https://api.openai.com/v1`。填其他兼容 OpenAI 接口的服务地址（如 DeepSeek、通义千问）也能用，`OPENAI_API_KEY` 和 `OPENAI_MODEL` 换成对应服务的 |

数量用 `NEWS_COUNT` 调整，默认 10。

## 每日潜力股

工作流 `.github/workflows/stocks.yml` 每个工作日运行，先判断今天是不是交易日（周末和法定节假日跳过，节假日数据来自 [holiday-cn](https://github.com/NateScarlet/holiday-cn)），再请求行情、逐级筛选，等到 09:20 推送。使用的是实时行情接口，盘前可能保留上一交易日数据，也可能已经清零部分字段，因此推送标注实际行情日期，不能一概视为完整的昨日收盘数据。为避免集合竞价后数据混用，正式任务仍须在 09:15 前启动；晚于该时间会发送状态提醒，说明未生成股票名单。

由 cron-job.org 在 09:00 准点触发（见上方「准点触发」），Actions 定时任务 09:10 兜底。

**数据**：取实时接口中主力资金净流入排名靠前的约 200 只 A 股（沪深主板、创业板、科创板、北交所），都是免 key 的公开接口，按顺序尝试：

1. 东方财富：数据最全，含行业板块资金流向。但它经常拒绝海外 IP，GitHub Actions 上大概率连不上（日志里会看到 `东方财富: fetch failed (UND_ERR_SOCKET)` 之类的警告）。
2. 新浪财经（主力资金排名）+ 腾讯行情（量比、市盈率、市值、5/60 日涨幅）：海外可访问。没有行业数据，所以这时不会有「所属行业」理由，也不限同行业数量。

推送里会写明本次用的是哪个数据源。

**逐级筛选**：严格档不足推送数量（默认 10 只）时，按下表依次补充；严格档优先，同档按量化得分排序，只放宽到够用为止，不为凑满 30 只 AI 候选而继续降低标准。

| 条件            | 严格筛选               | 放宽筛选               | 观察候选                                     |
| --------------- | ---------------------- | ---------------------- | -------------------------------------------- |
| 股价 / 总市值   | ≥ 3 元 / ≥ 50 亿       | ≥ 2 元 / ≥ 20 亿       | ≥ 1 元 / ≥ 10 亿                             |
| 成交额          | ≥ 3 亿                 | ≥ 1 亿                 | 允许不足或盘前清零、缺失，标明量能无法验证   |
| 主力资金        | 净流入 > 0，净占比完整 | 净流入 > 0，净占比完整 | 允许清零、缺失或净流出，标明无法验证或净流出 |
| 涨跌幅          | > 0 且 < 9.5%          | > -3% 且 < 9.5%        | > -5% 且 < 9.5%                              |
| 近 5 日涨幅     | ≤ 25%                  | ≤ 35%                  | ≤ 40%                                        |
| 市盈率          | > 0 且 ≤ 200           | > 0 且 ≤ 300           | > 0 且 ≤ 300                                 |
| 量比 / 换手率等 | 必须完整               | 必须完整               | 允许缺失，缺失项不加分                       |

所有档位仍排除 ST / 退市股、已知上市不满 120 天的新股、N/C 新股，以及价格、市值、涨跌幅或市盈率等核心行情无效的股票；同一行业最多 2 只。未知上市日期仍按原规则结合名称判断，无法保证排除所有次新股。放宽档和观察档会逐只标注原因，观察候选不代表满足原来的资金与量价条件。

日志会记录每个数据源的行情日期、各档候选数量、关键字段缺失和清零数量。首个数据源即使返回非空列表，逐级放宽后仍无候选时也会继续尝试备用源；最终有几只就推送几只。所有数据源不可用或放宽后仍无候选时，会发送状态提醒并保留失败状态，便于重试，不再只有一条错误日志。

**打分**（满分约 100）：主力净流入占比、所属行业资金流入排名、量比、换手率、当日涨幅、中短期趋势、市盈率。同一行业最多 2 只，避免扎堆。

每只股票列出触发的推荐理由（带具体数字），如有超跌反弹、短线涨幅过大、估值偏高等情况会额外给出风险提示。

**AI 选股**（可选）：配了 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`（与 AI 要闻共用，切换规则也一样）后，选股分两步：

1. 量化规则按上面的过滤和打分初选 30 只（同一行业最多 2 只）。
2. 把这 30 只的行情数据、量化理由和行业资金流向交给 AI，由 AI 综合资金持续性、量价配合、行业景气、估值和过热风险，**精选 10 只并排序**。

推送里会多出 🤖 **AI 市场观察**（一段话总结当日盘面），每只股票下多一句 🤖 **AI 入选理由**，标题下注明「AI 从 30 只量化初选股中精选」。

AI 只能从这 30 只里选，返回其他代码会被丢弃；它被要求只依据给它的数据、不编造新闻、不给买卖建议或目标价。AI 少选了会用量化排名补齐；没配 key 或 AI 调用失败时，直接用量化得分前 10，推送里注明「按量化得分选出」。

可调整：`STOCK_COUNT`（数量，默认 10）、`STOCK_PUSH_TIME`（推送时间，默认 `09:20`）。筛选阈值和权重在 `src/stocks/screener.ts` 顶部。

> ⚠️ 这是基于公开行情数据的规则化量化筛选，**不构成投资建议**。它只看资金与量价，不了解公司基本面和消息面，历史表现不代表未来。

## 目录结构

```
src/
  tools/            各任务共用：推送渠道 (Telegram/邮件/飞书)、Claude/ChatGPT 调用、翻译、HTML 处理、北京时间、重试
  github-trending/  GitHub 今日涨星：抓取、翻译、排版、入口 main.ts
  ai-news/          AI 圈要闻：抓取、合并打分、AI 总结、排版、入口 main.ts
    sources/        RSS、Hacker News、HF Daily Papers
  telegram-relay/   Telegram 频道公开页读取、逐接收端进度和多渠道转发
  stocks/           每日潜力股：交易日历、筛选打分、排版、入口 main.ts
    sources/        行情数据源：东方财富、新浪 + 腾讯（备用）
test/               与 src 同结构
```

## 注意

- GitHub 定时任务不保证准点，高峰期可能延迟几个小时甚至被跳过（所以由 cron-job.org 准点触发，兜底任务也避开了整点）；另外仓库 **60 天没有任何提交** 会自动停用定时任务，到时去 Actions 页面重新启用即可。
- 如果 GitHub 改了 Trending 页面结构导致解析不到数据，任务会失败，GitHub 会发邮件通知你。
- 东方财富接口对同一 IP 的频繁请求会限流（直接断开连接），也常拒绝海外 IP，连不上时自动改用新浪 + 腾讯。本地调试时别连续狂跑。
