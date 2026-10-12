<p align="right">
  <a href="../README.md">English</a> |
  <a href="README-CN.md">简体中文</a>
</p>

这里是 Chatbox 社区版的代码仓库，以 GPLv3 许可证开源。

[Chatbox 再次开源！](https://github.com/chatboxai/chatbox/issues/2266)

我们定期从专业版仓库同步代码到这个仓库，反之亦然。

---

## 本仓库定制说明

> 本仓库是上游 [chatboxai/chatbox](https://github.com/chatboxai/chatbox) 的**个人自用 fork**（基线 v1.23.5，分支 `main`），加入了若干本地增强：**局域网同步**、**任务完成提示音**，以及一套 **Capacitor 自签名 Android 打包**链路。以下均为本 fork 相对上游的新增，与官方发行版无关。

### 1. 局域网同步（LAN Sync）

让**电脑端当服务端**、**手机端（或任意浏览器）当客户端**：把电脑上的会话同步到手机查看，也能在手机上把消息转发回电脑发送。

- **入口**：设置 → `LAN Sync`（左侧导航独立项，桌面端 / 手机端都有）。
- **默认端口**：`17878`（刻意避开 1212 vite dev server 与 8899 本地镜像代理）。
- **架构**：电脑端主进程起一个 HTTP + SSE 服务（监听 `0.0.0.0:17878`），主进程只当「哑管道」——起服务 + 缓存最近一次同步包，真正的会话数据仍由 renderer 的存储提供。
- **配对**：首次连接需在手机上填 `http://<电脑局域网IP>:17878` + **6 位配对码**（电脑端设置页显示，可「重新生成配对码」解除配对 / 换手机）。令牌存 localStorage，电脑重启后手机能自动重连。
- **推送方向**：
  - 电脑端把增量 / 全量包推给手机，手机收到后**原样落地**（包里就是 store 的键值对）。
  - 手机离线期间电脑端推的包会缓存，手机下次上线自动**补拉**一次补齐。
  - 电脑端侧边栏「关于」上方显示 **「手机已连接 / 等待手机连接」** + **「同步到手机」**按钮；服务在跑且有改动时每 30s 自动增量推送。
- **反向转发**：从电脑同步来的会话，在手机上发消息不会本地生成，而是**转发回电脑端**由它真正发送（这类会话可能依赖电脑端 MCP 等工具），电脑端跑完再把新包同步回来 —— 回来源的会话在列表里带一个 🖥 电脑图标。
- **相关代码**：`src/main/lan-sync/`（服务端）、`src/shared/lan-sync/protocol.ts`（协议）、`src/renderer/stores/lan-sync*.ts`（客户端 / 自动同步 / 来源标记）、`src/renderer/components/settings/lan-sync/`、`src/renderer/packages/lan-sync/`、`src/__tests__/lan-sync-server.test.ts`。

### 2. 任务完成提示音

- 工作模式（Work Mode）任务完成时，用 Web Audio **现场合成**一段「叮—咚」两音提示（不依赖任何音频文件，桌面端与手机端同一套代码）。
- **桌面端**：本地生成完成时响一次。
- **手机端**：局域网同步把「电脑端刚完成」的任务带回手机时响一次。
- **开关 & 时长**：设置 → 聊天 → 「任务完成时播放提示音」（默认开）+ 时长滑块（1–10 秒，默认 3 秒；每秒响一次，3 秒即连响三声）。
- **相关代码**：`src/renderer/stores/task-complete-sound.ts`；设置项 `soundOnTaskComplete` / `soundOnTaskCompleteDuration`（`packages/chatbox-core`）。

### 3. Android 自签名 APK（Capacitor）

本仓库自带用 Capacitor 生成的 `android/` 原生工程，可直接出**自签名（debug）APK** 自己安装使用（不碰官方签名 / 不上架）。

```powershell
# Windows 环境变量（按本机实际路径改）
$env:JAVA_HOME='C:\Users\<你>\.jdks\jdk-21'      # 需要 JDK 21
$env:ANDROID_HOME='C:\Android\sdk'; $env:ANDROID_SDK_ROOT='C:\Android\sdk'

# 1) 把 web 资源同步进 android/ 原生工程（= build:renderer + cap sync android）
pnpm run mobile:sync:android

# 2) 编译 debug 包
cd android
.\gradlew.bat assembleDebug --console=plain
# 产物：android\app\build\outputs\apk\debug\app-debug.apk
```

- 包名 `xyz.chatboxapp.chatbox`，minSdk 23，targetSdk / compileSdk 35。
- 相对上游，Android 侧做了两处适配：
  1. **edge-to-edge 遮挡**（Android 15 / targetSdk 35 强制全屏边到边，导致返回按钮被状态栏压住）→ `capacitor.config.ts` 加 `adjustMarginsForEdgeToEdge: 'auto'`，并给启动主题补背景色（`android/app/src/main/res/values/colors.xml`、`values-night/colors.xml`）。
  2. **局域网同步报 `Failed to fetch`**（两层拦截）→ ① APK 内页面 origin 是 `https://localhost`（Capacitor 默认 `androidScheme=https`），而电脑端同步服务是 `http://192.168.x.x:17878`，属**混合内容**被 WebView 拦 → `capacitor.config.ts` 加 **`allowMixedContent: true`**；② targetSdk 35 默认禁**明文流量** → `AndroidManifest.xml` 加 **`android:usesCleartextTraffic="true"`**。
- **版本号**：改 `android/app/build.gradle` 的 `versionCode` / `versionName`（当前 `3` / `"1.2"`）。**递增 versionCode 即可覆盖安装、无需卸载**；卸载会清空 app 本地数据（OPFS）。
- 注意：`android/app/src/main/assets/` 由 `cap sync` 自动生成，改完前端要重新 sync 再编译。

### 4. Windows 桌面端打包（可选）

仓库根目录的 `_build_win.cmd` 是本地打包辅助脚本（走 npmmirror 镜像 + 本地代理，产物 `release\build\Chatbox-1.23.5-Setup.exe`）。日常用上游的 `pnpm run package` 即可，这只是把代理 / 镜像 / rcedit 坑一次性固化下来的便捷脚本。

---

### 下载电脑端

<table style="width: 100%">
  <tr>
    <td width="25%" align="center">
      <b>Windows</b>
    </td>
    <td width="25%" align="center" colspan="2">
      <b>MacOS</b>
    </td>
    <td width="25%" align="center">
      <b>Linux</b>
    </td>
  </tr>
  <tr style="text-align: center">
    <td align="center" valign="middle">
      <a href='https://chatboxai.app/?c=download-windows'>
        <img src='./statics/windows.png' style="height:24px; width: 24px" />
        <br />
        <b>Setup.exe</b>
      </a>
    </td>
    <td align="center" valign="middle">
      <a href='https://chatboxai.app/?c=download-mac-intel'>
        <img src='./statics/mac.png' style="height:24px; width: 24px" />
        <br />
        <b>Intel</b>
      </a>
    </td>
    <td align="center" valign="middle">
      <a href='https://chatboxai.app/?c=download-mac-aarch'>
        <img src='./statics/mac.png' style="height:24px; width: 24px" />
        <br />
        <b style="white-space: nowrap;">Apple Silicon</b>
      </a>
    </td>
    <td align="center" valign="middle">
      <a href='https://chatboxai.app/?c=download-linux'>
        <img src='./statics/linux.png' style="height:24px; width: 24px" />
        <br />
        <b>AppImage</b>
      </a>
    </td>
  </tr>
</table>

### 下载移动端

<a href='https://apps.apple.com/app/chatbox-ai/id6471368056' style='margin-right: 4px'>
<img src='./statics/app_store.webp' style="height:38px;" />
</a>
<a href='https://play.google.com/store/apps/details?id=xyz.chatboxapp.chatbox' style='margin-right: 4px'>
<img src='./statics/google_play.png' style="height:38px;" />
</a>
<a href='https://chatboxai.app/zh/install?download=android_apk' style='margin-right: 4px; display: inline-flex; justify-content: center'>
<img src='./statics/android.png' style="height:28px; display: inline-block" />
.APK
</a>

更多信息请访问: [chatboxai.app](https://chatboxai.app/)

---


<h1 align="center">
<img src='./statics/icon.png' width='30'>
<span>
    Chatbox
    <span style="font-size:8px; font-weight: normal;">(Community Edition)</span>
</span>
</h1>
<p align="center">
    <em>Chatbox 是一个 AI 模型桌面客户端，支持 ChatGPT、Claude、Google Gemini、Ollama 等主流模型，适用于 Windows、Mac、Linux、Web、Android 和 iOS 全平台</em>
</p>

<p align="center">
<a href="https://github.com/chatboxai/chatbox/releases" target="_blank">
<img alt="macOS" src="https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white" />
</a>
<a href="https://github.com/chatboxai/chatbox/releases" target="_blank">
<img alt="Windows" src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white" />
</a>
<a href="https://github.com/chatboxai/chatbox/releases" target="_blank">
<img alt="Linux" src="https://img.shields.io/badge/-Linux-yellow?style=flat-square&logo=linux&logoColor=white" />
</a>
<a href="https://github.com/chatboxai/chatbox/releases" target="_blank">
<img alt="下载量" src="https://img.shields.io/github/downloads/chatboxai/chatbox/total.svg?style=flat" />
</a>
<a href="https://twitter.com/benn_huang" target="_blank">
<img alt="Twitter" src="https://img.shields.io/badge/关注-benn_huang-blue?style=flat&logo=Twitter" />
</a>
</p>

<a href="https://www.producthunt.com/posts/chatbox?utm_source=badge-featured&utm_medium=badge&utm_souce=badge-chatbox" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=429547&theme=light" alt="Chatbox - Better&#0032;UI&#0032;&#0038;&#0032;Desktop&#0032;App&#0032;for&#0032;ChatGPT&#0044;&#0032;Claude&#0032;and&#0032;other&#0032;LLMs&#0046; | Product Hunt" style="width: 150px; height: 30px;" width="100" height="40" /></a>

<img src="./statics/demo_desktop_1.jpg" alt="应用截图" style="box-shadow: 2px 2px 10px rgba(0,0,0,0.1); border: 1px solid #ddd; border-radius: 8px; width: 700px" />

<img src="./statics/demo_desktop_2.jpg" alt="应用截图" style="box-shadow: 2px 2px 10px rgba(0,0,0,0.1); border: 1px solid #ddd; border-radius: 8px; width: 700px" />

## 特性

-   **本地数据存储**  
    :floppy_disk: 您的数据保留在您的设备上，确保数据永不丢失并保护您的隐私。

-   **无需部署、直接安装的安装包**  
    :package: 通过可下载的安装包快速开始使用。无需复杂设置！

-   **支持多个 LLM 提供商**  
    :gear: 无缝集成多种 AI 模型：

    -   OpenAI (ChatGPT)
    -   Azure OpenAI
    -   Claude
    -   Google Gemini Pro
    -   Ollama (启用对本地模型的访问，如 llama2、Mistral、Mixtral、codellama、vicuna、yi 和 solar)
    -   ChatGLM-6B

-   **使用 Dall-E-3 生成图像**  
    :art: 使用 Dall-E-3 创建您想象中的图像。

-   **增强提示**  
    :speech_balloon: 高级提示功能，精炼并聚焦您的查询以获得更好的响应。

-   **键盘快捷键**  
    :keyboard: 使用加速您工作流程的快捷键保持高效。

-   **Markdown、Latex 和代码高亮**  
    :scroll: 使用 Markdown 和 Latex 的全部功能生成消息，并结合各种编程语言的语法高亮，提高可读性和呈现效果。

-   **提示库和消息引用**  
    :books: 保存和组织提示以供重复使用，并引用消息以在讨论中提供上下文。

-   **流式回复**  
    :arrow_forward: 通过即时、渐进式回复快速响应您的互动。

-   **人体工程学 UI 和深色主题**  
    :new_moon: 用户友好的界面，带有夜间模式选项，减少长时间使用时的眼睛疲劳。

-   **团队协作**  
    :busts_in_silhouette: 轻松协作并在团队中共享 OpenAI API 资源。[了解更多](../team-sharing/README.md)

-   **跨平台可用性**  
    :computer: 聊天盒已为 Windows、Mac、Linux 用户准备就绪。

-   **通过 Web 版本随处访问**  
    :globe_with_meridians: 在任何设备上使用带有浏览器的 Web 应用程序，随时随地。

-   **iOS 和 Android**  
    :phone: 使用移动应用程序，随时随地在您的指尖上带来这种能力。

-   **多语言支持**  
    :earth_americas: 通过提供多种语言的支持，迎合全球受众：

    -   English
    -   简体中文 (Simplified Chinese)
    -   繁體中文 (Traditional Chinese)
    -   日本語 (Japanese)
    -   한국어 (Korean)
    -   Français (French)
    -   Deutsch (German)
    -   Русский (Russian)

-   **更多...**  
    :sparkles: 不断增强体验，加入新功能！

## 常见问题解答

-   [常见问题](./FAQ-CN.md)

## 如何贡献

欢迎任何形式的贡献，包括但不限于：

-   提交问题
-   提交拉取请求
-   提交功能请求
-   提交错误报告
-   提交文档修订
-   提交翻译
-   提交任何其他形式的贡献

## 构建指南

1. 从 Github 克隆仓库

```bash
git clone https://github.com/chatboxai/chatbox.git
```

2. 安装所需的依赖

```bash
npm install
```

3. 启动应用程序（开发模式）

```bash
npm run dev
```

4. 构建应用程序，为当前平台打包安装程序

```bash
npm run package
```

5. 构建应用程序，为所有平台打包安装程序

```bash
npm run package:all
```

## Star History

[![星星历史图表](https://star-history.dera.page/svg?repos=chatboxai/chatbox&type=Date)](https://star-history.dera.page/#chatboxai/chatbox&Date)

## 联系方式

[Twitter](https://x.com/ChatboxAI_HQ) | [电子邮件](mailto:hi@chatboxai.com)
