/**
 * 局域网同步设置面板（第 15 轮：挂到左侧导航「LAN Sync」独立入口）。
 *
 * 桌面端（platform.type === 'desktop'）当服务端：启动/停止 17878 上的同步服务、显示地址与配对码、一键推送。
 * Web / 手机端当客户端：填电脑地址 + 配对码，连接后自动接收推送并落地。
 *
 * 第 18 轮（交互优化）：
 * - 客户端 token 从 sessionStorage 改存 localStorage（需求 4/5 的前提：电脑重启后令牌不变、手机可自动重连）。
 * - 挂载时若有 token 就静默自动重连；令牌被踢（401）时自动退回「需要配对」。
 * - 同步落地后失效查询缓存（需求 3）：当前打开的对话立刻刷新，没打开的切过去时也是最新。
 * - 桌面端新增「重新生成配对码」（需求 5 的换手机 / 解除配对）。
 *
 * 第 19 轮（连接生命周期修正）：
 * - 客户端的 SSE 连接 + 自动重连从本面板搬到 @/stores/lan-sync-client，由 index.tsx 在应用启动时初始化：
 *   只要页面开着就保持连接，不再「切走设置页 / 关掉页面就掉线、电脑端立刻显示 0 台」。
 * - 本面板退化为纯 UI（只读 store 状态 + 触发手动连接 / 断开 / 重新配对）。
 *
 * 挂载点：src/renderer/routes/settings/lan-sync.tsx
 */
import { Alert, Box, Button, Divider, Stack, TextField, Typography } from '@mui/material'
import {
  LAN_SYNC_DEFAULT_PORT,
  LanSyncIpcChannel,
  type LanSyncPublishResult,
  type LanSyncServerStatus,
  type LanSyncStartResult,
} from '@shared/lan-sync/protocol'
import { useCallback, useEffect, useState } from 'react'
import {
  connectLanSyncClient,
  defaultClientBaseUrl,
  disconnectLanSyncClient,
  rePairLanSyncClient,
  setLanSyncClientBaseUrl,
  useLanSyncClientState,
} from '@/stores/lan-sync-client'
import {
  buildLanSyncPackage,
  clearLanSyncManifest,
  commitLanSyncManifest,
  readBaselineCount,
} from '@/packages/lan-sync/package-builder'
import platform from '@/platform'

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleTimeString()
}

async function invokeLanSync<T>(channel: string, payload?: unknown): Promise<T> {
  const api = window.electronAPI
  if (!api?.invoke) {
    throw new Error('当前环境没有桌面端 IPC')
  }
  return (await api.invoke(channel, payload)) as T
}

/** ---------- 桌面端：当服务端 ---------- */

