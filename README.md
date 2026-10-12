<p align="right">
  <a href="README.md">English</a> |
  <a href="./doc/README-CN.md">简体中文</a>
</p>

<h1 align="center">
<img src='./doc/statics/icon.png' width='30'>
<span>
    Chatbox
    <span style="font-size:8px; font-weight: normal;">(Community Edition)</span>
</span>
</h1>
<p align="center">
    <em>Your Ultimate AI Copilot on the Desktop. <br />Chatbox is a desktop client for ChatGPT, Claude and other LLMs, available on Windows, Mac, Linux</em>
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
<img alt="Downloads" src="https://img.shields.io/github/downloads/chatboxai/chatbox/total.svg?style=flat" />
</a>
<a href="#features">
<img alt="Privacy" src="https://img.shields.io/badge/-Local%20First-green?style=flat-square&logo=shield&logoColor=white" />
</a>
</p>

<p align="center">
<a href="https://www.producthunt.com/posts/chatbox?utm_source=badge-featured&utm_medium=badge&utm_souce=badge-chatbox" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=429547&theme=light" alt="Chatbox - Better&#0032;UI&#0032;&#0038;&#0032;Desktop&#0032;App&#0032;for&#0032;ChatGPT&#0044;&#0032;Claude&#0032;and&#0032;other&#0032;LLMs&#0046; | Product Hunt" style="width: 150px; height: 30px;" width="100" height="40" /></a>
<a href="https://trendshift.io/repositories/14871" target="_blank"><img src="https://trendshift.io/api/badge/repositories/14871" alt="chatboxai%2Fchatbox | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="./doc/statics/snapshot_light.png">
    <img src="./doc/statics/snapshot_light.png" width="400"/>
  </a>
  <a href="./doc/statics/snapshot_dark.png">
    <img src="./doc/statics/snapshot_dark.png" width="400"/>
  </a>
</p>

---

This is the repository for the Chatbox Community Edition, open-sourced under the GPLv3 license.

