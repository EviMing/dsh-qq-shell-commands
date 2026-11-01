/**
 * 不依赖 DSH / 不连 QQ 的自测：
 *   node test/selftest.mjs
 *
 * 覆盖配置校验、Shell argv、真实进程执行（cmd / PowerShell / 超时 / 非零退出）、
 * 文本抽取，以及注入假通知器后的完整消息分发流程。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, ConfigStore, compileTemplate, extractFromTemplate, normalizeConfig } from '../lib/config.mjs';
import { AddCommandError, CommandDispatcher, parseAddCommand } from '../lib/dispatcher.mjs';
import { extractText } from '../lib/message.mjs';
import { ShellError, resolveShell, runShellCommand } from '../lib/shell.mjs';

const CASES = [];
function test(name, fn) {
  CASES.push({ name, fn });
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

const WIN_CWD = 'C:\\Windows';
const BASE = {
  selfQQ: 10001,
  ownerQQ: 10002,
  commands: {
    回声: ['echo 1', 'cmd'],
    时间: ["Get-Date -Format 'yyyy-MM-dd HH:mm:ss'", 'PowerShell'],
  },
  shell: { cwd: WIN_CWD, timeoutMs: 60000 },
  notify: { start: true, outputLines: 20, maxChars: 1800 },
  napcat: { ws: 'ws://127.0.0.1:3001', token: 'test-token' },
};

test('配置：正常值被规范成 Map/Set', () => {
  const config = normalizeConfig(BASE);
  assert.equal(config.selfQQ, '10001');
  assert.equal(config.ownerQQ, '10002');
  assert.equal(config.commands.size, 2);
  assert.equal(config.commands.get('回声').display, 'cmd echo 1');
  assert.ok(config.allowedSenders.has('10002'));
  assert.equal(config.allowGroup, false);
  assert.equal(config.prefix, '执行Shell命令：\n', '默认前缀应带换行');
  assert.equal(config.shell.timeoutMs, 60000);
  assert.equal(config.notify.start, true);
});

test('配置：selfQQ 与 ownerQQ 相同要报错', () => {
  assert.throws(
    () => normalizeConfig({ ...BASE, ownerQQ: BASE.selfQQ }),
    (error) => error instanceof ConfigError && /不能相同/.test(error.message),
  );
});

test('配置：命令项必须是 [命令, Shell] 两元素数组', () => {
  assert.throws(
    () => normalizeConfig({ ...BASE, commands: { 坏: ['echo 1'] } }),
    (error) => error instanceof ConfigError && /两元素数组/.test(error.message),
  );
});

test('配置：未知 Shell 在加载时就报错', () => {
  assert.throws(
    () => normalizeConfig({ ...BASE, commands: { 坏: ['echo 1', 'tclsh'] } }),
    (error) => error instanceof ConfigError && /不支持的 Shell/.test(error.message),
  );
});

test('配置：allowedSenders 会追加且保留主人', () => {
  const config = normalizeConfig({ ...BASE, allowedSenders: [111111111] });
  assert.ok(config.allowedSenders.has('10002'));
  assert.ok(config.allowedSenders.has('111111111'));
});

test('配置：adminSenders 默认含主人并可扩展', () => {
  const config = normalizeConfig({ ...BASE, adminSenders: [111111111] });
  assert.ok(config.adminSenders.has('10002'));
  assert.ok(config.adminSenders.has('111111111'));
  const fallback = normalizeConfig(BASE);
  assert.deepEqual([...fallback.adminSenders], ['10002']);
});

test('加命令：解析 JSON、校验 Shell 与格式', () => {
  const parsed = parseAddCommand('{"新命令": ["echo 42", "cmd"], "第二条": ["Get-Date", "PowerShell"]}');
  assert.deepEqual(parsed.map((item) => item.key), ['新命令', '第二条']);
  assert.equal(parsed[0].command, 'echo 42');

  assert.throws(
    () => parseAddCommand('{"坏": ["echo 1", "tclsh"]}'),
    (error) => error instanceof AddCommandError && /不支持的 Shell/.test(error.message),
  );
  assert.throws(() => parseAddCommand('not json'), /JSON 解析失败/);
  assert.throws(() => parseAddCommand('{"坏": "echo 1"}'), /两元素数组/);
  assert.throws(() => parseAddCommand('{}'), /至少要有一条/);
  assert.throws(() => parseAddCommand(''), /后面要跟 JSON/);
});

test('加命令：白名单私信写入配置，随后可立即执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-shell-commands-add-'));
  const path = join(dir, 'config.json');
  const notifications = [];
  const executed = [];
  try {
    await writeFile(path, JSON.stringify(BASE), 'utf8');
    const store = new ConfigStore(path, () => {});
    const dispatcher = new CommandDispatcher({
      getConfig: () => store.load(),
      notify: async (_cfg, text) => {
        notifications.push(text);
      },
      notifyQQ: async (_qq, text) => {
        notifications.push(text);
      },
      saveCommand: (text, command, shell) => store.addCommand(text, command, shell),
      runCommand: async ({ command, shell }) => {
        executed.push(`${shell} ${command}`);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 1,
          stdout: command,
          stderr: '',
          spawnError: null,
        };
      },
    });

    const added = await dispatcher.handle(
      makeEvent({ message: [{ type: 'text', data: { text: '增加 Shell 命令：{"新命令": ["echo 42", "cmd"]}' } }] }),
    );
    assert.equal(added, true);
    assert.match(notifications.at(-1), /命令已新增/);

    const bytes = await readFile(path);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '写回配置不能带 BOM');
    const reloaded = await store.load();
    assert.equal(reloaded.commands.get('新命令').command, 'echo 42');
    assert.equal(reloaded.commands.get('新命令').shell, 'cmd');

    const ran = await dispatcher.handle(
      makeEvent({ message: [{ type: 'text', data: { text: '执行Shell命令：\n新命令' } }] }),
    );
    assert.equal(ran, true);
    assert.deepEqual(executed, ['cmd echo 42']);

    const updated = await dispatcher.handle(
      makeEvent({ message: [{ type: 'text', data: { text: '增加 Shell 命令：{"新命令": ["echo 43", "cmd"]}' } }] }),
    );
    assert.equal(updated, true);
    assert.match(notifications.at(-1), /命令已更新/);
    const reloaded2 = await store.load();
    assert.equal(reloaded2.commands.get('新命令').command, 'echo 43');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('加命令：非白名单、群消息、坏 Shell 都不会写入配置', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-shell-commands-deny-'));
  const path = join(dir, 'config.json');
  const notifications = [];
  try {
    await writeFile(path, JSON.stringify(BASE), 'utf8');
    const store = new ConfigStore(path, () => {});
    const dispatcher = new CommandDispatcher({
      getConfig: () => store.load(),
      notify: async (_cfg, text) => {
        notifications.push(text);
      },
      notifyQQ: async (_qq, text) => {
        notifications.push(text);
      },
      saveCommand: (text, command, shell) => store.addCommand(text, command, shell),
    });

    await dispatcher.handle(makeEvent({
      user_id: 111111111,
      message: [{ type: 'text', data: { text: '增加 Shell 命令：{"陌生": ["echo 1", "cmd"]}' } }],
    }));
    assert.equal(notifications.length, 0, '非白名单不应收到回复');

    await dispatcher.handle(makeEvent({
      message_type: 'group',
      group_id: 123456,
      message: [{ type: 'text', data: { text: '增加 Shell 命令：{"群里": ["echo 1", "cmd"]}' } }],
    }));
    assert.equal(notifications.length, 0, '群消息不处理加命令');

    await dispatcher.handle(makeEvent({
      message: [{ type: 'text', data: { text: '增加 Shell 命令：{"坏": ["echo 1", "tclsh"]}' } }],
    }));
    assert.match(notifications.at(-1), /添加失败/);
    assert.match(notifications.at(-1), /不支持的 Shell/);

    const reloaded = await store.load();
    assert.equal(reloaded.commands.has('陌生'), false);
    assert.equal(reloaded.commands.has('群里'), false);
    assert.equal(reloaded.commands.has('坏'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('格式：自定义执行与新增格式端到端生效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-shell-commands-format-'));
  const path = join(dir, 'config.json');
  const notifications = [];
  const executed = [];
  try {
    await writeFile(path, JSON.stringify({
      ...BASE,
      formats: { execute: '跑\n{text}', add: '加命令【{json}】' },
    }), 'utf8');
    const store = new ConfigStore(path, () => {});
    const dispatcher = new CommandDispatcher({
      getConfig: () => store.load(),
      notify: async (_cfg, text) => {
        notifications.push(text);
      },
      notifyQQ: async (_qq, text) => {
        notifications.push(text);
      },
      saveCommand: (text, command, shell) => store.addCommand(text, command, shell),
      runCommand: async ({ command }) => {
        executed.push(command);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 1,
          stdout: command,
          stderr: '',
          spawnError: null,
        };
      },
    });

    const added = await dispatcher.handle(makeEvent({
      message: [{ type: 'text', data: { text: '加命令【{"跑": ["echo 7", "cmd"]}】' } }],
    }));
    assert.equal(added, true);
    assert.match(notifications.at(-1), /命令已新增/);

    const ran = await dispatcher.handle(makeEvent({
      message: [{ type: 'text', data: { text: '跑\n跑' } }],
    }));
    assert.equal(ran, true);
    assert.deepEqual(executed, ['echo 7']);

    const oldFormat = await dispatcher.handle(makeEvent({
      message: [{ type: 'text', data: { text: '执行Shell命令：\n跑' } }],
    }));
    assert.equal(oldFormat, false, '旧默认格式在自定义后不应再匹配');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置：执行/新增的格式可由配置文件定义', () => {
  const custom = normalizeConfig({
    ...BASE,
    formats: { execute: '跑\n{text}', add: '加命令【{json}】' },
  });
  assert.equal(custom.prefix, '跑\n{text}');
  assert.equal(custom.formats.execute.before, '跑\n');
  assert.equal(custom.formats.execute.after, '');
  assert.equal(custom.formats.add.before, '加命令【');
  assert.equal(custom.formats.add.after, '】');

  const legacy = normalizeConfig({ ...BASE, prefix: '暗号：\n' });
  assert.equal(legacy.formats.execute.hasPlaceholder, false);
  assert.equal(legacy.formats.execute.before, '暗号：\n');

  const off = normalizeConfig({ ...BASE, formats: { execute: '', add: '' } });
  assert.equal(off.formats.execute.before, '');
  assert.equal(off.formats.add, null);

  assert.throws(
    () => normalizeConfig({ ...BASE, formats: { execute: 123 } }),
    (error) => error instanceof ConfigError && /必须是字符串/.test(error.message),
  );
  assert.throws(
    () => normalizeConfig({ ...BASE, formats: { add: '{json}' } }),
    (error) => error instanceof ConfigError && /固定文本/.test(error.message),
  );
});

test('格式：按模板提取正文，支持前缀与占位符', () => {
  const prefix = compileTemplate('执行Shell命令：\n', 'text', 'test');
  assert.equal(extractFromTemplate('执行Shell命令：\n回声', prefix), '回声');
  assert.equal(extractFromTemplate('执行Shell命令：\r\n回声', prefix), '回声');
  assert.equal(extractFromTemplate('执行Shell命令：回声', prefix), null);
  assert.equal(extractFromTemplate('执行Shell命令：\n', prefix), '');

  const wrapped = compileTemplate('执行【{text}】', 'text', 'test');
  assert.equal(extractFromTemplate('执行【回声】', wrapped), '回声');
  assert.equal(extractFromTemplate('执行【回声', wrapped), null);
  assert.equal(extractFromTemplate('前缀执行【回声】后缀', wrapped), null);

  const none = compileTemplate('', 'text', 'test', { allowEmpty: true });
  assert.equal(extractFromTemplate('回声', none), '回声');

  const json = compileTemplate('加命令【{json}】', 'json', 'test');
  assert.equal(extractFromTemplate('加命令【{"a":1}】', json), '{"a":1}');
});

test('Shell：argv 拼装符合预期', () => {
  const cmd = resolveShell('cmd');
  assert.deepEqual(cmd.args('echo 1'), ['/d', '/s', '/c', '"echo 1"']);
  assert.equal(cmd.verbatim, true);

  const ps = resolveShell('PowerShell');
  assert.deepEqual(ps.args('Write-Output 1'), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    'Write-Output 1',
  ]);
  assert.equal(ps.verbatim, false);

  assert.equal(resolveShell('pwsh').exe, 'pwsh.exe');
  assert.throws(() => resolveShell('vim'), ShellError);
});

test('Shell：cmd echo 正常返回', async () => {
  const result = await runShellCommand({ command: 'echo hello', shell: 'cmd', cwd: WIN_CWD, timeoutMs: 20000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.trim(), 'hello');
});

test('Shell：cmd 的引号原样保留（windowsVerbatimArguments）', async () => {
  const result = await runShellCommand({ command: 'echo "hello world"', shell: 'cmd', cwd: WIN_CWD, timeoutMs: 20000 });
  assert.equal(result.stdout.trim(), '"hello world"');
});

test('Shell：非零退出码被如实带回', async () => {
  const result = await runShellCommand({ command: 'exit /b 3', shell: 'cmd', cwd: WIN_CWD, timeoutMs: 20000 });
  assert.equal(result.exitCode, 3);
});

test('Shell：PowerShell 中文输出可解码', async () => {
  const result = await runShellCommand({
    command: "Write-Output '中文测试'",
    shell: 'PowerShell',
    cwd: WIN_CWD,
    timeoutMs: 30000,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /中文测试/);
});

test('Shell：超时会终止进程树并标记 timedOut', async () => {
  const started = Date.now();
  const result = await runShellCommand({
    command: 'ping -n 10 127.0.0.1 >nul',
    shell: 'cmd',
    cwd: WIN_CWD,
    timeoutMs: 1000,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 15000, '超时后应很快返回');
});

test('Shell：工作目录不存在时抛 ShellError', async () => {
  await assert.rejects(
    () => runShellCommand({ command: 'echo 1', shell: 'cmd', cwd: 'C:\\no-such-dir-qq-shell-commands' }),
    ShellError,
  );
});

test('消息：只拼 text 段', () => {
  assert.equal(
    extractText([
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 回声' } },
      { type: 'face', data: { id: '1' } },
    ]),
    ' 回声',
  );
  assert.equal(extractText('回声'), '回声');
  assert.equal(extractText(undefined), '');
});

function makeEvent(overrides = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 10001,
    user_id: 10002,
    message: [{ type: 'text', data: { text: '执行Shell命令：\n回声' } }],
    ...overrides,
  };
}

function makeDispatcher(notifications, config = BASE, runCommand) {
  const normalized = normalizeConfig(config);
  return new CommandDispatcher({
    getConfig: async () => normalized,
    notify: async (_cfg, text) => {
      notifications.push(text);
    },
    log: () => {},
    ...(runCommand ? { runCommand } : {}),
  });
}

test('分发：主人私聊命中 → 执行并两条通知', async () => {
  const notifications = [];
  const dispatcher = makeDispatcher(notifications);
  const handled = await dispatcher.handle(makeEvent());
  assert.equal(handled, true);
  assert.equal(notifications.length, 2);
  assert.match(notifications[0], /开始执行/);
  assert.match(notifications[0], /cmd echo 1/);
  assert.match(notifications[1], /命令已执行/);
  assert.match(notifications[1], /退出码：0/);
  assert.match(notifications[1], /输出：[\s\S]*1/);
});

test('分发：陌生人发同样的暗号不执行', async () => {
  const notifications = [];
  const dispatcher = makeDispatcher(notifications);
  const handled = await dispatcher.handle(makeEvent({ user_id: 111111111 }));
  assert.equal(handled, false);
  assert.equal(notifications.length, 0);
});

test('分发：群消息默认不执行', async () => {
  const notifications = [];
  const dispatcher = makeDispatcher(notifications);
  const handled = await dispatcher.handle(makeEvent({ message_type: 'group', group_id: 123456 }));
  assert.equal(handled, false);
  assert.equal(notifications.length, 0);
});

test('分发：self_id 不匹配直接忽略（防登错号）', async () => {
  const notifications = [];
  const dispatcher = makeDispatcher(notifications);
  const handled = await dispatcher.handle(makeEvent({ self_id: 999999999 }));
  assert.equal(handled, false);
  assert.equal(notifications.length, 0);
});

test('分发：未命中文本不执行（暗号必须完全相等）', async () => {
  const notifications = [];
  const dispatcher = makeDispatcher(notifications);
  const withSpace = await dispatcher.handle(
    makeEvent({ message: [{ type: 'text', data: { text: '执行Shell命令：\n回声 ' } }] }),
  );
  assert.equal(withSpace, false, '前缀后的文本不 trim，带空格不应命中');

  const other = await dispatcher.handle(
    makeEvent({ message: [{ type: 'text', data: { text: '执行Shell命令：\n回声啊' } }] }),
  );
  assert.equal(other, false);

  const noPrefix = await dispatcher.handle(makeEvent({ message: [{ type: 'text', data: { text: '回声' } }] }));
  assert.equal(noPrefix, false, '没有「执行Shell命令：」+ 换行的消息不应执行');
});

test('分发：同一条命令并发触发只执行一次', async () => {
  const notifications = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const dispatcher = makeDispatcher(
    notifications,
    BASE,
    async () => {
      await gate;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 1200,
        stdout: 'slow',
        stderr: '',
        spawnError: null,
      };
    },
  );
  const first = dispatcher.handle(makeEvent());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = dispatcher.handle(makeEvent());
  release();
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.ok(notifications.some((text) => /命令进行中/.test(text)));
});

test('配置：ConfigStore 按 mtime+size 自动重载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-shell-commands-'));
  const path = join(dir, 'config.json');
  try {
    await writeFile(path, JSON.stringify(BASE), 'utf8');
    const store = new ConfigStore(path);
    const first = await store.load();
    assert.equal(first.commands.size, 2);

    const updated = JSON.parse(JSON.stringify(BASE));
    updated.commands.新命令 = ['echo 2', 'cmd'];
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path, JSON.stringify(updated), 'utf8');
    const second = await store.load();
    assert.equal(second.commands.size, 3);
    assert.ok(second.commands.has('新命令'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

section('运行');
let failed = 0;
for (const { name, fn } of CASES) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${error?.stack ?? error}`);
  }
}
console.log(`\n${CASES.length - failed}/${CASES.length} 通过`);
if (failed > 0) process.exitCode = 1;
