package xyz.chatboxapp.chatbox;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.Manifest;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.PowerManager;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import android.util.Log;

import androidx.annotation.Nullable;

/**
 * 第 23 轮：局域网同步的「保活」前台服务（Android 端）。
 *
 * 为什么需要它：Capacitor 的 KeepRunning 默认为 true，所以 App 切到后台后 WebView 的
 * JS 定时器与 EventSource(SSE) 长连接并**不会**被暂停；但一旦进程被系统降级成
 * cached 进程，就会被 Cached Apps Freezer 冻结（SIGSTOP）甚至回收，连接随即断掉。
 * 挂一个前台服务能把进程钉在「前台服务」状态：
 * - 不进 cached 状态 → 不被冻结，SSE/轮询继续跑；
 * - 顺带申请 PARTIAL_WAKE_LOCK，屏幕熄灭后 CPU 仍能为 WebView 派发定时器与收包。
 *
 * 所以「该不该提醒」的判断逻辑仍然留在 JS 里（复用现有实现），本服务只管保活。
 */
public class LanSyncKeepAliveService extends Service {

    private static final String TAG = "LanSyncKeepAlive";
    private static final String WAKE_LOCK_TAG = "chatbox:lan-sync";
    private static final String ACTION_STOP = "xyz.chatboxapp.chatbox.STOP_LAN_SYNC_KEEP_ALIVE";

    private static volatile boolean running = false;

    private PowerManager.WakeLock wakeLock;

    // ---- 第 25 轮：原生侧「有新消息」轮询 ----
    // 手机 App 在后台（WebView 的 JS 被系统冻结 / 进程被回收）时，
    // 由这个前台服务自己去看一眼电脑端有没有新批次，有就弹通知。
    private static final String PREFS_NAME = "lan_sync_native";
    private static final String KEY_BASE_URL = "baseUrl";
    private static final String KEY_LAST_BATCH = "lastNotifiedBatchId";
    private static final long WATCH_FIRST_DELAY_MS = 5_000L;
    private static final long WATCH_INTERVAL_MS = 20_000L;
    private static final int WATCH_CONNECT_TIMEOUT_MS = 5_000;
    private static final int WATCH_READ_TIMEOUT_MS = 5_000;
    /** 「有新消息」通知的 id：与 JS 侧的任务完成通知（LanSyncNotifications.ID_TASK）分开，互不干扰。 */
    private static final int ID_WATCH = 2303;

    private ScheduledExecutorService watcher;

