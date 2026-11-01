# dsh-qq-shell-commands

> 在 QQ 里发一句暗号，让 DSH 所在电脑执行对应的 Shell 命令，并把执行结果私信回主人。

这是一个 **DSH Host 插件**。它的目的不是让 DSH 去执行命令，而是让命令运行在 **DSH 宿主机当前用户** 的权限下；QQ 只是触发器。适合需要重复工作、托管行为，但不想把 DSH 的执行权限直接交出去的情况。

底层通过 **NapCat** 与 QQ 交互：插件连接 NapCat 的 OneBot 11 WebSocket，收到私聊后按配置精确匹配文本，命中才执行对应 Shell 命令；发私信复用前置插件 [`EviMing/dsh-napcat-tools`](https://github.com/EviMing/dsh-napcat-tools) 的 `napcat_api`。

> ⚠️ 这是远程命令执行（RCE）能力。默认只接受主人的私聊；请先读完「安全说明」再部署。

## 工作流

```text
QQ 私信「执行Shell命令：」+ 换行 +「任务完成」
  → 取出暗号「任务完成」
  → 与配置 commands 的键做完全相等比较（不 trim、不模糊匹配）
  → 命中 {"任务完成": ["New-BurntToastNotification ...", "PowerShell"]}
  → 在宿主机执行 PowerShell New-BurntToastNotification ...
  → 私信主人：开始执行 / 已执行（退出码、耗时、输出）
```

## 前置条件

1. **DSH** 已安装并可启动 Web GUI 或 headless profile。
2. **前置插件 `EviMing/dsh-napcat-tools`** 已安装并启用。它提供：
   - `lib/runner.mjs` 的 `runCli`（本插件用来发私信）
   - 本地 Python 包 `napcat_api`（负责调用 NapCat HTTP API）
3. **NapCat 已登录机器人 QQ**，并开启：
   - OneBot 11 **WebSocket** 服务（默认 `ws://127.0.0.1:3001`）
   - HTTP 服务（默认 `http://127.0.0.1:3000`，`napcat-tools` 发消息用）
4. Python 3.10+ 可执行 `python -m napcat_api`（通常在 `dsh-napcat-tools` 的上一级目录）。

## 安装

### 从 DSH 插件市场安装（推荐）

本仓库带有 `dsh-plugin` topic，会被 [DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 索引。在 DSH 设置页的插件市场里搜索 **QQ Shell 命令** 即可安装。

### 从 GitHub 安装

```bash
# 先装前置插件
dsh plugin --profile web add github:EviMing/dsh-napcat-tools

# 再装本插件
dsh plugin --profile web add github:EviMing/dsh-qq-shell-commands
```

安装后重启 DSH（Host 插件代码在启动时加载）。然后在插件配置里把 `prereqDir` 指向前置插件目录，例如：

```yaml
- insert:
    - id: qq-shell-commands
      name: dsh-qq-shell-commands
      config:
        configFile: ''
        prereqDir: 'C:\Users\you\.dsh\profiles\web\node_modules\@local\napcat-tools'
```

`prereqDir` 必须是一个包含 `package.json` 与 `lib/runner.mjs` 的目录，且 `package.json` 的 `name` 为 `@local/napcat-tools`。

### 本地开发

```bash
git clone https://github.com/EviMing/dsh-qq-shell-commands
cd dsh-qq-shell-commands
node test/selftest.mjs
```

把目录链接进 profile（Windows 可用 junction），或打包后交给 `plugin_manager` 安装。

## 配置

默认配置文件：`%DSH_HOME%\qq-shell-commands.json`（Windows 通常是 `C:\Users\<you>\.dsh\qq-shell-commands.json`）。`config.example.json` 是一份可复制的模板。

配置文件在插件包外，重装/升级插件不会丢。

```json
{
  "selfQQ": 123456789,
  "ownerQQ": 987654321,
  "formats": {
    "execute": "执行Shell命令：\n",
    "add": "增加 Shell 命令："
  },
  "commands": {
    "回声": ["echo 1", "cmd"],
    "时间": ["Get-Date -Format 'yyyy-MM-dd HH:mm:ss'", "PowerShell"]
  },
  "allowedSenders": [987654321],
  "adminSenders": [987654321],
  "allowGroup": false,
  "napcat": {
    "ws": "ws://127.0.0.1:3001",
    "token": "你的 NapCat access_token",
    "cwd": "",
    "python": "",
    "pythonPath": "",
    "timeoutMs": 30000
  },
  "shell": {
    "cwd": "",
    "timeoutMs": 600000
  },
  "notify": {
    "start": true,
    "outputLines": 20,
    "maxChars": 1800
  },
  "debug": false
}
```

| 字段 | 说明 |
| --- | --- |
| `selfQQ` | 机器人自己的 QQ。每条事件的 `self_id` 必须等于它，否则插件停摆（防止 NapCat 登错号）。 |
| `ownerQQ` | 主人 QQ，执行通知都私信到这里；也是默认唯一允许的发送者。 |
| `formats.execute` | 执行格式，默认 `"执行Shell命令：\n"`。也可写 `{text}` 模板，如 `"执行【{text}】"`；设为 `""` 表示不要求前缀。 |
| `formats.add` | 新增命令格式，默认 `"增加 Shell 命令："`；支持 `{json}` 模板；设为 `""`/`null` 关闭该功能。 |
| `commands` | 必须是 `{"文本": ["Shell 命令", "Shell 名称"]}`；文本键加载时去掉首尾空白，匹配时要求剩余正文与键**完全相等**。 |
| `allowedSenders` | 额外允许的 QQ 号；主人永远在列表里。默认只有主人。 |
| `adminSenders` | 允许通过 QQ 私信增改命令的 QQ 号；主人永远在列表里。 |
| `allowGroup` | 是否接受群消息，默认 `false`；开启后仍只认白名单发送者。 |
| `napcat.ws` | NapCat OneBot 11 WebSocket 地址；token 写在 `napcat.token`。 |
| `napcat.cwd` | `napcat_api` 包所在目录；留空则取 `prereqDir` 的上一级。 |
| `shell.cwd` | 命令工作目录；留空则用当前用户主目录。 |
| `shell.timeoutMs` | 单条命令超时，默认 600000（10 分钟）；超时会杀掉整棵进程树。 |
| `notify.start` | 执行前是否先发「开始执行」。 |
| `notify.outputLines` | 通知里 stdout/stderr 各保留末尾多少行。 |
| `notify.maxChars` | 单条私信最大长度，超出按头尾截断。 |

### 支持的 Shell

| 写法 | 实际执行 |
| --- | --- |
| `cmd` / `command` | `cmd.exe /d /s /c "<命令>"` |
| `PowerShell` / `ps` | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <命令>` |
| `pwsh` | `pwsh.exe` 同上 |
| `bash` / `sh` | `bash.exe -lc <命令>` |
| `wsl` | `wsl.exe bash -lc <命令>` |

命令必须是非交互的：stdin 是空的，需要输入的命令会一直等到超时。

### 通过 QQ 增加命令

`adminSenders` 里的 QQ 可以私聊机器人发送（默认格式）：

```text
增加 Shell 命令：{"备份": ["Copy-Item 'D:\\data' 'E:\\backup' -Recurse -Force", "PowerShell"]}
```

- 只接受私聊；群消息里的管理命令忽略。
- 只接受 `adminSenders` 白名单；非白名单不会写入，也不会回复。
- 值必须是 `[命令, Shell]` 两元素数组；一次可加多条，已存在的文本会覆盖。
- 写入成功后立即生效，无需重启 DSH。
- 解析失败、Shell 不支持、写入失败都会私信 `【添加失败】原因`。

## 使用

用主人的 QQ 私聊机器人：

```text
执行Shell命令：
回声
```

手机会收到：

```text
【开始执行】收到指令「回声」
主机：DESKTOP-XXX
将执行：
cmd echo 1
```

```text
【命令已执行】「回声」
命令：cmd echo 1
退出码：0｜耗时：0.3 秒
输出：
1
```

失败/超时会分别显示 `【命令失败】` / `【命令超时】`，并带上退出码与输出末尾若干行。

## 安全说明

- 命令以 **DSH 宿主机当前用户** 的权限运行，不经过 DSH 沙箱。
- 配置文件的写权限等价于命令执行权限；`adminSenders` 等价于拿到命令表写权限。只放完全信任的人。
- 默认只接受 `ownerQQ` 的私聊；陌生人、未授权群成员发来的暗号不会执行，也不会收到回复（避免暴露暗号）。
- 每条消息都校验 `self_id === selfQQ`；NapCat 登录了别的号时插件直接停摆，不会用错号执行。
- `commands` 的键是明文暗号；不要把密码、token 之类写进命令或通知内容。
- 不要把 DSH Web 端口或 NapCat HTTP/WS 暴露到不可信网络。

## 自测

```bash
node test/selftest.mjs     # 单元/集成断言，不需要 DSH
node test/boot-check.mjs   # 用假 ctx 装配插件（需要真实配置与 NapCat）
node test/live-ws.mjs      # 只验证配置 + WebSocket 连接，不执行命令
```

在 DSH workspace-write 沙箱里 `spawn` 子进程可能返回 `EPERM`，这是沙箱限制，不是插件问题。

## 目录

```text
index.js             插件入口：配置 → 前置插件 → WebSocket → dispatcher
lib/config.mjs       配置读取、校验、原子写回
lib/ws.mjs           OneBot 11 WebSocket、自动重连、self_id 校验
lib/dispatcher.mjs   精确匹配、权限、并发保护、执行、私信排版
lib/shell.mjs        cmd / PowerShell / pwsh / bash / wsl 的 argv 与超时杀进程
lib/napcat.mjs       动态加载 napcat-tools 的 runCli 发私信
config.example.json  配置模板
locale/zh.json       插件市场中文标题/备注
locale/en.json       插件市场英文标题/备注
```

## License

MIT
