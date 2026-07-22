# CC Switch 全局服务商切换

WebUI 通过本机服务端适配器调用 `cc-switch-cli`，不会让浏览器直接访问 CC Switch 数据库、Codex 配置或 API 凭据。服务商是 Mac 上 Codex 的全局状态，不是单个任务设置；当前正在执行的轮次不会被中途改道。

## 数据流

```text
浏览器全局服务商按钮
        ↓ 同源 JSON API
ProviderManager
        ↓ 固定参数、无 shell
CcSwitchAdapter
        ↓
cc-switch --app codex provider ...
        ↓
CC Switch ProviderService / 本地代理
```

浏览器只接收：

- 服务商 ID、名称、是否当前启用。
- CLI 是否可用、兼容版本和来源类型。
- `proxy` / `config` 模式、是否需要 Gateway 重连。
- 切换的排队、开始、完成或失败状态。

浏览器不会接收 API Key、Bearer Token、完整 Base URL、数据库路径或 CLI 原始输出。

## 四阶段实现

### 1. 只读检测

- 搜索顺序：`CC_SWITCH_BIN`、`.runtime` 便携组件、`PATH`、常见 macOS 安装目录。
- 先执行 `--version`，不兼容时不会继续打开 provider 数据。
- 当前兼容线为 `5.9.2` 及同一主版本内的更新版本。
- 支持当前终端表格输出和未来 JSON 输出；API URL 列在服务端解析后立即丢弃。

### 2. 代理安全切换

- `auto` 模式通过 `cc-switch --app codex proxy show` 判断 Codex 是否处于代理接管状态。
- 活动轮次存在时只记录一个待切换目标，当前轮次结束后执行。
- 全局互斥避免两个切换事务同时修改状态；幂等请求标识避免手机重复点击。
- 切换后再次读取当前 provider，只有 CLI 确认目标已启用才报告成功。

### 3. 配置切换与回滚

- 普通配置模式同样等待所有活动轮次结束。
- 切换成功后关闭并重新建立 Codex app-server 连接，再读取模型列表。
- 当前任务模型不在新列表时，页面提示用户重新选择，不静默伪造兼容性。
- 切换、确认或 Gateway 重连失败时，调用相同 CLI 流程恢复原服务商；配置模式随后再次重连 Gateway。

### 4. 便携组件与移动端

- 页面可以安装固定的 `cc-switch-cli` Release，当前清单版本为 `5.9.2`。
- Release URL、资产名、字节大小和 SHA-256 固定在源码清单中。
- 下载上限为 32 MiB；解压前拒绝绝对路径和 `..` 路径穿越。
- 临时文件使用私有目录，最终二进制权限为 `0700`，通过原子重命名安装。
- 桌面端使用弹层，手机端使用贴底抽屉；全局入口在未选择任务时仍然可见，主要触控按钮不小于 44px。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/providers` | 脱敏后的服务商列表和状态 |
| `GET` | `/api/providers/status` | 完整的脱敏适配器状态 |
| `POST` | `/api/providers/:id/activate` | 立即切换或排队到下一轮 |
| `POST` | `/api/providers/portable/install` | 下载、校验并安装固定便携组件 |

切换状态通过 `/api/events` 的 `provider-switch` SSE 事件推送，阶段包括 `queued`、`started`、`completed`、`failed` 和 `portable-installed`。

## 安全边界

- 子进程使用 `spawn(binary, args)`，`shell: false`；provider ID 作为单独参数且必须通过格式校验。
- 写请求执行同源检查，JSON 请求体限制为 128 KiB。
- CLI stdout/stderr 不写入浏览器响应；服务端错误日志只记录脱敏后的错误名称、代码和公开消息。
- `.runtime/`、`.cc-switch/`、`.codex/`、`.env`、日志和认证文件均被排除或禁止提交。
- 不使用 `ccswitch://` Deep Link，也不把密钥放进 URL、localStorage 或 SSE。

## 运维检查

```bash
# 检查 CLI
cc-switch --version
cc-switch --app codex provider list
cc-switch --app codex proxy show

# WebUI 状态
curl http://127.0.0.1:8787/api/providers/status

# 完整验证
npm test
```

如果桌面 CC Switch 与 CLI 报告数据库版本不兼容，WebUI 会停止切换并显示兼容性错误；不要手工编辑 `~/.cc-switch/cc-switch.db`。可以升级适配器，或通过 `CC_SWITCH_CONFIG_DIR` 使用经过验证的独立配置根目录。
