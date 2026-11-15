package fr.bastides.app

import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import java.net.Inet4Address

@TauriPlugin(permissions = [
  Permission(alias = "localNetwork", strings = ["android.permission.ACCESS_LOCAL_NETWORK"])
])
class LanPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun prepare(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < 37 || getPermissionState("localNetwork") == PermissionState.GRANTED) {
      respond(invoke)
    } else {
      activity.runOnUiThread {
        requestPermissionForAlias("localNetwork", invoke, "localNetworkResult")
      }
    }
  }

  @PermissionCallback
  fun localNetworkResult(invoke: Invoke) {
    if (getPermissionState("localNetwork") == PermissionState.GRANTED) {
      respond(invoke)
    } else {
      invoke.reject("Autorisez l’accès au réseau local dans les réglages Android de Bastides.")
    }
  }

  private fun respond(invoke: Invoke) {
    val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    @Suppress("DEPRECATION")
    val addresses = manager.allNetworks.flatMap { network ->
      val caps = manager.getNetworkCapabilities(network)
      if (caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true ||
          caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true) {
        manager.getLinkProperties(network)?.linkAddresses.orEmpty()
          .map { it.address }
          .filterIsInstance<Inet4Address>()
          .mapNotNull { it.hostAddress }
      } else {
        emptyList()
      }
    }.distinct()
    invoke.resolve(JSObject().put("addresses", JSONArray(addresses)))
  }
}
