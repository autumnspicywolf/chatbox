package xyz.chatboxapp.chatbox;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 第 23 轮：局域网同步「保活 + 通知」的本地 Capacitor 插件（无 npm 依赖）。
 *
 * JS 侧通过 registerPlugin('LanSyncNotify') 使用，四个能力：
 * - startKeepAlive / stopKeepAlive：拉起/停止 {@link LanSyncKeepAliveService} 前台服务。
 * - isKeepAliveRunning：查询服务是否在跑（调试与 UI 展示用）。
 * - notifyTask：弹一条「任务完成」系统通知（含系统提示音 + 振动，渠道见 LanSyncNotifications）。
 * - requestNotificationPermission：Android 13+ 申请 POST_NOTIFICATIONS（低版本直接视为已授予）。
 *
 * 为什么不用 @capacitor/local-notifications：这类能力就在本工程里，写成同包内的一个类
 * 可以完全避免新增 npm / Gradle 依赖（该仓库的打包链路对新增依赖比较敏感）。
 */
@CapacitorPlugin(
    name = "LanSyncNotify",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class LanSyncNotifyPlugin extends Plugin {

    @PluginMethod
    public void startKeepAlive(PluginCall call) {
        Context context = getContext();
        // 第 25 轮：服务要自己轮询电脑端，这里把地址落盘（WebView 冻结后服务重启也还认得）
        String baseUrl = call.getString("baseUrl");
        if (baseUrl != null && !baseUrl.isEmpty()) {
            LanSyncKeepAliveService.rememberBaseUrl(context, baseUrl);
        }
        try {
            LanSyncNotifications.ensureChannels(context);
            ContextCompat.startForegroundService(context, new Intent(context, LanSyncKeepAliveService.class));
            JSObject result = new JSObject();
            result.put("running", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法启动局域网同步保活服务：" + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void stopKeepAlive(PluginCall call) {
        Context context = getContext();
        try {
            context.stopService(new Intent(context, LanSyncKeepAliveService.class));
            JSObject result = new JSObject();
            result.put("running", false);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法停止局域网同步保活服务：" + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void isKeepAliveRunning(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", LanSyncKeepAliveService.isRunning());
        call.resolve(result);
    }

    @PluginMethod
    public void markSynced(PluginCall call) {
        // 第 25 轮：JS 已同步到 batchId，撤掉原生的「有新消息」提醒
        LanSyncKeepAliveService.markSynced(getContext(), call.getString("batchId"));
        call.resolve();
    }

    @PluginMethod
    public void notifyTask(PluginCall call) {
        Context context = getContext();
        String title = call.getString("title");
        if (title == null || title.isEmpty()) {
            title = "工作模式任务已完成";
        }
        String body = call.getString("body");
        if (body == null || body.isEmpty()) {
            body = "电脑端已完成回复，点开查看";
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED) {
            // 没权限时不要静默失败：让 JS 侧知道，好回退成页面内的「叮咚」。
            call.reject("通知权限未授予");
            return;
        }

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            call.reject("系统通知服务不可用");
            return;
        }

        LanSyncNotifications.ensureChannels(context);
        manager.notify(
            LanSyncNotifications.ID_TASK,
            LanSyncNotifications.buildTask(context, title, body)
        );
        call.resolve();
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        // Android 13 之前没有运行时通知权限，直接按已授予处理。
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            resolveGranted(call);
            return;
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            resolveGranted(call);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsCallback");
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(result);
    }

    private void resolveGranted(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", true);
        call.resolve(result);
    }
}
