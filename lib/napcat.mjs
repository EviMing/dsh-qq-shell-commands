/**
 * 复用前置插件 @local/napcat-tools 发 QQ 私信。
 *
 * 这里刻意「动态 import 绝对路径」而不是把 napcat-tools 声明成 npm 依赖：
 * 前置插件是用户机器上的固定目录（插件配置 prereqDir），它自己又依赖本地的
 * Python 包 napcat_api。用绝对路径加载，既满足「以 napcat-tools 为前置条件」，
 * 也不会让本插件被绑定到某个 profile 的 node_modules 布局。
 *
 * 需要插件 inject: ['subprocess']——napcat-tools 的 runCli 用 ctx.subprocess
 * 启动 python -m napcat_api。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export class PrerequisiteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrerequisiteError';
  }
}

/**
 * 校验并加载前置插件。失败时给出能直接照着修的提示。
 *
 * @param {string} prereqDir napcat-tools 目录
 * @param {(level: string, message: string) => void} log
 */
export async function loadNapcatRunner(prereqDir, log = () => {}) {
  if (typeof prereqDir !== 'string' || !prereqDir.trim()) {
    throw new PrerequisiteError('插件配置缺少 prereqDir（napcat-tools 的绝对路径）');
  }
  const root = prereqDir.trim();
  const pkgPath = join(root, 'package.json');
  const runnerPath = join(root, 'lib', 'runner.mjs');
  if (!existsSync(pkgPath)) {
    throw new PrerequisiteError(`前置插件不存在：${pkgPath}（请先安装/保留 napcat-tools）`);
  }
  if (!existsSync(runnerPath)) {
    throw new PrerequisiteError(`前置插件缺少 lib/runner.mjs：${runnerPath}`);
  }

  let pkg;
  try {
    pkg = JSON.parse((await readFile(pkgPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new PrerequisiteError(`读取前置插件 package.json 失败：${error.message}`);
  }
  if (pkg?.name !== '@local/napcat-tools') {
    throw new PrerequisiteError(`前置插件不是 @local/napcat-tools（实际是 ${pkg?.name ?? '未知'}）`);
  }

  const module = await import(pathToFileURL(runnerPath).href);
  if (typeof module.runCli !== 'function') {
    throw new PrerequisiteError('前置插件的 lib/runner.mjs 没有导出 runCli');
  }
  log('info', `已加载前置插件 ${pkg.name}@${pkg.version ?? '?'}：${runnerPath}`);
  return { name: pkg.name, version: pkg.version ?? '', runCli: module.runCli };
}

/**
 * 私信发送器。真正发消息时调用 napcat-tools 的 runCli：
 *   python -m napcat_api send -u <ownerQQ> --text <文本> --json
 */
export class NapcatNotifier {
  constructor({ ctx, prereqDir, log = () => {} }) {
    this.ctx = ctx;
    this.prereqDir = prereqDir;
    this.log = log;
    this.runner = null;
    this.options = null;
  }

  configure(config, runner, prereqDir = this.prereqDir) {
    this.runner = runner;
    this.options = {
      cwd: config.napcat.cwd || dirname(prereqDir),
      python: config.napcat.python,
      pythonPath: config.napcat.pythonPath,
      timeoutMs: config.napcat.timeoutMs,
    };
  }

  get ready() {
    return this.runner !== null && this.options !== null;
  }

  async send(targetQQ, text) {
    if (!this.ready) throw new PrerequisiteError('前置插件尚未加载，无法发送私信');
    const body = String(text ?? '').trim();
    if (!body) return;
    const data = await this.runner.runCli(
      this.ctx,
      this.options,
      ['send', '-u', String(targetQQ), '--text', body],
    );
    const messageId = data?.message_id ?? data?.messageId ?? data?.data?.message_id;
    this.log('info', `已私信 ${targetQQ}${messageId === undefined ? '' : `（消息 ${messageId}）`}`);
    return data;
  }
}
