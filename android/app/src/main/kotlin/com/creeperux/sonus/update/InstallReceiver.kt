package com.creeperux.sonus.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import com.creeperux.sonus.SonusApp

/**
 * What the system's installer says about an update [Updater] handed it (not exported: only the installer, through the
 * pending intent Updater gave it, reaches it). First that its owner has to confirm, with the page to do it on, which
 * Updater opens when Sonus is in front; then how it went.
 */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val updater = (context.applicationContext as SonusApp).graph.updater
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            if (confirm == null) {
                updater.onInstallStatus(PackageInstaller.STATUS_FAILURE, "系统没有给出确认页面")
                return
            }
            updater.onConfirmationNeeded(confirm)
            return
        }
        updater.onInstallStatus(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
    }
}
