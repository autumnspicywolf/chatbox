import { randomBytes, randomInt } from 'node:crypto'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import {
  LAN_SYNC_PROTOCOL_VERSION,
  LanSyncHttpPath,
  type LanSyncForwardedMessage,
  type LanSyncManifest,
  type LanSyncPackage,
  type LanSyncServerStatus,
} from '../../shared/lan-sync/protocol'

/** SSE 心跳间隔：防止手机浏览器/中间设备把长连接掐掉。 */
const SSE_PING_INTERVAL_MS = 15_000

/** 最大请求体（配对请求很小，这里只是防滥用）。 */
const MAX_REQUEST_BODY_BYTES = 64 * 1024

/**
 * 手机页面（http://<PC>:1212）与同步服务（http://<PC>:17878）不同源，
 * 所以必须放开 CORS，否则 fetch / EventSource 会被浏览器直接拦掉。
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '600',
}

function listLanUrls(port: number): string[] {
  const urls: string[] = []
  const interfaces = networkInterfaces()
  Object.values(interfaces).forEach((list) => {
    ;(list || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${port}`)
      }
    })
  })
  return urls
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let text = ''
  for await (const chunk of req) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
    if (text.length > MAX_REQUEST_BODY_BYTES) return null
  }
  if (!text) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 局域网同步服务端：纯 node:http，零第三方依赖（仓库没有 ws/socket.io/bonjour）。
 *
 * 它只做「哑管道」：
 * - renderer 算好同步包（清单 + 原样 store 键值对）通过 IPC 送来，这里缓存。
 * - 手机连上来后 GET /lan-sync/package 取走整个包，或订阅 /lan-sync/events 等推送。
 */
export class LanSyncServer {
  private server: http.Server | null = null
  private port = 0
  private deviceName = 'Chatbox'
  private pairingCode = ''
  private token = ''
  private pkg: LanSyncPackage | null = null
  private readonly sseClients = new Set<ServerResponse>()
  private pingTimer: NodeJS.Timeout | null = null
  /**
   * 第 20 轮：手机端转发过来的用户消息的处理钩子。由 IPC 层注入
   * （把消息推给 renderer 真正发送）。没注入时 /lan-sync/forward 直接 503。
   */
  private onForward: ((message: LanSyncForwardedMessage) => void) | null = null

  /** 注入「手机端转发消息」的处理钩子（第 20 轮，需求 2）。 */
  setForwardHandler(handler: (message: LanSyncForwardedMessage) => void): void {
    this.onForward = handler
  }

  isRunning(): boolean {
    return this.server !== null
  }

