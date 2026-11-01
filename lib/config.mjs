/**
 * 读取并校验 %DSH_HOME%\qq-shell-commands.json。
 *
 * 这个文件属于「本机」而不是插件包：QQ 号、NapCat token、以及每条文本对应
 * 的命令都只在这台机器上有意义。插件包可以重装，配置不会丢。
 *
 * 校验尽量早、尽量严：配置错误时宁可不启动，也不要带着错误的 selfQQ/ownerQQ
 * 去收消息或发私信。
 */
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveShell } from './shell.mjs';

const QQ_PATTERN = /^\d{5,12}$/;
const DEFAULT_WS = 'ws://127.0.0.1:3001';
const SHELL_LIST = 'cmd、PowerShell、pwsh、bash、wsl';
/** 默认触发前缀：QQ 文本必须以它开头，换行之后的内容才是暗号。 */
const DEFAULT_PREFIX = '执行Shell命令：\n';
const DEFAULT_ADD_FORMAT = '增加 Shell 命令：';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 配置文件的绝对路径：插件配置 > 环境变量 > %DSH_HOME% > ~/.dsh。 */
export function resolveConfigPath(explicit) {
  const fromPlugin = typeof explicit === 'string' ? explicit.trim() : '';
  if (fromPlugin) return fromPlugin;
  const fromEnv = typeof process.env.DSH_QQ_SHELL_CONFIG === 'string'
    ? process.env.DSH_QQ_SHELL_CONFIG.trim()
    : '';
  if (fromEnv) return fromEnv;
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(dshHome, 'qq-shell-commands.json');
}

function normalizeQQ(value, field) {
  const text = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : (typeof value === 'string' ? value.trim() : '');
  if (!QQ_PATTERN.test(text)) {
    throw new ConfigError(`${field} 必须是 5–12 位 QQ 号，当前为 ${JSON.stringify(value)}`);
  }
  return text;
}

function normalizeWsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigError(`napcat.ws 必须是非空字符串，例如 ${DEFAULT_WS}`);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConfigError(`napcat.ws 不是合法 URL：${value}`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ConfigError(`napcat.ws 必须是 ws:// 或 wss:// 地址，当前为 ${value}`);
  }
  if (url.search || url.hash) {
    throw new ConfigError('napcat.ws 不要带查询参数或片段；token 请写在 napcat.token');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function asInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * 触发前缀：默认「执行Shell命令：」+ 换行；空字符串表示不要求前缀（兼容旧用法）。
 */
function normalizePrefix(value) {
  if (value === undefined) return DEFAULT_PREFIX;
  if (typeof value !== 'string') {
    throw new ConfigError('prefix 必须是字符串，例如 "执行Shell命令：\\n"');
  }
  if (value === '') return '';
  const normalized = value.replace(/\r\n/g, '\n');
  if (!normalized.endsWith('\n')) {
    throw new ConfigError('prefix 必须以换行结尾，例如 "执行Shell命令：\\n"；设为空字符串表示不要求前缀');
  }
  return normalized;
}

function newlineVariants(value) {
  if (!value.includes('\n')) return [value];
  return [...new Set([value, value.replace(/\n/g, '\r\n')])];
}

/**
 * 编译消息格式模板（执行/新增命令都走这里）。
 *
 * - 不含 {text} / {json}：整串当作前缀，正文接在后面（兼容旧 prefix）；
 * - 含占位符：before + 占位符 + after，after 可以为空；
 * - 空字符串：调用方传 allowEmpty 时允许，execute 表示不要求前缀，
 *   add 由调用方转成 null 表示禁用。
 *
 * @param {string} template
 * @param {'text'|'json'} placeholder
 * @param {string} field 错误提示里的字段名
 */
export function compileTemplate(template, placeholder, field, { allowEmpty = false, requireAnchor = false } = {}) {
  if (typeof template !== 'string') {
    throw new ConfigError(`${field} 必须是字符串`);
  }
  if (template === '') {
    if (!allowEmpty) throw new ConfigError(`${field} 不能为空`);
    return {
      template,
      placeholder,
      hasPlaceholder: false,
      before: '',
      after: '',
      beforeVariants: [''],
      afterVariants: [],
    };
  }

  const token = `{${placeholder}}`;
  const parts = template.split(token);
  if (parts.length > 2) throw new ConfigError(`${field} 里最多只能有一个 ${token}`);
  const hasPlaceholder = parts.length === 2;
  const before = parts[0];
  const after = hasPlaceholder ? parts[1] : '';
  if (requireAnchor && before === '' && after === '') {
    throw new ConfigError(`${field} 至少要有一段固定文本，不能只有 ${token}`);
  }

  return {
    template,
    placeholder,
    hasPlaceholder,
    before,
    after,
    beforeVariants: newlineVariants(before),
    afterVariants: hasPlaceholder ? newlineVariants(after) : [],
  };
}

/** 按编译后的模板从消息里取出正文；格式不匹配返回 null。 */
export function extractFromTemplate(raw, compiled) {
  if (!compiled) return null;
  const head = compiled.beforeVariants.find((variant) => raw.startsWith(variant));
  if (head === undefined) return null;
  const rest = raw.slice(head.length);
  if (!compiled.hasPlaceholder || compiled.after === '') return rest;
  const tail = compiled.afterVariants.find((variant) => rest.endsWith(variant));
  if (tail === undefined) return null;
  return rest.slice(0, rest.length - tail.length);
}

/**
 * 把 JSON 原文规范成运行期配置。
 *
 * @param raw 解析后的 JSON 值
 * @param source 配置文件路径（只用于错误提示）
 */
export function normalizeConfig(raw, source = '') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('配置文件根节点必须是 JSON 对象');
  }

  const selfQQ = normalizeQQ(raw.selfQQ, 'selfQQ');
  const ownerQQ = normalizeQQ(raw.ownerQQ, 'ownerQQ');
  if (selfQQ === ownerQQ) {
    throw new ConfigError('selfQQ 与 ownerQQ 不能相同：需要由另一个 QQ 给机器人下命令');
  }

  const commandsRaw = raw.commands;
  if (commandsRaw === null || typeof commandsRaw !== 'object' || Array.isArray(commandsRaw)) {
    throw new ConfigError('commands 必须是 {"文本": ["命令", "Shell"]} 形式的对象');
  }

  const commands = new Map();
  for (const [rawText, entry] of Object.entries(commandsRaw)) {
    const text = rawText.trim();
    if (!text) throw new ConfigError('commands 里存在空文本键');
    if (commands.has(text)) throw new ConfigError(`commands 的文本键重复（首尾空格不计）：${text}`);
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new ConfigError(`命令「${text}」的值必须是 [命令, Shell] 两元素数组`);
    }
    const [command, shellName] = entry;
    if (typeof command !== 'string' || !command.trim()) {
      throw new ConfigError(`命令「${text}」的命令部分必须是非空字符串`);
    }
    if (typeof shellName !== 'string' || !shellName.trim()) {
      throw new ConfigError(`命令「${text}」的 Shell 部分必须是非空字符串（${SHELL_LIST}）`);
    }
    try {
      resolveShell(shellName);
    } catch (error) {
      throw new ConfigError(`命令「${text}」：${error.message}`);
    }
    commands.set(text, {
      text,
      command,
      shell: shellName.trim(),
      display: `${shellName.trim()} ${command}`,
    });
  }

  const allowedSenders = new Set([ownerQQ]);
  if (raw.allowedSenders !== undefined) {
    if (!Array.isArray(raw.allowedSenders)) {
      throw new ConfigError('allowedSenders 必须是 QQ 号数组');
    }
    for (const item of raw.allowedSenders) {
      allowedSenders.add(normalizeQQ(item, 'allowedSenders 里的项'));
    }
  }

  // 能通过 QQ 私信增删命令的管理员；主人永远在列表里。
  const adminSenders = new Set([ownerQQ]);
  if (raw.adminSenders !== undefined) {
    if (!Array.isArray(raw.adminSenders)) {
      throw new ConfigError('adminSenders 必须是 QQ 号数组');
    }
    for (const item of raw.adminSenders) {
      adminSenders.add(normalizeQQ(item, 'adminSenders 里的项'));
    }
  }

  const napcatRaw = raw.napcat !== null && typeof raw.napcat === 'object' && !Array.isArray(raw.napcat)
    ? raw.napcat
    : {};
  const shellRaw = raw.shell !== null && typeof raw.shell === 'object' && !Array.isArray(raw.shell)
    ? raw.shell
    : {};
  const notifyRaw = raw.notify !== null && typeof raw.notify === 'object' && !Array.isArray(raw.notify)
    ? raw.notify
    : {};

  // 消息格式：formats.execute / formats.add 可自定义；旧的 prefix 仍然兼容。
  const formatsRaw = raw.formats === undefined ? {} : raw.formats;
  if (formatsRaw === null || typeof formatsRaw !== 'object' || Array.isArray(formatsRaw)) {
    throw new ConfigError('formats 必须是对象，例如 {"execute": "执行Shell命令：\\n", "add": "增加 Shell 命令："}');
  }
  let executeFormat;
  if (formatsRaw.execute !== undefined) {
    executeFormat = compileTemplate(formatsRaw.execute, 'text', 'formats.execute', { allowEmpty: true });
  } else if (raw.prefix !== undefined) {
    executeFormat = compileTemplate(
      normalizePrefix(raw.prefix),
      'text',
      'formats.execute（旧字段 prefix）',
      { allowEmpty: true },
    );
  } else {
    executeFormat = compileTemplate(DEFAULT_PREFIX, 'text', 'formats.execute');
  }
  const addFormat = formatsRaw.add === '' || formatsRaw.add === null
    ? null
    : compileTemplate(formatsRaw.add ?? DEFAULT_ADD_FORMAT, 'json', 'formats.add', {
      allowEmpty: true,
      requireAnchor: true,
    });

  return {
    source,
    selfQQ,
    ownerQQ,
    prefix: executeFormat.template,
    formats: { execute: executeFormat, add: addFormat },
    commands,
    allowedSenders,
    adminSenders,
    allowGroup: raw.allowGroup === true,
    napcat: {
      ws: normalizeWsUrl(napcatRaw.ws ?? raw.ws ?? DEFAULT_WS),
      token: optionalString(napcatRaw.token),
      // 空字符串代表「napcat-tools 的上一级目录」（napcat_api 包通常在那里）
      cwd: optionalString(napcatRaw.cwd),
      python: optionalString(napcatRaw.python),
      pythonPath: optionalString(napcatRaw.pythonPath),
      timeoutMs: asInt(napcatRaw.timeoutMs, 30000, 3000, 120000),
    },
    shell: {
      cwd: optionalString(shellRaw.cwd) || homedir(),
      timeoutMs: asInt(shellRaw.timeoutMs, 600000, 1000, 3600000),
    },
    notify: {
      start: notifyRaw.start !== false,
      outputLines: asInt(notifyRaw.outputLines, 20, 0, 200),
      maxChars: asInt(notifyRaw.maxChars, 1800, 200, 6000),
    },
    debug: raw.debug === true,
  };
}

