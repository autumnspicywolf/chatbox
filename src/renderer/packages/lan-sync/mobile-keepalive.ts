import { registerPlugin } from '@capacitor/core'
import { Haptics } from '@capacitor/haptics'
import { Toast } from '@capacitor/toast'
import platform from '@/platform'

/**
 * 第 23 轮：Android 端的「局域网同步保活 + 通知」桥。
 *
 * 背景：Capacitor 的 KeepRunning 默认为 true，所以 App 切后台后 WebView 的 JS 定时器与
 * EventSource(SSE) 并不会被暂停；但只要进程被降级成 cached 进程就会被系统冻结/回收，
 * 连接随即断掉。这里的做法是挂一个 Android 前台服务把进程钉住，JS 侧的同步逻辑
 * （含「该不该提醒」的判断）一行都不用改。
 *
 * 前台服务与通知都在原生侧实现（android/app/src/main/java/.../LanSyncNotifyPlugin.java），
 * 通过 registerPlugin 直接用，**不需要新增 npm / Gradle 依赖**。
 *
 * 桌面端 / Web 端：所有函数都是 no-op，行为与改动前完全一致（只在移动端生效）。
 */

interface LanSyncNotifyPlugin {
  startKeepAlive(options: { baseUrl?: string }): Promise<{ running?: boolean }>
  stopKeepAlive(): Promise<{ running?: boolean }>
  isKeepAliveRunning(): Promise<{ running?: boolean }>
  notifyTask(options: { title?: string; body?: string }): Promise<void>
  requestNotificationPermission(): Promise<{ granted?: boolean }>
  markSynced(options: { batchId?: string }): Promise<void>
}

const LanSyncNotify = registerPlugin<LanSyncNotifyPlugin>('LanSyncNotify')

const LOG_PREFIX = '[lan-sync]'

/** 只有移动端（Android APK）才有原生侧实现。 */
export function isLanSyncKeepAliveAvailable(): boolean {
  return platform.type === 'mobile'
}

/**
 * 拉起前台保活服务（幂等：已在跑时重复调用不会叠加）。
 * 返回是否成功拉起；调用方不要因为 false 就中断同步——保活失败只影响后台存活时间。
 */
export async function startLanSyncKeepAlive(baseUrl?: string): Promise<boolean> {
  if (!isLanSyncKeepAliveAvailable()) {
    return false
  }
  try {
    // Android 13+ 需要 POST_NOTIFICATIONS 才能显示通知（含前台服务的常驻通知）。
    // 这里顺带申请一次；被拒也不影响保活本身，只是通知不显示。
    await LanSyncNotify.requestNotificationPermission().catch(() => undefined)
    // 第 25 轮：原生服务要自己轮询 /lan-sync/info，得先知道电脑端地址
    const result = await LanSyncNotify.startKeepAlive(baseUrl ? { baseUrl } : {})
    return result?.running !== false
  } catch (error) {
    console.warn(LOG_PREFIX, '启动前台保活服务失败（不影响前台同步）', error)
    return false
  }
}

/** 停止前台保活服务（用户主动断开同步 / 解除配对时调用）。 */
export async function stopLanSyncKeepAlive(): Promise<void> {
  if (!isLanSyncKeepAliveAvailable()) {
    return
  }
  try {
    await LanSyncNotify.stopKeepAlive()
  } catch (error) {
    console.warn(LOG_PREFIX, '停止前台保活服务失败', error)
  }
}

/**
 * 「工作模式任务完成」时的提醒分流。由 stores/task-complete-sound 调用。
 *
 * - 桌面端 / Web 端：直接响页面内的「叮咚」（行为不变）。
 * - Android 前台：页面就在眼前，响「叮咚」+ toast + 轻振动。
 * - Android 后台 / 锁屏：用户看不到页面内的反馈，改发系统通知——通知渠道自带系统提示音
 *   与振动（见原生 LanSyncNotifications）；通知发不出去（如权限被拒）时回退成「叮咚」。
 *
 * @param sessionName 触发提醒的会话名（可能为空）
 * @param playLocalSound 播放页面内提示音的回调（由调用方提供，避免反向依赖造成循环 import）
 */
/**
 * 第 25 轮：告知原生保活服务「这批已经同步下来了」。
 *
 * 原生侧会记下批次号并撤掉它自己发的「有新消息待同步」提醒；同时保证
 * 进程重启后不会对着同一批数据重复提醒。非 Android 平台是 no-op。
 */
export async function markLanSyncSynced(batchId: string | undefined): Promise<void> {
  if (!isLanSyncKeepAliveAvailable()) {
    return
  }
  if (!batchId) {
    return
  }
  try {
    await LanSyncNotify.markSynced({ batchId })
  } catch (error) {
    console.warn(LOG_PREFIX, '回写同步状态给原生失败', error)
  }
}

export async function announceLanSyncTaskComplete(sessionName: string, playLocalSound: () => void): Promise<void> {
  if (!isLanSyncKeepAliveAvailable()) {
    playLocalSound()
    return
  }

  const focused = await isAppInForeground()
  if (focused) {
    playLocalSound()
    await showForegroundFeedback(sessionName)
    return
  }

  const body = sessionName ? `${sessionName} · 电脑端已完成回复` : '电脑端已完成回复，点开查看'
  try {
    await LanSyncNotify.notifyTask({ title: '工作模式任务已完成', body })
  } catch (error) {
    console.warn(LOG_PREFIX, '发送系统通知失败，回退为页面内提示音', error)
    playLocalSound()
  }
}

async function isAppInForeground(): Promise<boolean> {
  try {
    return await platform.isWindowFocused()
  } catch {
    return true
  }
}

/** 前台（页面可见）时的轻量反馈：toast + 轻振动；都失败则静默。 */
async function showForegroundFeedback(sessionName: string): Promise<void> {
  const text = sessionName ? `${sessionName} · 工作模式任务已完成` : '工作模式任务已完成'
  await Toast.show({ text, duration: 'short' }).catch((error: unknown) => {
    console.warn(LOG_PREFIX, '显示 toast 失败', error)
  })
  await Haptics.vibrate({ duration: 40 }).catch((error: unknown) => {
    console.warn(LOG_PREFIX, '触发振动失败', error)
  })
}
