# Codex 远程控制台

在手机或其他设备的浏览器中，安全地管理运行于 Mac 上的 Codex 本地对话与任务。

本项目不会使用 ChatGPT App 的账户或云端任务管理能力；所有 Codex 请求继续由 Mac 上现有的 API / Responses 配置发起，网页只作为安全的远程控制台。

设计方案见 [docs/remote-codex-console.md](docs/remote-codex-console.md)。

## 第一版运行方式

要求：Node.js 22+、已安装并登录的 Codex CLI。第一版不依赖 `npm install`，也不会读取或复制你的 Codex 凭据。

```bash
# 如果已通过 Codex installer 安装 standalone CLI：首次启用本地受控 daemon
codex app-server daemon bootstrap --remote-control

# 启动网页（默认仅监听 127.0.0.1:8787）
npm run dev
```

安装器管理的 standalone CLI 可运行：

```bash
codex remote-control start --json
```

当前项目也兼容 npm / 桌面 App 所携带的 Codex CLI：若未发现受控 daemon，Gateway 会自动使用 `codex app-server --stdio` 直接连接本机 Codex。此模式无需安装器管理的 standalone 版本；它保留相同的 API / Responses 配置，但桌面 App 与网页对同一线程的实时同步仍应在你的版本上验证。

远程访问必须通过有身份验证的私网入口（推荐 Tailscale Serve）转发到 `127.0.0.1:8787`；不要将此服务直接映射到公网。

## 已实现

- 线程列表、搜索、详情与流式事件刷新。
- 左侧按 Git 项目分组对话，未关联项目的线程单独归类；项目节可折叠并保留本机浏览器偏好。左侧导航与主消息区独立滚动，顶部操作栏固定在消息区之外。
- 对话记录按 app-server 的 `userMessage`、`agentMessage` 和命令执行项转换；内部 `heartbeat` 自动化信封不会混入主消息流，而会保留在默认收起的“自动化事件”审计区。
- 新建线程、发送消息/追加指令、停止、改名、归档和带确认的删除。
- 从 app-server 动态读取可用模型与推理强度；详情页显示线程的实际设置，并可将新的模型/强度应用于后续 turn。
- SSE 事件按影响范围处理：目标和 token 使用量等未展示事件不会触发重绘；仅当前线程完成、压缩或设置变更才刷新详情。
- 优先 `codex app-server proxy`、自动回退到直接 `codex app-server --stdio` 的 JSON-RPC adapter，支持 JSONL 与 `Content-Length` 帧。
- loopback 默认监听、同源写请求检查、请求大小限制与安全的 `.gitignore`。

第一版会显示 Codex 的审批请求，但不支持网页端批准；请暂时在桌面 App 审阅，避免远程网页意外批准高风险操作。