function parseJson(text, path) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`配置文件不是合法 JSON（${path}）：${error.message}`);
  }
}

/** 按 mtime+size 缓存的配置读取器；消息到达时自动感知文件修改。 */
export class ConfigStore {
  constructor(path, log = () => {}) {
    this.path = path;
    this.log = log;
    this.cached = null;
    this.signature = '';
    this.writeChain = Promise.resolve();
  }

  async load() {
    let info;
    try {
      info = await stat(this.path);
    } catch (error) {
      throw new ConfigError(`配置文件不存在或无法读取：${this.path}（${error.code ?? error.message}）`);
    }
    const signature = `${info.mtimeMs}:${info.size}`;
    if (this.cached !== null && signature === this.signature) return this.cached;

    const raw = parseJson(await readFile(this.path, 'utf8'), this.path);
    const config = normalizeConfig(raw, this.path);
    this.cached = config;
    this.signature = signature;
    this.log('info', `配置已加载：${this.path}（QQ ${config.selfQQ} → 主人 ${config.ownerQQ}，命令 ${config.commands.size} 条）`);
    return config;
  }

  /**
   * 新增/覆盖一条命令并写回配置文件（UTF-8 无 BOM，2 空格缩进）。
   *
   * 写操作串行化；每次写前重新读盘，避免覆盖别人手工改的内容。写前再跑一遍
   * normalizeConfig，保证写出去的这份配置仍然能正常加载。
   *
   * @param {string} rawText 暗号
   * @param {string} rawCommand Shell 命令
   * @param {string} rawShell Shell 名称
   * @returns {Promise<{existed: boolean, text: string, command: string, shell: string}>}
   */
  async addCommand(rawText, rawCommand, rawShell) {
    const key = String(rawText ?? '').trim();
    const command = String(rawCommand ?? '').trim();
    const shellName = String(rawShell ?? '').trim();
    if (!key) throw new ConfigError('命令文本不能为空');
    if (!command) throw new ConfigError('命令内容不能为空');
    if (!shellName) throw new ConfigError('Shell 不能为空');
    try {
      resolveShell(shellName);
    } catch (error) {
      throw new ConfigError(error.message);
    }

    const job = this.writeChain.then(async () => {
      const raw = parseJson(await readFile(this.path, 'utf8'), this.path);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ConfigError('配置文件根节点必须是 JSON 对象');
      }
      if (raw.commands === null || typeof raw.commands !== 'object' || Array.isArray(raw.commands)) {
        throw new ConfigError('配置里的 commands 必须是 {"文本": ["命令", "Shell"]} 对象');
      }

      // 键在加载时会 trim，这里按 trim 后的键认「已存在」，避免写出重复键。
      const existingKey = Object.keys(raw.commands).find((item) => item.trim() === key);
      const existed = existingKey !== undefined;
      raw.commands[existingKey ?? key] = [command, shellName];

      normalizeConfig(raw, this.path); // 写前确认整份配置仍然合法

      const output = `${JSON.stringify(raw, null, 2)}\n`;
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, output, 'utf8');
      try {
        await rename(tmp, this.path);
      } catch (error) {
        // 某些 Windows 环境（杀软/文件占用）rename 会失败，退化成直接覆盖。
        await writeFile(this.path, output, 'utf8');
        await unlink(tmp).catch(() => {});
        this.log('warn', `原子替换失败，已直接写入配置文件：${error.code ?? error.message}`);
      }

      this.invalidate();
      this.log('info', `配置文件已更新：${existed ? '覆盖' : '新增'}命令「${key}」（${shellName} ${command}）`);
      return { existed, text: key, command, shell: shellName };
    });

    // 一次写失败不能让后续所有写操作都挂在这条 rejected promise 上。
    this.writeChain = job.catch(() => {});
    return job;
  }

  invalidate() {
    this.cached = null;
    this.signature = '';
  }
}
