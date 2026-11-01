/**
 * 按「Shell 名称」把一条命令拼成可执行的 argv，并在宿主机上运行。
 *
 * 支持的写法（大小写不敏感，可带 .exe）：
 *   cmd / command           → cmd.exe /d /s /c "<命令>"
 *   PowerShell / ps         → powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <命令>
 *   pwsh                    → pwsh.exe 同上
 *   bash / sh               → bash.exe -lc <命令>
 *   wsl                     → wsl.exe bash -lc <命令>
 *
 * cmd 这里用 windowsVerbatimArguments 手工拼命令行：Node 默认的引号转义会让
 * cmd 收到 \" 这样的反斜杠引号，命令内容会变形。PowerShell 则相反，它按
 * CommandLineToArgvW 解析，交给 Node 正常转义即可。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const MAX_CAPTURE_BYTES = 128 * 1024;

export class ShellError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellError';
  }
}

/**
 * @param {string} shellName 配置里的 Shell 名称
 * @returns {{exe: string, verbatim: boolean, args: (command: string) => string[], label: string}}
 */
export function resolveShell(shellName) {
  const key = String(shellName ?? '').trim().toLowerCase();
  if (key === 'cmd' || key === 'cmd.exe' || key === 'command') {
    return {
      exe: process.env.ComSpec || 'cmd.exe',
      verbatim: true,
      label: 'cmd.exe',
      args: (command) => ['/d', '/s', '/c', `"${command}"`],
    };
  }
  if (key === 'powershell' || key === 'powershell.exe' || key === 'ps' || key === 'pwsh' || key === 'pwsh.exe') {
    const exe = key.startsWith('pwsh') ? 'pwsh.exe' : 'powershell.exe';
    return {
      exe,
      verbatim: false,
      label: exe,
      args: (command) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    };
  }
  if (key === 'bash' || key === 'bash.exe' || key === 'sh' || key === 'sh.exe') {
    return {
      exe: 'bash.exe',
      verbatim: false,
      label: 'bash.exe',
      args: (command) => ['-lc', command],
    };
  }
  if (key === 'wsl' || key === 'wsl.exe') {
    return {
      exe: 'wsl.exe',
      verbatim: false,
      label: 'wsl.exe',
      args: (command) => ['bash', '-lc', command],
    };
  }
  throw new ShellError(`不支持的 Shell「${shellName}」，可用：cmd、PowerShell、pwsh、bash、wsl（也可写对应 .exe）`);
}

/**
 * 输出解码：优先按 UTF-8（严格模式）解，失败再按 GBK（简体中文 Windows 控制台
 * 默认代码页 936）。带 BOM 的 UTF-16 先按 BOM 处理。
 */
export function decodeOutput(buffer) {
  if (!buffer || buffer.length === 0) return '';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer.subarray(3));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // 不是合法 UTF-8，按简体中文控制台最常见的 GBK 再试一次
  }
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return buffer.toString('latin1');
  }
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10000,
      });
    } catch {
      /* 继续尝试 child.kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经退出 */
  }
}

/**
 * 运行一条命令，永不 reject（配置层面已经校验过 Shell），结果里带退出码、
 * 超时标记和输出。启动失败（例如 cwd 不存在）以 ShellError reject，方便上层
 * 把「配置/环境错误」和「命令自身失败」区分开。
 *
 * @param {{command: string, shell: string, cwd: string, timeoutMs?: number, env?: NodeJS.ProcessEnv}} options
 * @returns {Promise<{exitCode: number|null, signal: string|null, timedOut: boolean, durationMs: number, stdout: string, stderr: string, spawnError: string|null}>}
 */
export function runShellCommand({ command, shell, cwd, timeoutMs = 600000, env }) {
  const spec = resolveShell(shell);
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return Promise.reject(new ShellError('没有配置命令的工作目录（shell.cwd）'));
  }
  if (!existsSync(cwd)) {
    return Promise.reject(new ShellError(`命令的工作目录不存在：${cwd}`));
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let finished = false;
    let timedOut = false;
    let spawnError = null;
    const captured = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };

    const capture = (name, chunk) => {
      if (sizes[name] >= MAX_CAPTURE_BYTES) return;
      const room = MAX_CAPTURE_BYTES - sizes[name];
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      captured[name].push(slice);
      sizes[name] += slice.length;
    };

    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === 'number' ? code : null,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: decodeOutput(captured.stdout.length ? Buffer.concat(captured.stdout) : Buffer.alloc(0)).replace(/\s+$/, ''),
        stderr: decodeOutput(captured.stderr.length ? Buffer.concat(captured.stderr) : Buffer.alloc(0)).replace(/\s+$/, ''),
        spawnError,
      });
    };

    let timer = null;
    let child;
    try {
      child = spawn(spec.exe, spec.args(command), {
        cwd,
        env: env ?? process.env,
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: '',
        spawnError: error?.message ?? String(error),
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk) => capture('stderr', chunk));
    child.on('close', (code, signal) => finish(code, signal));
    child.on('error', (error) => {
      spawnError = error?.message ?? String(error);
      finish(null, null);
    });
  });
}