function DesktopPanel() {
  const [status, setStatus] = useState<LanSyncServerStatus | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [baseline, setBaseline] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const next = await invokeLanSync<LanSyncServerStatus>(LanSyncIpcChannel.Status)
      setStatus(next)
    } catch {
      // 忽略轮询失败
    }
  }, [])

  useEffect(() => {
    setBaseline(readBaselineCount())
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 3000)
    return () => clearInterval(timer)
  }, [refresh])

  const handleStart = async () => {
    setBusy('start')
    setNotice(null)
    try {
      const result = await invokeLanSync<LanSyncStartResult>(LanSyncIpcChannel.Start, {
        port: LAN_SYNC_DEFAULT_PORT,
      })
      if (!result.ok) throw new Error(result.error || '启动失败')
      setStatus(result.status || null)
      setNotice({ type: 'success', text: '同步服务已启动，请在手机上打开设置里的同一个面板' })
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
    }
  }

  const handleStop = async () => {
    setBusy('stop')
    try {
      const result = await invokeLanSync<LanSyncStartResult>(LanSyncIpcChannel.Stop)
      setStatus(result.status || null)
      setNotice({ type: 'info', text: '同步服务已停止' })
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
    }
  }

  // 需求 5 配套：换手机 / 解除配对。换完旧手机立刻被踢，必须用新配对码重新配对。
  const handleRotate = async () => {
    if (!window.confirm('重新生成配对码后，已配对的手机需要重新输入新配对码才能连上。确定继续？')) return
    setBusy('rotate')
    setNotice(null)
    try {
      const result = await invokeLanSync<LanSyncStartResult>(LanSyncIpcChannel.Rotate)
      setStatus(result.status || null)
      setNotice({ type: 'success', text: '已生成新的配对码，旧手机已断开，请用新配对码重新连接' })
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
    }
  }

  const handlePush = async (mode: 'full' | 'incremental') => {
    setBusy(mode)
    setNotice(null)
    try {
      const built = await buildLanSyncPackage({ mode, deviceName: status?.deviceName || 'Chatbox' })
      if (built.unchanged) {
        setNotice({ type: 'info', text: `没有检测到变化（${built.sessionCount} 个会话都是最新的）` })
        return
      }
      const result = await invokeLanSync<LanSyncPublishResult>(LanSyncIpcChannel.Publish, {
        mode: built.mode,
        manifest: built.manifest,
        entries: built.entries,
      })
      if (!result.ok) throw new Error(result.error || '推送失败')
      commitLanSyncManifest(built.manifest)
      setBaseline(readBaselineCount())
      setNotice({
        type: 'success',
        text: `已推送：${result.sessionCount} 个会话，本次带${mode === 'full' ? '全量' : `上 ${built.changedCount} 个变化`}，${formatBytes(result.bytes || 0)}`,
      })
      await refresh()
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
    }
  }

  const running = status?.running === true

  return (
    <Stack spacing={1.5}>
      <Alert severity="info">
        在电脑上启动同步服务，手机（浏览器/App）连到同一个 Wi-Fi 后即可一键把会话推过去。第一版只同步会话，不动设置与
        API Key。
      </Alert>

      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2">服务状态：</Typography>
        <Typography variant="body2" fontWeight={600} color={running ? 'success.main' : 'text.secondary'}>
          {running ? `运行中（端口 ${status?.port}）` : '未启动'}
        </Typography>
        <Box flex="1" />
        {running ? (
          <Button size="small" variant="outlined" disabled={busy !== ''} onClick={handleStop}>
            停止服务
          </Button>
        ) : (
          <Button size="small" variant="contained" disabled={busy !== ''} onClick={handleStart}>
            启动服务
          </Button>
        )}
      </Stack>

      {running && (
        <>
          <Box>
            <Typography variant="body2" color="text.secondary">
              手机浏览器打开（或把地址填进手机端面板）：
            </Typography>
            {(status?.urls || []).map((url) => (
              <Typography key={url} variant="body2" fontFamily="monospace" sx={{ userSelect: 'all' }}>
                {url}
              </Typography>
            ))}
            {(status?.urls || []).length === 0 && (
              <Typography variant="body2" color="warning.main">
                没找到局域网 IPv4 地址，请检查网络连接
              </Typography>
            )}
          </Box>

          <Box>
            <Typography variant="body2" color="text.secondary">
              配对码（手机端首次连接要输入）
            </Typography>
            <Typography variant="h5" fontFamily="monospace" letterSpacing={4}>
              {status?.pairingCode || '------'}
            </Typography>
          </Box>

          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" color="text.secondary">
              已连接设备：{status?.connectedClients ?? 0} 台
            </Typography>
            <Box flex="1" />
            <Button size="small" variant="text" disabled={busy !== ''} onClick={handleRotate}>
              重新生成配对码
            </Button>
          </Stack>
        </>
      )}

      <Divider />

      <Stack direction="row" spacing={1} flexWrap="wrap">
        <Button
          size="small"
          variant="contained"
          disabled={!running || busy !== ''}
          onClick={() => handlePush('incremental')}
        >
          {busy === 'incremental' ? '推送中…' : '一键推送（增量）'}
        </Button>
        <Button size="small" variant="outlined" disabled={!running || busy !== ''} onClick={() => handlePush('full')}>
          {busy === 'full' ? '推送中…' : '推送全量'}
        </Button>
        <Button
          size="small"
          variant="text"
          disabled={busy !== ''}
          onClick={() => {
            clearLanSyncManifest()
            setBaseline(0)
            setNotice({ type: 'info', text: '增量基准已清空，下次增推送会当作全新变化' })
          }}
        >
          重置增量基准
        </Button>
      </Stack>

      <Typography variant="caption" color="text.secondary">
        上次推送：{formatTime(status?.lastPublishAt)} · {status?.lastSessionCount ?? 0} 个会话 ·{' '}
        {formatBytes(status?.lastBytes || 0)} · 增量基准 {baseline} 个会话
      </Typography>

      {notice && <Alert severity={notice.type}>{notice.text}</Alert>}
    </Stack>
  )
}