    /** 供插件查询（不依赖 Service 实例）。 */
    public static boolean isRunning() {
        return running;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        LanSyncNotifications.ensureChannels(this);

        try {
            Notification notification = LanSyncNotifications.buildKeepAlive(this, "已保持与电脑端的连接");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    LanSyncNotifications.ID_KEEP_ALIVE,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                );
            } else {
                startForeground(LanSyncNotifications.ID_KEEP_ALIVE, notification);
            }
        } catch (Throwable error) {
            // Android 12+ 在后台启动前台服务可能被拒（ForegroundServiceStartNotAllowed）。
            // 这里不硬撑：直接退出，等 JS 侧下一次（用户在前台时）再拉起。
            Log.w(TAG, "startForeground 被系统拒绝，放弃保活", error);
            running = false;
            stopSelf();
            return;
        }

        acquireWakeLock();
        startWatching();
        Log.i(TAG, "保活服务已启动");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        LanSyncNotifications.ensureChannels(this);
        // 常驻通知可能被系统清掉（或首次未显示），这里刷新一次。
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(
                LanSyncNotifications.ID_KEEP_ALIVE,
                LanSyncNotifications.buildKeepAlive(this, "已保持与电脑端的连接")
            );
        }
        // START_STICKY：被系统回收后尽量自动重建（重建时 onCreate 会重新 startForeground）。
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseWakeLock();
        stopWatching();
        Log.i(TAG, "保活服务已停止");
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        try {
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (powerManager == null) {
                return;
            }
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
            wakeLock.setReferenceCounted(false);
            // 不设超时：本服务的唯一职责就是保活；由 onDestroy / stopKeepAlive 负责释放。
            wakeLock.acquire();
        } catch (Throwable error) {
            Log.w(TAG, "申请 WakeLock 失败", error);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Throwable error) {
            Log.w(TAG, "释放 WakeLock 失败", error);
        } finally {
            wakeLock = null;
        }
    }
    /**
     * 第 25 轮：每隔 {@link #WATCH_INTERVAL_MS} 问一次电脑端「最新批次号是多少」。
     * 网络请求必须离开主线程，所以用单独的单线程调度器；失败只记日志、绝不抛给调用方。
     */
    private void startWatching() {
        if (watcher != null) {
            return;
        }
        watcher = Executors.newSingleThreadScheduledExecutor();
        watcher.scheduleWithFixedDelay(
            new Runnable() {
                @Override
                public void run() {
                    try {
                        watchOnce();
                    } catch (Throwable error) {
                        Log.w(TAG, "检查电脑端新消息失败", error);
                    }
                }
            },
            WATCH_FIRST_DELAY_MS,
            WATCH_INTERVAL_MS,
            TimeUnit.MILLISECONDS
        );
    }

    private void stopWatching() {
        if (watcher == null) {
            return;
        }
        try {
            watcher.shutdownNow();
        } catch (Throwable error) {
            Log.w(TAG, "停止新消息轮询失败", error);
        } finally {
            watcher = null;
        }
    }

    private void watchOnce() {
        SharedPreferences preferences = prefs(this);
        String baseUrl = preferences.getString(KEY_BASE_URL, "");
        if (baseUrl == null || baseUrl.isEmpty()) {
            return;
        }

        String latest = fetchLatestBatchId(baseUrl);
        if (latest == null || latest.isEmpty()) {
            return;
        }
        if (latest.equals(preferences.getString(KEY_LAST_BATCH, ""))) {
            return;
        }

        notifyNewPackage(latest);
    }

    /** GET /lan-sync/info（免鉴权），只取 lastBatchId；取不到就返回 null。 */
    private String fetchLatestBatchId(String baseUrl) {
        HttpURLConnection connection = null;
        try {
            String base = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
            URL url = new URL(base + "/lan-sync/info");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(WATCH_CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(WATCH_READ_TIMEOUT_MS);

            if (connection.getResponseCode() != 200) {
                return null;
            }

            InputStream input = connection.getInputStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = input.read(chunk)) > 0) {
                buffer.write(chunk, 0, read);
            }
            input.close();

            String batchId = new JSONObject(buffer.toString("UTF-8")).optString("lastBatchId", "");
            return batchId.isEmpty() ? null : batchId;
        } catch (Throwable error) {
            Log.w(TAG, "读取电脑端状态失败", error);
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void notifyNewPackage(String batchId) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        LanSyncNotifications.ensureChannels(this);
        manager.notify(
            ID_WATCH,
            LanSyncNotifications.buildTask(this, "有新消息待同步", "电脑端有新的内容，点开 Chatbox 查看")
        );
        // 先记下批次号再等 JS 回前台：同一条只提醒一次，避免每 20 秒重复弹。
        prefs(this).edit().putString(KEY_LAST_BATCH, batchId).apply();
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** JS 侧拉起保活时把电脑端地址记下来，供服务被系统重启（START_STICKY）后自行轮询。 */
    static void rememberBaseUrl(Context context, String baseUrl) {
        prefs(context).edit().putString(KEY_BASE_URL, baseUrl == null ? "" : baseUrl).apply();
    }

    /**
     * JS 侧已经把某批数据同步下来时调用：记下批次号并撤掉「有新消息」提醒。
     * 批次号存进 SharedPreferences，进程重启后不会对着同一批数据重复提醒。
     */
    static void markSynced(Context context, String batchId) {
        if (batchId == null || batchId.isEmpty()) {
            return;
        }
        prefs(context).edit().putString(KEY_LAST_BATCH, batchId).apply();
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(ID_WATCH);
        }
    }

}
