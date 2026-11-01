/**
 * Host 插件：qq-shell-commands。
 *
 * 一句话：QQ 上发来「完全等于配置键」的文本 → 在宿主机上执行对应的 Shell
 * 命令 → 用前置插件 @local/napcat-tools 私信主人「已收到、执行了什么、结果如何」。
 *
 * 组成：
 *   lib/config.mjs     读取 %DSH_HOME%\qq-shell-commands.json（QQ 号、命令表、连接参数）
 *   lib/ws.mjs         连 NapCat 的 OneBot 11 WebSocket，只收事件，校验 self_id
 *   lib/dispatcher.mjs 精确匹配、权限判断、并发保护、执行、排版通知
 *   lib/shell.mjs      cmd / PowerShell / pwsh / bash / wsl 的 argv 拼装与超时杀进程树
 *   lib/napcat.mjs     动态加载前置插件的 lib/runner.mjs，调用 python -m napcat_api 发私信
 *
 * 命令在 DSH 宿主机（当前用户）权限下运行，不经过 DSH 沙箱；配置文件的可写
 * 权限等价于命令执行权限。
 */
import { ConfigStore, resolveConfigPath } from './lib/config.mjs';
import { CommandDispatcher } from './lib/dispatcher.mjs';
import { NapcatNotifier, loadNapcatRunner } from './lib/napcat.mjs';
import { OneBotSocket } from './lib/ws.mjs';

export const name = 'qq-shell-commands';

/** 发私信要复用 napcat-tools 的 runCli，它需要 subprocess 服务。 */
export const inject = ['subprocess'];

const TAG = '[qq-shell-commands]';
const DEFAULT_PREREQ_DIR = '';
const RETRY_MS = 60000;

const DEFAULTS = {
  configFile: '',
  prereqDir: DEFAULT_PREREQ_DIR,
};

export function apply(ctx, pluginConfig = {}) {
  const logger = ctx.logger ?? console;
  const log = (level, message) => {
    try {
      const method = typeof logger?.[level] === 'function' ? logger[level] : console[level];
      (method ?? console.log).call(logger, `${TAG} ${message}`);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  const options = {
    ...DEFAULTS,
    ...(pluginConfig !== null && typeof pluginConfig === 'object' ? pluginConfig : {}),
  };
  if (options.enabled === false) {
    log('info', '已在插件配置中禁用');
    return;
  }

  const configPath = resolveConfigPath(options.configFile);
  const prereqDir = typeof options.prereqDir === 'string' && options.prereqDir.trim()
    ? options.prereqDir.trim()
    : DEFAULT_PREREQ_DIR;

  const store = new ConfigStore(configPath, log);
  const notifier = new NapcatNotifier({ ctx, prereqDir, log });
  const dispatcher = new CommandDispatcher({
    getConfig: () => store.load(),
    notify: (config, text) => notifier.send(config.ownerQQ, text),
    notifyQQ: (qq, text) => notifier.send(qq, text),
    saveCommand: (text, command, shell) => store.addCommand(text, command, shell),
    log,
  });

  let socket = null;
  let disposed = false;
  let retryTimer = null;

  function scheduleRetry(reason) {
    if (disposed || retryTimer !== null) return;
    log('warn', `${Math.round(RETRY_MS / 1000)} 秒后重试启动：${reason}`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void start();
    }, RETRY_MS);
    retryTimer.unref?.();
  }

  async function start() {
    if (disposed) return;
    let config;
    try {
      config = await store.load();
    } catch (error) {
      log('error', `读取配置失败：${error?.message ?? error}`);
      scheduleRetry('配置文件不可用');
      return;
    }
    if (disposed) return;

    let prerequisite;
    try {
      prerequisite = await loadNapcatRunner(prereqDir, log);
    } catch (error) {
      log('error', `前置插件不可用：${error?.message ?? error}`);
      scheduleRetry('前置插件 napcat-tools 不可用');
      return;
    }
    if (disposed) return;

    notifier.configure(config, prerequisite, prereqDir);

    socket = new OneBotSocket({
      url: config.napcat.ws,
      token: config.napcat.token,
      selfQQ: config.selfQQ,
      log,
      onEvent: (event) => dispatcher.handle(event),
    });
    socket.start();

    log(
      'info',
      `已启动：本机 QQ ${config.selfQQ}，主人 ${config.ownerQQ}，命令 ${config.commands.size} 条；` +
        `前置插件 ${prerequisite.name}@${prerequisite.version}；配置 ${configPath}`,
    );
    if (config.debug) {
      log('debug', `允许的发送者：${[...config.allowedSenders].join('、')}；allowGroup=${config.allowGroup}`);
    }
  }

  ctx.effect(() => {
    void start();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      socket?.stop();
      socket = null;
    };
  }, 'qq-shell-commands');
}
