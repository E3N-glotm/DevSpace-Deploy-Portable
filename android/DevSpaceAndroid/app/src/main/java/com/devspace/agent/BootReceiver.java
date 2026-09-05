package com.devspace.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        AgentConfig config = new AgentConfig(context);
        if (!config.startOnBoot()) return;
        Intent service = new Intent(context, DevSpaceAgentService.class)
                .setAction(DevSpaceAgentService.ACTION_START)
                .putExtra(DevSpaceAgentService.EXTRA_START_REASON, "boot");
        context.startForegroundService(service);
    }
}
