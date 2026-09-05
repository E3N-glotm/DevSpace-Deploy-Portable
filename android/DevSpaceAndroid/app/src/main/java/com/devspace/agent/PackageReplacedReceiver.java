package com.devspace.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores an intentionally running service after an in-place APK update. */
public final class PackageReplacedReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        AgentConfig config = new AgentConfig(context);
        config.packageReplaceEvent("received", "");
        if (!config.serviceRequested() && !config.startOnBoot()) {
            config.packageReplaceEvent("skipped-not-requested", "");
            return;
        }
        try {
            Intent service = new Intent(context, DevSpaceAgentService.class)
                    .setAction(DevSpaceAgentService.ACTION_START)
                    .putExtra(DevSpaceAgentService.EXTRA_START_REASON, "package-replaced");
            context.startForegroundService(service);
            config.packageReplaceEvent("start-requested", "");
        } catch (Throwable error) {
            String message = error.getClass().getSimpleName() + ": "
                    + (error.getMessage() == null ? "" : error.getMessage());
            config.packageReplaceEvent("start-failed", message);
            android.util.Log.e("DevSpacePkgReplace", "Failed to restore service after package replacement", error);
        }
    }
}