  /**
   * 起服务；已运行则先停。端口占用等错误会抛出，由 IPC 层转成 {ok:false}。
   *
   * `credentials` 由主进程从 electron-store 读出来（需求 5：配对码 / 令牌跨重启不变，
   * 手机端才能自动重连）。不传就沿用旧的「每次现生成一对」行为（单测用）。
   */
  async start(
    port: number,
    deviceName: string,
    credentials?: { pairingCode: string; token: string }
  ): Promise<LanSyncServerStatus> {
    this.stop()
    this.port = port
    this.deviceName = deviceName || 'Chatbox'
    if (credentials?.pairingCode && credentials?.token) {
      this.pairingCode = credentials.pairingCode
      this.token = credentials.token
    } else {
      this.pairingCode = String(randomInt(0, 1_000_000)).padStart(6, '0')
      this.token = randomBytes(24).toString('hex')
    }

    const server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(() => {
        if (res.headersSent) {
          res.end()
        } else {
          sendJson(res, 500, { ok: false, error: 'internal error' })
        }
      })
    })
    this.server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '0.0.0.0')
    })

    return this.status()
  }

  stop(): void {
    this.sseClients.forEach((client) => {
      try {
        client.end()
      } catch {
        // 连接可能已被对端关闭，忽略
      }
    })
    this.sseClients.clear()
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    const server = this.server
    this.server = null
    if (server) {
      try {
        server.close()
      } catch {
        // 忽略关闭异常
      }
    }
    this.pkg = null
    this.pairingCode = ''
    this.token = ''
  }

  /**
   * 换一对配对码 + 令牌（需求 5 的「重新生成配对码 / 解除配对」）。
   * 已在线的手机还拿着旧令牌，直接断开并通知，逼它用新配对码重新配对。
   */
  setCredentials(credentials: { pairingCode: string; token: string }): void {
    this.pairingCode = credentials.pairingCode
    this.token = credentials.token
    this.sseClients.forEach((client) => {
      try {
        client.write(`event: revoke\ndata: ${JSON.stringify({ reason: 'pairing-code-rotated' })}\n\n`)
        client.end()
      } catch {
        // 连接可能已被对端关闭，忽略
      }
    })
    this.sseClients.clear()
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  /** 缓存一份同步包，并沿 SSE 通知所有在线手机「有新包了」。 */
  publish(input: {
    mode: 'full' | 'incremental'
    manifest: LanSyncManifest
    entries: Record<string, unknown>
    batchId: string
  }): LanSyncPackage {
    const pkg: LanSyncPackage = {
      protocolVersion: LAN_SYNC_PROTOCOL_VERSION,
      batchId: input.batchId,
      deviceName: this.deviceName,
      generatedAt: Date.now(),
      mode: input.mode,
      manifest: input.manifest,
      entries: input.entries,
      sessionCount: input.manifest.sessions.length,
      bytes: Buffer.byteLength(JSON.stringify(input.entries), 'utf8'),
    }
    this.pkg = pkg
    const notice = JSON.stringify({
      type: 'package',
      batchId: pkg.batchId,
      mode: pkg.mode,
      sessionCount: pkg.sessionCount,
      generatedAt: pkg.generatedAt,
    })
    this.sseClients.forEach((client) => {
      try {
        client.write(`event: package\ndata: ${notice}\n\n`)
      } catch {
        // 客户端可能已断开
      }
    })
    return pkg
  }

  status(): LanSyncServerStatus {
    return {
      running: this.isRunning(),
      port: this.port,
      urls: this.isRunning() ? listLanUrls(this.port) : [],
      deviceName: this.deviceName,
      pairingCode: this.pairingCode,
      connectedClients: this.sseClients.size,
      hasPackage: this.pkg !== null,
      lastBatchId: this.pkg?.batchId,
      lastBatchMode: this.pkg?.mode,
      lastPublishAt: this.pkg?.generatedAt,
      lastSessionCount: this.pkg?.sessionCount,
      lastBytes: this.pkg?.bytes,
    }
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization || ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    // EventSource 不能自定义请求头，所以 SSE 用 query 传 token。
    const query = url.searchParams.get('token') || ''
    const provided = bearer || query
    return provided.length > 0 && provided === this.token
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://lan-sync.local')
    Object.entries(CORS_HEADERS).forEach(([key, value]) => {
      res.setHeader(key, value)
    })

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === LanSyncHttpPath.Info && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        deviceName: this.deviceName,
        protocolVersion: LAN_SYNC_PROTOCOL_VERSION,
        requiresPairing: true,
      })
      return
    }

    if (url.pathname === LanSyncHttpPath.Handshake && req.method === 'POST') {
      const body = await readJsonBody(req)
      const code = typeof body?.code === 'string' ? body.code.trim() : ''
      if (!code || code !== this.pairingCode) {
        sendJson(res, 401, { ok: false, error: '配对码不正确' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        token: this.token,
        deviceName: this.deviceName,
        protocolVersion: LAN_SYNC_PROTOCOL_VERSION,
      })
      return
    }

    if (!this.isAuthorized(req, url)) {
      sendJson(res, 401, { ok: false, error: '未配对或令牌失效' })
      return
    }

    if (url.pathname === LanSyncHttpPath.Forward && req.method === 'POST') {
      const body = await readJsonBody(req)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      const text = typeof body?.text === 'string' ? body.text : ''
      if (!sessionId || !text.trim()) {
        sendJson(res, 400, { ok: false, error: '消息内容为空' })
        return
      }
      if (!this.onForward) {
        sendJson(res, 503, { ok: false, error: '电脑端未就绪' })
        return
      }
      // 只是把消息交给 renderer，这一步不等它回复（回复靠随后的包同步回到手机）。
      this.onForward({ sessionId, text, at: Date.now() })
      sendJson(res, 200, { ok: true })
      return
    }

    if (url.pathname === LanSyncHttpPath.Package && req.method === 'GET') {
      if (!this.pkg) {
        sendJson(res, 404, { ok: false, error: '电脑端还没有推送过数据' })
        return
      }
      sendJson(res, 200, { ok: true, package: this.pkg })
      return
    }

    if (url.pathname === LanSyncHttpPath.Events && req.method === 'GET') {
      res.writeHead(200, {
        ...CORS_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      res.write(
        `event: ready\ndata: ${JSON.stringify({
          deviceName: this.deviceName,
          hasPackage: this.pkg !== null,
        })}\n\n`,
      )
      this.sseClients.add(res)
      if (!this.pingTimer) {
        this.pingTimer = setInterval(() => {
          this.sseClients.forEach((client) => {
            try {
              client.write(': ping\n\n')
            } catch {
              // 忽略
            }
          })
        }, SSE_PING_INTERVAL_MS)
      }
      req.on('close', () => {
        this.sseClients.delete(res)
        if (this.sseClients.size === 0 && this.pingTimer) {
          clearInterval(this.pingTimer)
          this.pingTimer = null
        }
      })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }
}