[Chatbox is going open-source Again!](https://github.com/chatboxai/chatbox/issues/2266)

We regularly sync code from the pro repo to this repo, and vice versa.

---

## 本仓库定制说明 / Fork Customizations

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

## Download

### Desktop

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
        <img src='./doc/statics/windows.png' style="height:24px; width: 24px" />
        <br />
        <b>Setup.exe</b>
      </a>
    </td>
    <td align="center" valign="middle">
      <a href='https://chatboxai.app/?c=download-mac-intel'>
        <img src='./doc/statics/mac.png' style="height:24px; width: 24px" />
        <br />
        <b>Intel</b>
      </a>
    </td>
    <td align="center" valign="middle">
      <a href='https://chatboxai.app/?c=download-mac-aarch'>
        <img src='./doc/statics/mac.png' style="height:24px; width: 24px" />
        <br />
        <b style="white-space: nowrap;">Apple Silicon</b>
      </a>
    </td>
    <td align="center" valign="middle">
      <a href='https://chatboxai.app/?c=download-linux'>
        <img src='./doc/statics/linux.png' style="height:24px; width: 24px" />
        <br />
        <b>AppImage</b>
      </a>
    </td>
  </tr>
</table>

### iOS/Android

<a href='https://apps.apple.com/app/chatbox-ai/id6471368056' style='margin-right: 4px'>
<img src='./doc/statics/app_store.webp' style="height:38px;" />
</a>
<a href='https://play.google.com/store/apps/details?id=xyz.chatboxapp.chatbox' style='margin-right: 4px'>
<img src='./doc/statics/google_play.png' style="height:38px;" />
</a>
<a href='https://chatboxai.app/install?download=android_apk' style='margin-right: 4px; display: inline-flex; justify-content: center'>
<img src='./doc/statics/android.png' style="height:28px; display: inline-block" />
.APK
</a>

For more information: [chatboxai.app](https://chatboxai.app/)

## Quick Start

### For End Users
1. Download the appropriate installer for your platform from the [releases page](https://github.com/chatboxai/chatbox/releases)
2. Install and launch Chatbox
3. Configure your AI provider (OpenAI, Claude, etc.) in settings
4. Start chatting!

### System Requirements

| Platform | Minimum Version | Architecture |
|----------|----------------|--------------|
| Windows | Windows 10 | x64 |
| macOS | macOS 11 (Big Sur) | Intel/Apple Silicon |
| Linux | Ubuntu 20.04+ / AppImage supported distros | x64 |

<!-- <table>
<tr>
<td>
<img src="./dec/../doc/demo_mobile_1.png" alt="App Screenshot" style="box-shadow: 2px 2px 10px rgba(0,0,0,0.1); border: 1px solid #ddd; border-radius: 8px; height: 300px" />
</td>
<td>
<img src="./dec/../doc/demo_mobile_2.png" alt="App Screenshot" style="box-shadow: 2px 2px 10px rgba(0,0,0,0.1); border: 1px solid #ddd; border-radius: 8px; height: 300px" />
</td>
</tr>
</table> -->

## Features

### 🤖 AI Model Support
-   **Support for Multiple LLM Providers**  
    :gear: Seamlessly integrate with a variety of cutting-edge language models:
    -   OpenAI (ChatGPT)
    -   Azure OpenAI
    -   Claude
    -   Google Gemini Pro
    -   Ollama (enable access to local models like llama2, Mistral, Mixtral, codellama, vicuna, yi, and solar)
    -   ChatGLM-6B

-   **Image Generation with Dall-E-3**  
    :art: Create the images of your imagination with Dall-E-3.

-   **Enhanced Prompting**  
    :speech_balloon: Advanced prompting features to refine and focus your queries for better responses.

### 🖥️ User Experience
-   **Local Data Storage**  
    :floppy_disk: Your data remains on your device, ensuring it never gets lost and maintains your privacy.

-   **No-Deployment Installation Packages**  
    :package: Get started quickly with downloadable installation packages. No complex setup necessary!

-   **Ergonomic UI & Dark Theme**  
    :new_moon: A user-friendly interface with a night mode option for reduced eye strain during extended use.

-   **Keyboard Shortcuts**  
    :keyboard: Stay productive with shortcuts that speed up your workflow.

-   **Streaming Reply**  
    :arrow_forward: Provide rapid responses to your interactions with immediate, progressive replies.

### 📄 Content & Formatting
-   **Markdown, Latex & Code Highlighting**  
    :scroll: Generate messages with the full power of Markdown and Latex formatting, coupled with syntax highlighting for various programming languages, enhancing readability and presentation.

-   **Prompt Library & Message Quoting**  
    :books: Save and organize prompts for reuse, and quote messages for context in discussions.

### 👥 Collaboration & Sharing
-   **Team Collaboration**  
    :busts_in_silhouette: Collaborate with ease and share OpenAI API resources among your team. [Learn More](./team-sharing/README.md)

### 🌐 Platform Availability
-   **Cross-Platform Desktop**  
    :computer: Chatbox is ready for Windows, Mac, and Linux users.

-   **Web Version**  
    :globe_with_meridians: Use the web application on any device with a browser, anywhere.

-   **Mobile Apps**  
    :phone: Native iOS and Android applications for on-the-go access.

### 🌍 Localization
-   **Multilingual Support**  
    :earth_americas: Catering to a global audience by offering support in multiple languages:
    -   English
    -   简体中文 (Simplified Chinese)
    -   繁體中文 (Traditional Chinese)
    -   日本語 (Japanese)
    -   한국어 (Korean)
    -   Français (French)
    -   Deutsch (German)
    -   Русский (Russian)
    -   Español (Spanish)

### ✨ More Features
-   **And More...**  
    :sparkles: Constantly enhancing the experience with new features!

## FAQ

-   [Frequently Asked Questions](./doc/FAQ.md)

## How to Contribute

We welcome contributions from the community! Here's how you can help make Chatbox better:

### 🐛 Reporting Issues
- Use [GitHub Issues](https://github.com/chatboxai/chatbox/issues) to report bugs or request features
- Before creating a new issue, please search existing issues to avoid duplicates
- Provide detailed information including steps to reproduce, expected behavior, and screenshots if applicable

### 🔧 Pull Requests
1. Fork the repository and create your branch from `main`
2. Make your changes and ensure the code follows our coding standards
3. Test your changes thoroughly
4. Update documentation if needed
5. Submit a pull request with a clear description of the changes

### 🌍 Translations
Help make Chatbox accessible to more people by contributing translations:
- Translation files are located in the `src/locales` directory
- Follow the existing translation format
- Submit a PR with your translation improvements

### 📖 Documentation
- Improve README, API documentation, or user guides
- Fix typos or clarify unclear instructions
- Add examples and tutorials

### 🌟 Other Ways to Contribute
- Star the repository to show your support
- Share Chatbox with others
- Answer questions in [GitHub Discussions](https://github.com/chatboxai/chatbox/discussions)
- Provide feedback and suggestions

**Thank you for contributing! 🙏**

## Development

### Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v20.x – v22.x) - [Download here](https://nodejs.org/)
- **pnpm** (v10.x or later) - Install via `corepack enable && corepack prepare pnpm@latest --activate`
- **Git** - [Download here](https://git-scm.com/)

### Quick Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/chatboxai/chatbox.git
   cd chatbox
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Start development server**
   ```bash
   pnpm run dev
   ```
   The application will start in development mode with hot-reload enabled.

### Build Commands

| Command | Description |
|---------|-------------|
| `pnpm run dev` | Start development server with hot-reload |
| `pnpm run package` | Build and package for current platform |
| `pnpm run package:all` | Build and package for all platforms |
| `pnpm run build` | Build for production without packaging |
| `pnpm run lint` | Run Biome to check code quality |
| `pnpm run test` | Run Vitest test suite |

### Project Structure

```
chatbox/
├── src/
│   ├── main/               # Electron main process
│   ├── renderer/           # React renderer (UI)
│   ├── preload/            # Electron preload scripts
│   └── shared/             # Shared utilities
├── doc/                    # Documentation and assets
├── resources/              # App resources and icons
├── team-sharing/           # Team collaboration features
└── package.json            # Project configuration
```

### Development Tips

- Use `pnpm run lint` before committing to ensure code quality
- Follow the existing code style and patterns
- Test your changes on both light and dark themes
- Ensure cross-platform compatibility when making UI changes

### Troubleshooting

**Issue**: `pnpm install` fails
- **Solution**: Ensure you're using pnpm (not npm or yarn) and Node.js version is within the required range. Run `corepack enable` if pnpm is not found.

**Issue**: Build fails on Windows
- **Solution**: Run `pnpm config set script-shell "C:\\Program Files\\git\\bin\\bash.exe"` if using Git Bash

**Issue**: Changes not reflecting in development
- **Solution**: Stop the dev server, delete `node_modules/.vite`, and restart

## Star History

[![Star History Chart](https://star-history.dera.page/svg?repos=chatboxai/chatbox&type=Date)](https://star-history.dera.page/#chatboxai/chatbox&Date)

## Contact

[Email](mailto:hi@chatboxai.com)

## License

[LICENSE](./LICENSE)
