import { randomBytes, randomInt } from 'node:crypto'
import Store from 'electron-store'
import type { LanSyncCredentials } from '../../shared/lan-sync/protocol'

/**
 * 局域网同步的配对凭证持久化（需求 5：配对码一次配对成功后不再变）。
 *
 * 为什么必须落盘：
 * - 配对码不变 → 手机端配对一次即可，不用每次重输。
 * - 令牌（token）持久化 → 手机端把 token 存 localStorage 后，**电脑重启服务也还能用**
 *   （需求 4 的自动重连前提）。第一版 token 存在内存里，`stop()` 就没了，重启必变。
 *
 * 存放位置：`<userData>/lan-sync.json`（electron-store 的 name 就是文件名）。
 * 内网明文，可接受；换手机走「重新生成配对码」，见 rotateCredentials()。
 */

interface LanSyncStoreShape {
  credentials?: LanSyncCredentials
}

/** 懒加载：`new Store()` 在 app ready 之前调用也能拿到 userData 路径，但没必要过早建。 */
let store: Store<LanSyncStoreShape> | null = null

function getStore(): Store<LanSyncStoreShape> {
  if (!store) {
    store = new Store<LanSyncStoreShape>({ name: 'lan-sync', clearInvalidConfig: true })
  }
  return store
}

function generateCredentials(): LanSyncCredentials {
  return {
    pairingCode: String(randomInt(0, 1_000_000)).padStart(6, '0'),
    token: randomBytes(24).toString('hex'),
  }
}

function isValidCredentials(value: unknown): value is LanSyncCredentials {
  const candidate = value as LanSyncCredentials | undefined
  if (!candidate || typeof candidate !== 'object') return false
  return (
    typeof candidate.pairingCode === 'string' &&
    /^\d{6}$/.test(candidate.pairingCode) &&
    typeof candidate.token === 'string' &&
    candidate.token.length >= 16
  )
}

/** 读磁盘上的凭证；没有（或格式不对）就生成一对并写回。 */
export function loadOrCreateCredentials(): LanSyncCredentials {
  const current = getStore().get('credentials')
  if (isValidCredentials(current)) return current
  const created = generateCredentials()
  getStore().set('credentials', created)
  return created
}

/** 强制换一对新的配对码 + 令牌（旧的手机立即失效）。 */
export function rotateCredentials(): LanSyncCredentials {
  const created = generateCredentials()
  getStore().set('credentials', created)
  return created
}
