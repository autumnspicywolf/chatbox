// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { LanSyncServer } from '../main/lan-sync/server'

const BASE_PORT = 18999

/** 连 SSE 并收集事件名；返回关闭函数。 */
async function subscribeSse(url: string, events: string[]): Promise<() => void> {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  const body = response.body
  if (!body) throw new Error('no response body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() || ''
        for (const frame of frames) {
          const name = frame
            .split('\n')
            .find((line) => line.startsWith('event: '))
            ?.slice(7)
          if (name) events.push(name)
        }
      }
    } catch {
      // 主动 abort 时会进这里
    }
  })()

  return () => controller.abort()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('LanSyncServer', () => {
  let server: LanSyncServer | null = null

  afterEach(() => {
    server?.stop()
    server = null
  })

  it('握手 → 推送 → 拉取 → SSE 通知，全链路带鉴权与 CORS', async () => {
    const port = BASE_PORT
    const base = `http://127.0.0.1:${port}`
    server = new LanSyncServer()
    const status = await server.start(port, 'TestPC')

    expect(status.running).toBe(true)
    expect(status.pairingCode).toMatch(/^\d{6}$/)

    // info 不需要配对
    const infoResponse = await fetch(`${base}/lan-sync/info`)
    expect(infoResponse.status).toBe(200)
    expect(infoResponse.headers.get('access-control-allow-origin')).toBe('*')
    const info = (await infoResponse.json()) as { deviceName: string }
    expect(info.deviceName).toBe('TestPC')

    // 错误配对码 → 401
    const badResponse = await fetch(`${base}/lan-sync/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    })
    expect(badResponse.status).toBe(401)

    // 正确配对码 → 换到 token
    const goodResponse = await fetch(`${base}/lan-sync/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: status.pairingCode }),
    })
    const good = (await goodResponse.json()) as { ok: boolean; token: string }
    expect(good.ok).toBe(true)
    const token = good.token
    expect(token.length).toBeGreaterThan(16)

    // 没有 token 拉数据 → 401
    expect((await fetch(`${base}/lan-sync/package`)).status).toBe(401)

    // 还没推送过 → 404
    expect((await fetch(`${base}/lan-sync/package`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(
      404,
    )

    // 订阅推送
    const events: string[] = []
    const close = await subscribeSse(`${base}/lan-sync/events?token=${token}`, events)
    await delay(120)
    expect(events).toContain('ready')

    // 推送一批数据
    const pkg = server.publish({
      mode: 'full',
      batchId: 'b-test',
      manifest: {
        deviceName: 'TestPC',
        generatedAt: Date.now(),
        sessions: [{ id: 's1', name: '会话一', fingerprint: 'abcdef0123456789' }],
      },
      entries: { 'session:s1': { id: 's1', name: '会话一' }, 'chat-sessions-list': ['s1'] },
    })
    expect(pkg.sessionCount).toBe(1)

    await delay(150)
    expect(events).toContain('package')

    // 手机端拉取
    const pkgResponse = await fetch(`${base}/lan-sync/package`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(pkgResponse.status).toBe(200)
    const payload = (await pkgResponse.json()) as {
      package: { entries: Record<string, unknown>; mode: string; sessionCount: number }
    }
    expect(payload.package.mode).toBe('full')
    expect(payload.package.sessionCount).toBe(1)
    expect(payload.package.entries['session:s1']).toEqual({ id: 's1', name: '会话一' })

    close()
  })

  it('持久化凭证：start 沿用传入的配对码 / 令牌，setCredentials 踢掉旧手机', async () => {
    const port = BASE_PORT + 2
    const base = `http://127.0.0.1:${port}`
    const credentials = { pairingCode: '123456', token: 'a'.repeat(48) }
    const srv = new LanSyncServer()
    server = srv
    const status = await srv.start(port, 'TestPC', credentials)
    // 需求 5：配对码不是现生成的，而是磁盘上那一个
    expect(status.pairingCode).toBe('123456')

    // 用持久化配对码握手，拿到的还是同一个 token
    const handshake = await fetch(`${base}/lan-sync/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    })
    expect(handshake.status).toBe(200)
    const hand = (await handshake.json()) as { token: string }
    expect(hand.token).toBe(credentials.token)

    // 持久化 token 可用
    expect(
      (await fetch(`${base}/lan-sync/package`, { headers: { authorization: `Bearer ${credentials.token}` } }))
        .status,
    ).toBe(404)

    const events: string[] = []
    const close = await subscribeSse(`${base}/lan-sync/events?token=${credentials.token}`, events)
    await delay(120)
    expect(events).toContain('ready')
    expect(srv.status().connectedClients).toBe(1)

    // 轮换：旧手机被踢、收到 revoke，旧 token 立刻失效
    const rotated = { pairingCode: '654321', token: 'b'.repeat(48) }
    srv.setCredentials(rotated)
    await delay(150)
    expect(events).toContain('revoke')
    expect(srv.status().pairingCode).toBe('654321')
    expect(srv.status().connectedClients).toBe(0)
    expect(
      (await fetch(`${base}/lan-sync/package`, { headers: { authorization: `Bearer ${credentials.token}` } }))
        .status,
    ).toBe(401)
    expect(
      (await fetch(`${base}/lan-sync/package`, { headers: { authorization: `Bearer ${rotated.token}` } })).status,
    ).toBe(404)
    close()
  })

  it('转发（第 20 轮）：未配对 401、无处理器 503、空文本 400、正常 200 并回调', async () => {
    const port = BASE_PORT + 3
    const base = `http://127.0.0.1:${port}`
    const credentials = { pairingCode: '112233', token: 'f'.repeat(48) }
    server = new LanSyncServer()
    await server.start(port, 'TestPC', credentials)

    const body = JSON.stringify({ sessionId: 's1', text: '帮我在电脑上查一下' })

    // 没带 token → 401
    expect(
      (
        await fetch(`${base}/lan-sync/forward`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(401)

    // 带了 token 但还没注入处理器（renderer 未就绪）→ 503
    expect(
      (
        await fetch(`${base}/lan-sync/forward`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.token}` },
          body,
        })
      ).status,
    ).toBe(503)

    const received: { sessionId: string; text: string }[] = []
    server.setForwardHandler((message) => received.push({ sessionId: message.sessionId, text: message.text }))

    // 空文本 → 400
    expect(
      (
        await fetch(`${base}/lan-sync/forward`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.token}` },
          body: JSON.stringify({ sessionId: 's1', text: '   ' }),
        })
      ).status,
    ).toBe(400)

    const okResponse = await fetch(`${base}/lan-sync/forward`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.token}` },
      body,
    })
    expect(okResponse.status).toBe(200)
    expect((await okResponse.json()) as { ok: boolean }).toEqual({ ok: true })
    expect(received).toEqual([{ sessionId: 's1', text: '帮我在电脑上查一下' }])
  })

  it('stop 后端口释放、状态复位', async () => {
    const port = BASE_PORT + 1
    server = new LanSyncServer()
    await server.start(port, 'TestPC')
    expect(server.isRunning()).toBe(true)

    server.stop()
    expect(server.isRunning()).toBe(false)
    expect(server.status().pairingCode).toBe('')

    // 端口应已释放：能再次监听同一端口
    const again = new LanSyncServer()
    await expect(again.start(port, 'TestPC2')).resolves.toBeTruthy()
    again.stop()
  })
})
