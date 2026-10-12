import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor config — created locally so `cap add android` / `cap sync android` work.
 *
 * The upstream chatboxai/chatbox repo (v1.23.5) does NOT ship this file nor the
 * native android/ project. webDir matches the renderer production output
 * (see electron.vite.config.ts -> renderer.build.outDir = 'release/app/dist/renderer').
 */
const config: CapacitorConfig = {
  appId: 'xyz.chatboxapp.chatbox',
  appName: 'Chatbox',
  webDir: 'release/app/dist/renderer',
  android: {
    // Android 15+ 强制 edge-to-edge（本工程 targetSdk 35）：网页内容会顶到状态栏下面，
    // 造成顶部返回按钮与状态栏重叠、点不到。
    // 'auto' = 由 Capacitor 自动给 WebView 补上系统栏边距（官方为这个场景提供的开关）。
    adjustMarginsForEdgeToEdge: 'auto',
    // 局域网同步：APK 里的页面 origin 是 https://localhost（Capacitor 默认 androidScheme=https），
    // 而电脑端同步服务是 http://192.168.x.x:17878。https 页面 fetch http:// 会被 WebView
    // 按「混合内容」拦掉（Bridge.java:592 只在 allowMixedContent=true 时才设 MIXED_CONTENT_ALWAYS_ALLOW），
    // 表现就是设置里连接电脑端时报「Failed to fetch」。
    allowMixedContent: true,
  },
}

export default config
