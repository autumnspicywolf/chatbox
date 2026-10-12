/**
 * 局域网同步「自动同步倒计时圈」的进度计算（第 24 轮）。
 *
 * 桌面端每 LAN_SYNC_AUTO_SYNC_MS（3s）检查一次「有没有改动要推给手机」，
 * 侧边栏的「手机已连接」左侧据此画一个扇形圆圈：圈走满 → 自动同步开跑。
 *
 * 第 28 轮把间隔从 30s 改成 3s 后，这个圈变成了一次「心跳」——每 3 秒快速转满一圈，
 * 圆心秒数在 3→1 之间跳。它仍然是有意义的：圈在转 = 自动同步确实在跑；
 * 颜色变警示 = 还有改动没推上去。
 *
 * 单独拆成纯函数（零 import、不碰 DOM / store）是为了能直接单测边界：
 * 刚重置、过半、到点、定时器晚了几毫秒、间隔参数非法。
 */
export interface LanSyncRingProgress {
  /** 圈中心显示的剩余整秒数（向上取整，到点后为 0）。 */
  seconds: number
  /** 已转过的比例 0~1：0 = 刚重置，1 = 转满（此刻该同步了）。 */
  progress: number
}

export function lanSyncRingProgress(
  nextSyncAt: number | null,
  options: { now?: number; intervalMs: number }
): LanSyncRingProgress {
  const { now = Date.now(), intervalMs } = options
  if (nextSyncAt == null || !Number.isFinite(nextSyncAt) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    // 没有在跑的自动同步（非桌面端 / 还没启动）：给个「满圈」的静态样子，不除零。
    return { seconds: Math.max(0, Math.ceil((Number.isFinite(intervalMs) ? intervalMs : 0) / 1000)), progress: 0 }
  }
  const remaining = Math.max(0, nextSyncAt - now)
  const progress = Math.min(1, Math.max(0, 1 - remaining / intervalMs))
  return { seconds: Math.ceil(remaining / 1000), progress }
}
