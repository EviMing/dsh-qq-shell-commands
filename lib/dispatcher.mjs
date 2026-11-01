/**
 * 收到 QQ 消息后的全部判断与执行逻辑。
 *
 * 消息格式（协议）：
 *   执行Shell命令：
 *   回声
 * 即：文本必须以配置里的 prefix（默认「执行Shell命令：」+ 换行）开头，
 * 换行之后的**全部内容**才是暗号；暗号与 commands 的键完全相等才执行。
 *
 * 管理员还可以发私信增改命令：
 *   增加 Shell 命令：{"文本": ["命令", "Shell"]}
 * 只有 adminSenders 里的 QQ 能这么做，且同样要求私聊。
 *
 * 单独抽出来是为了能在不启动 DSH、不连 QQ 的情况下做集成测试（注入假的配置、
 * 假的通知器和真的 runShellCommand）。
 *
 * 安全边界：
 *   - self_id 必须等于配置里的 selfQQ（防止 NapCat 登错号时执行命令）
 *   - 没带前缀的消息一律静默忽略（群里闲聊不会误触发）
 *   - 默认只允许 ownerQQ 私聊；群消息必须 allowGroup=true 且发送者在白名单
 *   - 暗号必须与 commands 的键完全相等（不做 trim、不做模糊匹配）
 *   - 命令以 DSH 宿主机当前用户的权限运行，不经过 DSH 沙箱——配置文件的写权限
 *     就是执行权限，不要随便把 allowedSenders 放给不信任的人
 */
import { hostname } from 'node:os';
import { extractFromTemplate } from './config.mjs';
import { extractText, senderOf } from './message.mjs';
import { resolveShell, runShellCommand } from './shell.mjs';

const SELF_WARN_INTERVAL_MS = 60000;

export class AddCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AddCommandError';
  }
}

/** 管理命令模板默认值；实际以配置里的 formats.add 为准。 */
const ADD_MAX_ENTRIES = 20;
const ADD_MAX_TEXT = 100;
const ADD_MAX_COMMAND = 4000;

/**
 * 解析「增加 Shell 命令：{JSON}」。不是这个格式返回 null；格式错误抛
 * AddCommandError（错误消息会原样私信给管理员）。
 *
 * @param {string} jsonText 管理消息里取出的 JSON 文本
 * @returns {Array<{key: string, command: string, shell: string}>}
 */
