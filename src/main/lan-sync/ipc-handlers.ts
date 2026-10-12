import { app, BrowserWindow, ipcMain } from 'electron'
import { hostname } from 'node:os'
import {
  LAN_SYNC_DEFAULT_PORT,
  LanSyncIpcChannel,
  LanSyncPushChannel,
  type LanSyncManifest,
  type LanSyncPublishResult,
  type LanSyncStartResult,
} from '../../shared/lan-sync/protocol'
import { LanSyncServer } from './server'
import { loadOrCreateCredentials, rotateCredentials } from './credentials'

let server: LanSyncServer | null = null

function getServer(): LanSyncServer {
  if (!server) {
    server = new LanSyncServer()
    // 第 20 轮（需求 2）：手机端在「电脑端会话」里输入的消息转发回来后，
    // 主进程没有「主动让 renderer 干活」的 invoke 通道，只能用单向 push 通知。
    server.setForwardHandler((message) => {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send(LanSyncPushChannel.ForwardedMessage, message)
        }
      })
    })
  }
  return server
}

/**
 * 注册局域网同步的 IPC 主进程侧 handler。
 *
 * 会话数据不在这里读取：桌面端的会话存在 renderer 侧（localforage/IndexedDB），
 * 主进程的 electron-store 只有 configs/settings/configVersion。
 * 所以 renderer 负责算包，主进程只负责缓存 + 对外服务。
 */
export function registerLanSyncHandlers(): void {
  ipcMain.handle(
    LanSyncIpcChannel.Start,
    async (_event, payload: { port?: number; deviceName?: string } | undefined): Promise<LanSyncStartResult> => {
      try {
        const requested = Number(payload?.port)
        const port = Number.isFinite(requested) && requested > 0 ? requested : LAN_SYNC_DEFAULT_PORT
        const deviceName = payload?.deviceName || hostname() || 'Chatbox'
        // 需求 5：配对码 / 令牌从磁盘读（没有才现生成），重启后手机不用再配对。
        const credentials = loadOrCreateCredentials()
        const status = await getServer().start(port, deviceName, credentials)
        return { ok: true, status }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(LanSyncIpcChannel.Stop, (): LanSyncStartResult => {
    getServer().stop()
    return { ok: true, status: getServer().status() }
  })

  ipcMain.handle(LanSyncIpcChannel.Status, () => getServer().status())

  // 需求 5 配套：换手机 / 解除配对 -> 换一对新凭证，旧手机立刻被踢。
  ipcMain.handle(LanSyncIpcChannel.Rotate, (): LanSyncStartResult => {
    const credentials = rotateCredentials()
    const current = getServer()
    current.setCredentials(credentials)
    return { ok: true, status: current.status() }
  })

  ipcMain.handle(
    LanSyncIpcChannel.Publish,
    (
      _event,
      payload: {
        mode: 'full' | 'incremental'
        manifest: LanSyncManifest
        entries: Record<string, unknown>
      },
    ): LanSyncPublishResult => {
      const current = getServer()
      if (!current.isRunning()) {
        return { ok: false, error: '同步服务未启动' }
      }
      if (!payload?.manifest || !payload?.entries) {
        return { ok: false, error: '推送数据不完整' }
      }
      const pkg = current.publish({
        mode: payload.mode === 'full' ? 'full' : 'incremental',
        manifest: payload.manifest,
        entries: payload.entries,
        batchId: `b${Date.now().toString(36)}`,
      })
      return {
        ok: true,
        batchId: pkg.batchId,
        mode: pkg.mode,
        sessionCount: pkg.sessionCount,
        bytes: pkg.bytes,
      }
    },
  )

  app.on('before-quit', () => {
    server?.stop()
  })
}

export function stopLanSyncServer(): void {
  server?.stop()
}
