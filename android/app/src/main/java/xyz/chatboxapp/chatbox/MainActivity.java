package xyz.chatboxapp.chatbox;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 第 23 轮：注册局域网同步的保活 / 通知本地插件（同包内的类，无 npm、Gradle 依赖）。
        // 注意：必须在 super.onCreate 之前注册。
        registerPlugin(LanSyncNotifyPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPause() {
        super.onPause();
        // 第 23 轮保活：Capacitor 的 KeepRunning 默认为 true，Cordova 的 handlePause(true)
        // 不会调用 pauseTimers()，所以后台 JS 定时器 / SSE 本来就会继续跑；
        // 这里再兜一层——万一将来 KeepRunning 被配置成 false（会走 pauseTimers），
        // 后台的同步连接就会静默断掉。resumeTimers() 是全局开关，重复调用无副作用。
        try {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.resumeTimers();
            }
        } catch (Throwable ignored) {
            // 拿不到 WebView 时忽略：保活主要由前台服务负责。
        }
    }
}
