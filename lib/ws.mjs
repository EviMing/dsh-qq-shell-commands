/**
 * 最小 OneBot 11 WebSocket 客户端（只收事件，不承担发送）。
 *
 * 为什么不走 HTTP 轮询：NapCat 的 WS 服务会把 message 事件实时推过来。
 * 发送仍交给前置插件 napcat-tools（Python CLI），这样本插件不需要理解 QQ 协议。
 *
 * 防登错号：每条 message/lifecycle 事件都带 self_id，必须等于配置里的 selfQQ。
 * 一旦发现不一致，立即断开并停止重连——宁可插件不工作，也不能拿别人的号执行命令。
 */
const HANDSHAKE_TIMEOUT_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_BACKOFF_MS = 30000;

export class OneBotSocket {
  /**
   * @param {{
   *   url: string,
   *   token: string,
   *   selfQQ: string,
   *   onEvent: (event: any) => any,
   *   log?: (level: string, message: string) => void,
   *   reconnectMs?: number,
   * }} options
   */
  constructor({ url, token, selfQQ, onEvent, log = () => {}, reconnectMs = 2000 }) {
    this.url = url;
    this.token = token;
    this.selfQQ = String(selfQQ);
    this.onEvent = onEvent;
    this.log = log;
    this.reconnectMs = reconnectMs;
    this.stopped = false;
    this.ws = null;
    this.reconnectTimer = null;
    this.handshakeTimer = null;
    this.heartbeatTimer = null;
    this.attempt = 0;
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.#stopHeartbeat();
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* 已经断开 */
      }
    }
  }

  #endpoint() {
    const base = this.url.replace(/\/+$/, '');
    return this.token ? `${base}/?access_token=${encodeURIComponent(this.token)}` : `${base}/`;
  }

  #connect() {
    if (this.stopped || this.ws !== null) return;
    this.attempt += 1;

    let socket;
    try {
      socket = new WebSocket(this.#endpoint());
    } catch (error) {
      this.log('error', `创建 WebSocket 失败：${error?.message ?? error}`);
      this.#scheduleReconnect();
      return;
    }
    this.ws = socket;

    this.handshakeTimer = setTimeout(() => {
      if (this.ws !== socket) return;
      this.log('warn', `连接 NapCat 超时（${HANDSHAKE_TIMEOUT_MS}ms），重试`);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      if (this.ws !== socket) return;
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.attempt = 0;
      this.log('info', `已连接 NapCat WebSocket：${this.url}`);
      this.#startHeartbeat(socket);
    });

    socket.addEventListener('message', (event) => {
      if (this.ws !== socket) return;
      let data;
      try {
        data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        this.log('debug', '收到无法解析的 WS 消息，已忽略');
        return;
      }
      this.#dispatch(data);
    });

    socket.addEventListener('close', (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.#stopHeartbeat();
      if (this.stopped) return;
      const detail = event?.code ? `（code=${event.code}）` : '';
      this.log('warn', `NapCat 连接已断开${detail}，稍后重连`);
      this.#scheduleReconnect();
    });

    // 具体原因由 close 事件处理；error 只记录，避免重复重连
    socket.addEventListener('error', () => {
      if (this.ws !== socket) return;
      this.log('debug', 'NapCat WebSocket 报错，等待 close 事件');
    });
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = Math.min(MAX_BACKOFF_MS, this.reconnectMs * 2 ** Math.min(this.attempt, 4));
    this.log('info', `${Math.round(delay / 1000)} 秒后重连 NapCat`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #startHeartbeat(socket) {
    this.#stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== socket || socket.readyState !== 1) return;
      try {
        socket.send(JSON.stringify({ action: 'get_status', echo: `qq-shell-commands-${Date.now()}` }));
      } catch {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  #dispatch(data) {
    if (data === null || typeof data !== 'object') return;

    if (data.post_type === 'meta_event') {
      if (data.meta_event_type === 'lifecycle') {
        const selfId = String(data.self_id ?? '');
        if (selfId !== this.selfQQ) {
          this.#stopWrongAccount(selfId);
          return;
        }
        this.log('info', `NapCat 账号已登录：${selfId}`);
      }
      return;
    }

    if (data.post_type !== 'message') return;

    const selfId = String(data.self_id ?? '');
    if (selfId !== this.selfQQ) {
      this.#stopWrongAccount(selfId);
      return;
    }

    try {
      const result = this.onEvent(data);
      if (result && typeof result.then === 'function') {
        result.catch((error) => this.log('error', `处理消息失败：${error?.message ?? error}`));
      }
    } catch (error) {
      this.log('error', `处理消息失败：${error?.message ?? error}`);
    }
  }

  #stopWrongAccount(actual) {
    this.log(
      'error',
      `NapCat 当前登录账号是 ${actual || '空'}，与配置 selfQQ=${this.selfQQ} 不一致；` +
        '为防止在错误账号/错误身份下执行命令，插件已停止接收消息。请确认登录账号后重启 DSH。',
    );
    this.stop();
  }
}