export function parseAddCommand(jsonText) {
  const text = String(jsonText ?? '').trim();
  if (!text) {
    throw new AddCommandError('管理消息后面要跟 JSON，例如 {"回声": ["echo 1", "cmd"]}');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new AddCommandError(`JSON 解析失败：${error.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new AddCommandError('JSON 根节点必须是对象，例如 {"回声": ["echo 1", "cmd"]}');
  }

  const entries = Object.entries(data);
  if (entries.length === 0) throw new AddCommandError('JSON 里至少要有一条命令');
  if (entries.length > ADD_MAX_ENTRIES) throw new AddCommandError(`一次最多添加 ${ADD_MAX_ENTRIES} 条命令`);

  const seen = new Set();
  const parsed = [];
  for (const [rawKey, value] of entries) {
    const key = rawKey.trim();
    if (!key) throw new AddCommandError('命令文本不能为空');
    if (key.length > ADD_MAX_TEXT) throw new AddCommandError(`命令文本太长（最多 ${ADD_MAX_TEXT} 字）：${key.slice(0, 20)}…`);
    if (seen.has(key)) throw new AddCommandError(`JSON 里命令文本重复：${key}`);
    seen.add(key);

    if (!Array.isArray(value) || value.length !== 2) {
      throw new AddCommandError(`「${key}」的值必须是 [命令, Shell] 两元素数组`);
    }
    const [command, shellName] = value;
    if (typeof command !== 'string' || !command.trim()) {
      throw new AddCommandError(`「${key}」的命令部分必须是非空字符串`);
    }
    if (command.length > ADD_MAX_COMMAND) {
      throw new AddCommandError(`「${key}」的命令太长（最多 ${ADD_MAX_COMMAND} 字符）`);
    }
    if (typeof shellName !== 'string' || !shellName.trim()) {
      throw new AddCommandError(`「${key}」的 Shell 部分必须是非空字符串（cmd、PowerShell、pwsh、bash、wsl）`);
    }
    try {
      resolveShell(shellName);
    } catch (error) {
      throw new AddCommandError(`「${key}」：${error.message}`);
    }
    parsed.push({ key, command: command.trim(), shell: shellName.trim() });
  }
  return parsed;
}

/** 通知里的暗号展示：压成一行，避免多行暗号把排版撑散。 */
function preview(text, max = 80) {
  const value = String(text ?? '');
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function clipMiddle(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const head = Math.max(0, Math.floor(max * 0.3));
  const tail = Math.max(0, max - head - 24);
  return `${value.slice(0, head)}\n…（省略 ${value.length - head - tail} 字）…\n${value.slice(-tail)}`;
}

function tailLines(text, limit) {
  if (!text) return '';
  if (limit <= 0) return '';
  const lines = text.split(/\r?\n/);
  if (lines.length <= limit) return text;
  return `…（前 ${lines.length - limit} 行省略）\n${lines.slice(-limit).join('\n')}`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} 毫秒`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

/**
 * 把执行结果排版成一条私信。
 * @param {{text: string, entry: {display: string}, result: any, config: any}} input
 */
export function formatResult({ text, entry, result, config }) {
  const label = preview(text);
  const lines = [];
  if (result.spawnError) {
    lines.push(`【命令启动失败】「${label}」`);
  } else if (result.timedOut) {
    lines.push(`【命令超时】「${label}」`);
  } else if (result.exitCode === 0) {
    lines.push(`【命令已执行】「${label}」`);
  } else {
    lines.push(`【命令失败】「${label}」`);
  }

  lines.push(`命令：${clipMiddle(entry.display, 1500)}`);

  const status = [];
  if (result.spawnError) {
    status.push(`启动错误：${result.spawnError}`);
  } else if (result.timedOut) {
    status.push(`已超过 ${formatDuration(config.shell.timeoutMs)}，进程树已终止`);
  } else {
    status.push(`退出码：${result.exitCode ?? '未知'}`);
  }
  status.push(`耗时：${formatDuration(result.durationMs)}`);
  lines.push(status.join('｜'));

  const output = [];
  if (result.stderr) output.push(`[stderr]\n${tailLines(result.stderr, config.notify.outputLines)}`);
  if (result.stdout) output.push(`[stdout]\n${tailLines(result.stdout, config.notify.outputLines)}`);
  if (output.length > 0) {
    lines.push('输出：');
    lines.push(output.join('\n'));
  } else {
    lines.push('输出：（空）');
  }

  return clipMiddle(lines.join('\n'), config.notify.maxChars);
}

export class CommandDispatcher {
  /**
   * @param {{
   *   getConfig: () => Promise<any>,
   *   notify: (config: any, text: string) => Promise<any>,
   *   notifyQQ?: (qq: string, text: string) => Promise<any>,
   *   saveCommand?: (text: string, command: string, shell: string) => Promise<{existed: boolean}>,
   *   log?: (level: string, message: string) => void,
   *   runCommand?: (options: any) => Promise<any>,
   * }} options
   */
  constructor({
    getConfig,
    notify,
    log = () => {},
    runCommand = runShellCommand,
    saveCommand = null,
    notifyQQ = null,
  }) {
    this.getConfig = getConfig;
    this.notify = notify;
    this.log = log;
    this.runCommand = runCommand;
    this.saveCommand = saveCommand;
    this.notifyQQ = notifyQQ;
    this.running = new Map();
    this.lastSelfWarningAt = 0;
    this.lastSelfWarningId = '';
  }

  async safeNotify(config, text) {
    try {
      await this.notify(config, text);
    } catch (error) {
      this.log('error', `私信通知失败：${error?.message ?? error}`);
    }
  }

  /** 回复给指定 QQ；没有 notifyQQ 时退回「通知主人」。 */
  async replyTo(config, qq, text) {
    try {
      if (typeof this.notifyQQ === 'function') await this.notifyQQ(String(qq), text);
      else await this.notify(config, text);
    } catch (error) {
      this.log('error', `私信回复 ${qq || '未知'} 失败：${error?.message ?? error}`);
    }
  }

  /**
   * 处理管理消息（默认「增加 Shell 命令：{JSON}」）。只接受私聊 + adminSenders 白名单。
   * 成功/失败都会私信回复请求者，但不影响正常命令执行。
   */
  async handleAddCommand(event, config, jsonPayload) {
    const senderId = senderOf(event);
    if (event.message_type !== 'private') {
      this.log('info', `忽略非私信的「增加 Shell 命令」请求：${senderId || '未知'}`);
      return;
    }
    if (!config.adminSenders.has(senderId)) {
      this.log('warn', `忽略未授权者 ${senderId || '未知'} 的「增加 Shell 命令」请求`);
      return;
    }

    try {
      const entries = parseAddCommand(jsonPayload);
      if (typeof this.saveCommand !== 'function') throw new AddCommandError('插件没有配置命令写入能力');

      const results = [];
      for (const entry of entries) {
        const result = await this.saveCommand(entry.key, entry.command, entry.shell);
        results.push({ ...entry, existed: result?.existed === true });
      }

      const blocks = results.map((entry) => [
        `${entry.existed ? '【命令已更新】' : '【命令已新增】'}「${entry.key}」`,
        `命令：${entry.command}`,
        `Shell：${entry.shell}`,
      ].join('\n'));
      blocks.push('之后发「执行Shell命令：」+ 换行 + 上面的文本即可执行。');
      await this.replyTo(config, senderId, blocks.join('\n\n'));
    } catch (error) {
      this.log('error', `增加命令失败：${error?.message ?? error}`);
      await this.replyTo(config, senderId, `【添加失败】${error?.message ?? error}`);
    }
  }

  /**
   * 处理一条 OneBot 消息事件。返回是否真的执行了命令（测试用）。
   * @param {any} event
   */
  async handle(event) {
    if (event === null || typeof event !== 'object' || event.post_type !== 'message') return false;

    let config;
    try {
      config = await this.getConfig();
    } catch (error) {
      this.log('error', `读取配置失败，忽略本条消息：${error?.message ?? error}`);
      return false;
    }

    const selfId = String(event.self_id ?? '');
    if (selfId !== config.selfQQ) {
      const now = Date.now();
      if (selfId !== this.lastSelfWarningId || now - this.lastSelfWarningAt > SELF_WARN_INTERVAL_MS) {
        this.lastSelfWarningAt = now;
        this.lastSelfWarningId = selfId;
        this.log('error', `收到 self_id=${selfId || '空'} 的消息，与配置 selfQQ=${config.selfQQ} 不一致，已忽略（检查 NapCat 登录的是哪个号）`);
      }
      return false;
    }

    const raw = extractText(event.message);
    if (!raw) return false;

    // 管理协议：按 formats.add 模板取出 JSON；禁用时跳过。
    const addPayload = config.formats?.add ? extractFromTemplate(raw, config.formats.add) : null;
    if (addPayload !== null) {
      await this.handleAddCommand(event, config, addPayload);
      return true;
    }

    // 执行协议：按 formats.execute 模板取出暗号，原样精确匹配。
    const text = extractFromTemplate(raw, config.formats?.execute);
    if (text === null) {
      if (config.debug) this.log('debug', `消息不符合执行格式，已忽略：${preview(raw)}`);
      return false;
    }
    if (!text) return false;

    const entry = config.commands.get(text);
    if (!entry) {
      if (config.debug) this.log('debug', `前缀后的文本未命中任何命令：${preview(text)}`);
      return false;
    }

    if (event.message_type === 'group' && !config.allowGroup) {
      this.log('info', `忽略群命令「${preview(text)}」：allowGroup=false`);
      return false;
    }

    const senderId = senderOf(event);
    if (!config.allowedSenders.has(senderId)) {
      this.log('warn', `忽略未授权发送者 ${senderId || '未知'} 的命令「${preview(text)}」`);
      return false;
    }

    const runningSince = this.running.get(text);
    if (runningSince !== undefined) {
      this.log('warn', `命令「${preview(text)}」仍在执行（已 ${Date.now() - runningSince} ms），忽略重复触发`);
      await this.safeNotify(config, `【命令进行中】「${preview(text)}」还在执行（已 ${formatDuration(Date.now() - runningSince)}），本次触发已忽略。`);
      return false;
    }

    this.running.set(text, Date.now());
    try {
      if (config.notify.start) {
        await this.safeNotify(
          config,
          `【开始执行】收到指令「${preview(text)}」\n主机：${hostname()}\n将执行：\n${clipMiddle(entry.display, 1500)}`,
        );
      }

      this.log('info', `开始执行「${preview(text)}」：${entry.display}`);
      const result = await this.runCommand({
        command: entry.command,
        shell: entry.shell,
        cwd: config.shell.cwd,
        timeoutMs: config.shell.timeoutMs,
      });

      this.log(
        result.timedOut ? 'warn' : (result.exitCode === 0 && !result.spawnError ? 'info' : 'warn'),
        `执行完成「${preview(text)}」：退出码 ${result.exitCode ?? '空'}，超时=${result.timedOut}，耗时 ${result.durationMs}ms`,
      );
      await this.safeNotify(config, formatResult({ text, entry, result, config }));
      return true;
    } catch (error) {
      this.log('error', `执行「${preview(text)}」出错：${error?.message ?? error}`);
      await this.safeNotify(config, `【命令失败】「${preview(text)}」\n命令：${entry.display}\n错误：${error?.message ?? error}`);
      return false;
    } finally {
      this.running.delete(text);
    }
  }
}
