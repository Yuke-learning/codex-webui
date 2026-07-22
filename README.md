# Codex 远程控制台

在手机或其他设备的浏览器中，安全地管理运行于 Mac 上的 Codex 本地对话与任务。

本项目不会使用 ChatGPT App 的账户或云端任务管理能力；所有 Codex 请求继续由 Mac 上现有的 API / Responses 配置发起，网页只作为安全的远程控制台。

设计方案见 [docs/remote-codex-console.md](docs/remote-codex-console.md)。

## 第一版运行方式

要求：Node.js 22+、已安装并登录的 Codex CLI。若要从其他设备访问，还需要在 Mac 与访问设备上安装 Tailscale，并登录同一个 tailnet。依赖只用于前端构建和测试，不会读取或复制你的 Codex 凭据。

```bash
# 首次运行或依赖更新后安装依赖
npm install

# 如果已通过 Codex installer 安装 standalone CLI：首次启用本地受控 daemon
codex app-server daemon bootstrap --remote-control

# 启动网页（默认仅监听 127.0.0.1:8787）
npm run dev
```

## macOS 常驻运行（推荐）

不要把 `npm run dev` 的临时终端当作远程访问所依赖的长期服务。安装用户级 LaunchAgent 后，WebUI 会在登录时自动启动，异常退出后由 `launchd` 自动拉起：

```bash
# 安装或更新配置，并立即启动
npm run service:install

# 查看 launchd 状态
npm run service:status

# 代码更新后重启；启动时会自动重新构建前端
npm run service:restart

# 不再需要常驻服务时卸载
npm run service:uninstall
```

安装过程不需要 `sudo`，不会复制 Codex 或 Tailscale 凭据。生成的配置位于 `~/Library/LaunchAgents/com.yuke.codex-webui.plist`；日志写入仓库中已被 Git 忽略的 `logs/` 目录，并使用仅当前用户可访问的权限。LaunchAgent 固定监听 `127.0.0.1:8787`，外部访问仍只经过 Tailscale Serve。

配置会记录安装时解析到的稳定 Node.js、Codex CLI 和 Tailscale 二进制路径。升级或移动这些运行时后，重新执行一次 `npm run service:install`。

安装器管理的 standalone CLI 可运行：

```bash
codex remote-control start --json
```

当前项目也兼容 npm / 桌面 App 所携带的 Codex CLI：若未发现受控 daemon，Gateway 会自动使用 `codex app-server --stdio` 直接连接本机 Codex。此模式无需安装器管理的 standalone 版本；它保留相同的 API / Responses 配置，但桌面 App 与网页对同一线程的实时同步仍应在你的版本上验证。

WebUI 始终默认只监听 `127.0.0.1:8787`。启动后，服务会立即检查 Tailscale，之后每 15 秒复查一次连接与 Serve 路由：

- 已存在指向 WebUI 的 Serve 路由时，直接复用并在左侧栏显示可访问地址。
- Serve 尚未配置时，自动执行等价于 `tailscale serve --bg --yes http://127.0.0.1:8787` 的安全配置。
- 已有其他 Serve 配置时，不会覆盖现有路由，而是在页面和服务日志中提示冲突。
- Tailscale 断开后会在页面提示；恢复连接时会自动重新检查并修复空的 Serve 配置。

因此，其他登录同一 tailnet 的手机、平板或电脑可以通过页面显示的 `https://<设备名>.<tailnet>.ts.net/` 地址访问。这里的“其他设备”指同一 Tailscale 私网内的设备；服务不会裸露给普通 Wi-Fi 局域网或公网。

可选环境变量：

```bash
# 默认 15000，最小 5000 毫秒
TAILSCALE_CHECK_INTERVAL_MS=15000 npm run dev

# 仅监控，不自动创建 Serve 路由
TAILSCALE_AUTO_SERVE=false npm run dev

# tailscale 不在 PATH 时指定二进制
TAILSCALE_BIN=/usr/local/bin/tailscale npm run dev
```

## 已实现

- 线程列表、搜索、详情与流式事件刷新。
- 左侧刷新按钮会立即遍历 `thread/list` 的全部分页，同步所有未归档对话；若当前打开了任务，还会强制刷新该任务的完整详情。同步期间按钮会显示忙碌状态并阻止重复点击，完成后提示总数。
- 左侧按 Git 项目分组对话，未关联项目的线程单独归类；项目节可随时折叠并保留本机浏览器偏好，即使其包含正在预览的对话。项目标题带、层级轨道、选中指示条和“非项目”虚线分组通过主题语义变量适配全部外观。左侧导航与主消息区独立滚动，顶部操作栏固定在消息区之外。
- 手机窄屏使用抽屉式对话导航：菜单打开项目列表，选择对话、新建对话、打开设置、触摸遮罩或按 Escape 均会关闭抽屉；消息区和输入框始终占用主屏。
- 对话记录按 app-server 的 `userMessage`、`agentMessage` 和命令执行项转换；连续的执行记录会自动汇总为默认收起的“执行过程”分组，显示命令、文件、浏览器、工具和进度计数。用户手动展开的分组会在实时刷新和切换对话后保留；内部 `heartbeat` 自动化信封不会混入主消息流，而会保留在默认收起的“自动化事件”审计区。
- Codex 助手消息中的 `git-stage`、`git-commit`、`git-push`、`git-create-branch` 与 `git-create-pr` UI 指令会转换为语义化 Git 操作卡片；用户消息、代码块、未知或格式错误的指令仍按原文展示。
- 用户与 Codex 消息支持 CommonMark 风格 Markdown、表格、链接、KaTeX 行内/块级公式和常见语言代码高亮；代码块、表格与公式在手机上可独立横向滚动。渲染前后均经过 DOMPurify 清理，禁用远程图片和可执行 HTML，所有依赖与字体均打包到本地，不加载第三方 CDN。
- 新建线程、发送消息/追加指令、停止、改名、归档和带确认的删除。
- 从 app-server 动态读取可用模型与推理强度；详情页显示线程的实际设置，并可将新的模型/强度应用于后续 turn。
- SSE 事件按影响范围处理：目标和 token 使用量等未展示事件不会触发重绘；仅当前线程完成、压缩或设置变更才刷新详情。
- Tailscale 连接与 Serve 入口持续监控；状态变化通过 SSE 实时同步到页面，健康接口只返回本机连接和当前 WebUI 入口，不暴露 tailnet 中的其他设备列表。
- 提供 macOS 用户级 `launchd` 常驻部署：登录启动、异常自动恢复、直接使用稳定 Node 入口，并避免依赖 Codex 临时终端生命周期。
- 优先 `codex app-server proxy`、自动回退到直接 `codex app-server --stdio` 的 JSON-RPC adapter，支持 JSONL 与 `Content-Length` 帧。
- loopback 默认监听、同源写请求检查、请求大小限制、内容安全策略（CSP）与安全的 `.gitignore`。

第一版会显示 Codex 的审批请求，但不支持网页端批准；请暂时在桌面 App 审阅，避免远程网页意外批准高风险操作。
