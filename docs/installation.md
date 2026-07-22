# 安装与复用指南

本指南面向从公开 GitHub 仓库全新克隆项目的 macOS 用户。WebUI 使用本机 Codex CLI 的既有 API / Responses Provider 配置，不要求 ChatGPT App 登录，也不会把 Codex 凭据复制到项目中。

## 1. 前置条件

- macOS，且当前用户已登录图形桌面会话。
- Node.js 22 或更高版本，以及 npm。
- 可以在终端执行 `codex`，并已完成 Codex API 配置。
- 远程访问时：安装并登录 Tailscale；仅本机使用时可暂不安装。
- Mac 保持开机、联网，并允许用户登录后运行 LaunchAgent。

## 2. 全新安装

```bash
git clone https://github.com/Yuke-learning/codex-webui.git
cd codex-webui
npm ci
npm test
npm run service:install
```

安装器会动态检测当前用户、仓库路径、稳定 Node.js 路径、Codex CLI 和可选的 Tailscale CLI，不包含 `/Users/...` 等固定用户路径。它会生成：

```text
~/Library/LaunchAgents/io.github.yuke-learning.codex-webui.plist
```

WebUI 默认只监听 `127.0.0.1:8787`。安装 Tailscale 后，服务会持续检查连接，并在不存在其他 Serve 配置时建立私网 HTTPS 入口。访问地址会显示在 WebUI 左上角，也可以通过以下命令检查：

```bash
tailscale serve status
```

## 3. 管理常驻服务

```bash
npm run service:status
npm run service:restart
npm run service:uninstall
```

更新代码后执行：

```bash
git pull --ff-only
npm ci
npm test
npm run service:install
```

重新安装会更新 LaunchAgent 中记录的仓库及运行时路径，并自动迁移旧版本使用的 `com.yuke.codex-webui` 标签。

## 4. 自定义二进制或端口

自动检测失败时，可以在安装命令中显式指定绝对路径：

```bash
CODEX_BIN=/absolute/path/to/codex \
TAILSCALE_BIN=/absolute/path/to/tailscale \
PORT=8787 \
npm run service:install
```

同时使用 CC Switch 时，可以指定 CLI 适配器和模式：

```bash
CC_SWITCH_BIN=/absolute/path/to/cc-switch \
CC_SWITCH_MODE=auto \
npm run service:install
```

`CC_SWITCH_MODE` 支持：

- `auto`：调用 `cc-switch --app codex proxy show` 自动判断。
- `proxy`：按代理接管模式处理，服务商切换从下一轮请求生效，不重启 Gateway。
- `config`：按普通配置模式处理，等待当前任务结束后重连 Codex。

如果使用独立的 CC Switch 配置目录，可以同时传入绝对路径形式的 `CC_SWITCH_CONFIG_DIR`。LaunchAgent 只记录这些路径和模式，不记录 API Key。

未安装 CLI 时，WebUI 的全局服务商弹层会提供“安装便携组件”。组件安装在仓库的 `.runtime/cc-switch/<平台>/` 中，目录已被 Git 忽略；安装器只允许固定 GitHub Release，下载后验证 SHA-256 和二进制版本。该功能使用 [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) 作为 CC Switch 的命令行适配器，而不是把服务商凭据复制到 WebUI。

这些值只记录二进制路径和端口。不要把 API key、Bearer token 或其他凭据作为安装参数或写入仓库。

## 5. 常见问题

### 域名返回 502

先检查：

```bash
npm run service:status
curl http://127.0.0.1:8787/api/health
tailscale serve status
```

`502` 通常表示 Tailscale Serve 在线，但本机 WebUI 没有监听对应端口。重新执行 `npm run service:install`，然后检查被 Git 忽略的 `logs/launchd.stderr.log`。

### 已有其他 Tailscale Serve 服务

WebUI 不会覆盖已有 Serve 配置。需要先决定如何合并路由，或为 WebUI 使用另一台 Tailscale 设备；不要盲目重置现有配置。

### Node.js、Codex 或仓库被移动

LaunchAgent 使用安装时解析到的绝对路径。移动或升级运行时、移动仓库后，重新运行 `npm run service:install`。

## 6. 安全边界

- 不使用 `HOST=0.0.0.0` 暴露 WebUI。
- 不启用 Tailscale Funnel。
- 只有同一 Tailnet 中获得授权的设备才能访问 Serve 域名。
- `.env`、日志、Codex 配置、线程数据和凭据均不得提交到 Git。
- `.runtime/` 中的便携二进制不得提交到 Git；升级必须先更新固定版本清单和对应 SHA-256，再运行完整测试。
- 浏览器不会读取 `~/.cc-switch/cc-switch.db`、`~/.codex/auth.json` 或 `~/.codex/config.toml`。所有切换均由本机服务端以固定参数调用 CLI。
