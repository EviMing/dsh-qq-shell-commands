// 启动自检：在 DSH 之外用假 ctx 装配插件，验证 apply() 到 WebSocket 连接的整条链路。
// 用法：node test/boot-check.mjs [配置文件路径]
import { EventEmitter } from 'node:events';

const configFile = process.argv[2] || process.env.DSH_QQ_SHELL_CONFIG;
if (!configFile) {
  console.error('用法：node test/boot-check.mjs <配置文件路径>（或设置 DSH_QQ_SHELL_CONFIG）');
  process.exit(2);
}
const logs = [];
const logger = {
  debug: (m) => logs.push(['debug', m]),
  info: (m) => logs.push(['info', m]),
  warn: (m) => logs.push(['warn', m]),
  error: (m) => logs.push(['error', m]),
};
logger.info = (m) => { logs.push(['info', m]); console.log('[info]', m); };
logger.warn = (m) => { logs.push(['warn', m]); console.log('[warn]', m); };
logger.error = (m) => { logs.push(['error', m]); console.log('[error]', m); };

let disposer = null;
const ctx = {
  logger,
  effect(cb, _label) {
    disposer = cb();
    return () => {};
  },
  subprocess: {
    resolveExecutable: async () => 'C:/Windows/System32/where.exe',
    spawn: () => { throw new Error('boot-check 不应调用 subprocess'); },
  },
};

const mod = await import('../index.js');
mod.apply(ctx, { configFile });
console.log('apply 已调用，等待连接…');

await new Promise((r) => setTimeout(r, 4000));

const joined = logs.map(([, m]) => m).join('\n');
const ok = /已启动/.test(joined) && /已连接 NapCat WebSocket/.test(joined) && /NapCat 账号已登录/.test(joined);
console.log(ok ? 'BOOT-CHECK OK' : 'BOOT-CHECK FAILED');

if (typeof disposer === 'function') disposer();
await new Promise((r) => setTimeout(r, 500));
process.exit(ok ? 0 : 1);
