package xyz.chatboxapp.chatbox;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationCompat;

/**
 * 第 23 轮：局域网同步的原生通知渠道 + 通知构造。
 *
 * 两条渠道：
 * - {@link #CHANNEL_KEEP_ALIVE}：前台服务的常驻通知，最低优先级、无声无振动，
 *   只是一条「同步在后台保持连接」的可见凭据（Android 要求前台服务必须有通知）。
 * - {@link #CHANNEL_TASK}：同步过来的「工作模式任务完成」提醒，走系统提示音 + 振动模式。
 *
 * 注意：Android 8.0+ 的通知渠道属性一旦创建就**不可修改**，想换声音/振动/重要级
 * 必须换新的 channel id（所以这两个 id 不要复用成别的语义）。
 */
final class LanSyncNotifications {

    static final String CHANNEL_KEEP_ALIVE = "lan_sync_keep_alive";
    static final String CHANNEL_TASK = "lan_sync_task_done";

    static final int ID_KEEP_ALIVE = 2301;
    static final int ID_TASK = 2302;

    private LanSyncNotifications() {}

    /** 幂等创建两条通知渠道（Service 与 Plugin 都会调用）。 */
    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }

        if (manager.getNotificationChannel(CHANNEL_KEEP_ALIVE) == null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_KEEP_ALIVE,
                "局域网同步（保持连接）",
                NotificationManager.IMPORTANCE_MIN
            );
            channel.setDescription("保持与电脑端的连接，让手机在后台也能收到同步消息");
            channel.setShowBadge(false);
            channel.setSound(null, null);
            channel.enableVibration(false);
            manager.createNotificationChannel(channel);
        }

        if (manager.getNotificationChannel(CHANNEL_TASK) == null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_TASK,
                "任务完成提醒",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("电脑端的工作模式任务完成时提醒");
            channel.setShowBadge(true);
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[] { 0L, 250L, 200L, 250L });
            channel.setSound(
                Settings.System.DEFAULT_NOTIFICATION_URI,
                new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build()
            );
            manager.createNotificationChannel(channel);
        }
    }

    /** 点通知回到 App（而不是新开一个实例）。 */
    static PendingIntent openAppPendingIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /**
     * 前台服务的常驻通知：无声、尽快显示。
     *
     * 注意：Android 14 起用户仍能**手动划掉**这条通知（官方行为变更，setOngoing(true)
     * 只挡得住「清除全部」，挡不住单条滑动删除），且官方没有公开 API 能让应用强制不可划走。
     * 划掉并不停服务，只是状态栏少一条 —— 保活照旧。
     * setForegroundServiceBehavior(IMMEDIATE)：后台拉起服务时也立刻显示，不延迟。
     */
    static Notification buildKeepAlive(Context context, String text) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_KEEP_ALIVE)
            .setSmallIcon(R.drawable.ic_stat_chatbox)
            .setContentTitle("Chatbox 局域网同步")
            .setContentText(text)
            .setContentIntent(openAppPendingIntent(context))
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        return builder.build();
    }

    /** 「任务完成」提醒：系统提示音 + 振动（渠道里配好了；低版本走 builder 默认值）。 */
    static Notification buildTask(Context context, String title, String body) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_TASK)
            .setSmallIcon(R.drawable.ic_stat_chatbox)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openAppPendingIntent(context))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setDefaults(NotificationCompat.DEFAULT_SOUND | NotificationCompat.DEFAULT_VIBRATE);
        }
        return builder.build();
    }
}