/** ---------- Web / 手机端：当客户端（第 19 轮起，连接逻辑全部搬到 @/stores/lan-sync-client） ---------- */

function ClientPanel() {
  const baseUrl = useLanSyncClientState((state) => state.baseUrl)
  const token = useLanSyncClientState((state) => state.token)
  const peerName = useLanSyncClientState((state) => state.peerName)
  const connected = useLanSyncClientState((state) => state.connected)
  const connecting = useLanSyncClientState((state) => state.connecting)
  const record = useLanSyncClientState((state) => state.record)
  const notice = useLanSyncClientState((state) => state.notice)
  const [code, setCode] = useState('')
  const defaultUrl = defaultClientBaseUrl()

  const handleConnect = () => {
    void connectLanSyncClient({ baseUrl, code })
  }

  return (
    <Stack spacing={1.5}>
      <Alert severity="info">
        在电脑端设置里打开「局域网同步」并点「启动服务」，然后在这里填入电脑的地址与配对码。连接后电脑一推，这边会自动落地。
      </Alert>

      <TextField
        size="small"
        label="电脑端地址"
        placeholder={`${defaultUrl}`}
        value={baseUrl}
        onChange={(event) => setLanSyncClientBaseUrl(event.target.value)}
        disabled={connected}
        fullWidth
      />
      <TextField
        size="small"
        label="配对码"
        placeholder="6 位数字"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        disabled={connected || token !== ''}
        fullWidth
        helperText={token ? '本机已配对，直接点连接即可' : undefined}
      />

      <Stack direction="row" spacing={1} flexWrap="wrap">
        {connected ? (
          <Button size="small" variant="outlined" onClick={() => disconnectLanSyncClient()}>
            断开
          </Button>
        ) : (
          <Button size="small" variant="contained" disabled={connecting} onClick={handleConnect}>
            {connecting ? '连接中…' : '连接电脑端'}
          </Button>
        )}
        {token !== '' && !connected && (
          <Button size="small" variant="text" onClick={() => rePairLanSyncClient()}>
            重新配对
          </Button>
        )}
        {record && (
          <Button size="small" variant="text" onClick={() => window.location.reload()}>
            刷新页面
          </Button>
        )}
      </Stack>

      {connected ? (
        <Typography variant="body2" color="success.main">
          已连接：{peerName || '电脑端'}（实时连接中）
        </Typography>
      ) : connecting ? (
        <Typography variant="body2" color="text.secondary">
          正在连接电脑端…
        </Typography>
      ) : null}

      {record && (
        <Typography variant="caption" color="text.secondary">
          最近同步：{new Date(record.at).toLocaleTimeString()} · {record.deviceName} ·{' '}
          {record.mode === 'full' ? '全量' : '增量'} · {record.sessions} 个会话 / {record.written} 项
        </Typography>
      )}

      {notice && <Alert severity={notice.type}>{notice.text}</Alert>}
    </Stack>
  )
}

export default function LanSyncSetting() {
  const isServerSide = platform.type === 'desktop'
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {isServerSide
          ? '把本机作为同步服务端，向同一局域网内的手机推送会话数据。'
          : '把本机作为接收端，从电脑端拉取并覆盖会话数据。'}
      </Typography>
      {isServerSide ? <DesktopPanel /> : <ClientPanel />}
    </Box>
  )
}
