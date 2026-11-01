/**
 * 手动联调：只验证「配置 + NapCat WebSocket 连接」，不会执行任何命令。
 *
 *   node test/live-ws.mjs [配置文件路径]
 *
 * 8 秒后自动断开；若 NapCat 登录的号与 selfQQ 不一致，会打印错误并停止。
 */
import { ConfigStore, resolveConfigPath } from '../lib/config.mjs';
import { OneBotSocket } from '../lib/ws.mjs';

const store = new ConfigStore(resolveConfigPath(process.argv[2] ?? ''));
const config = await store.load();
console.log(
  `配置：selfQQ=${config.selfQQ} ownerQQ=${config.ownerQQ} ws=${config.napcat.ws} ` +
    `命令=${config.commands.size} 条`,
);

const socket = new OneBotSocket({
  url: config.napcat.ws,
  token: config.napcat.token,
  selfQQ: config.selfQQ,
  log: (level, message) => console.log(`[${level}] ${message}`),
  onEvent: (event) => {
    console.log(
      `[message] type=${event.message_type} sender=${event.user_id} ` +
        `text=${JSON.stringify(
          Array.isArray(event.message)
            ? event.message.filter((s) => s?.type === 'text').map((s) => s?.data?.text).join('')
            : event.message,
        )}`,
    );
  },
});

socket.start();
setTimeout(() => {
  socket.stop();
  process.exit(0);
}, 8000);
