package com.devotek.t3code.pwa

import java.net.URI
import java.security.MessageDigest
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import okio.ByteString.Companion.decodeBase64

/** Public compiled inputs, never caller-selected URLs or credentials. Versions do not own sessions. */
data class ConnectAuthority(val clerkReceipt: String, val notificationStamp: String) {
    companion object {
        fun parse(mode: String, key: String, template: String, relay: String, digest: String): ConnectAuthority? = try {
            require(mode in setOf("owned", "legacy"))
            require(mode != "owned" || digest.matches(Regex("[a-f0-9]{64}")))
            require(template.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,127}")))
            require(key.matches(Regex("pk_(live|test)_[A-Za-z0-9+/=_-]+")))
            val encoded = key.substringAfter("pk_").substringAfter('_')
            val decoded = requireNotNull(encoded.decodeBase64()).utf8()
            require(decoded.endsWith('$'))
            val host = decoded.dropLast(1).lowercase(Locale.ROOT)
            require(host.length <= 253 && host.contains('.') && host.split('.').all {
                it.matches(Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"))
            })
            val url = URI(relay)
            require(url.scheme.equals("https", true) && url.host != null && url.rawUserInfo == null &&
                url.rawQuery == null && url.rawFragment == null && (url.rawPath.isNullOrEmpty() || url.rawPath.matches(Regex("/+"))) &&
                (url.port == -1 || url.port in 1..65535))
            val origin = "https://${url.host.lowercase(Locale.ROOT)}" + if (url.port == -1 || url.port == 443) "" else ":${url.port}"
            val receipt = "clerk-v1\n$key\nhttps://$host"
            val stamp = MessageDigest.getInstance("SHA-256").digest("notifications-v1\n$receipt\n$origin\n$template".toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            ConnectAuthority(receipt, stamp)
        } catch (_: Exception) { null }
    }
}

interface ConnectAuthorityReceipt {
    /** null means absent; an invalid or incomplete existing receipt must not be treated as absent. */
    fun read(): String?
    fun commit(receipt: String): Boolean
}

/** No SDK construction, flow access, initialization or reset before durable issuer admission. */
object ConnectAuthStartup {
    const val BLOCKED = "This installation's saved account cannot be safely opened with this build. Use your paired environments and contact your maintainer."
    fun create(
        mode: String, authority: ConnectAuthority?, receipt: ConnectAuthorityReceipt,
        sdkStoreEmpty: () -> Boolean, sdkFactory: () -> ConnectAuthSdk,
        scope: CoroutineScope, markers: ConnectAuthMarkers, template: String,
        monitor: Any = NotificationCredentials::class.java,
    ): ConnectAuth {
        val allowed = try {
            if (mode == "cloudless" || authority == null) false else {
                val previous = receipt.read()
                if (previous != null) previous == authority.clerkReceipt
                // Legacy state has no provable issuer either; never forward unknown credentials.
                else sdkStoreEmpty() && receipt.commit(authority.clerkReceipt)
            }
        } catch (_: Exception) { false }
        return ConnectAuth(if (allowed) sdkFactory() else null, scope, markers, template, allowed, monitor,
            if (!allowed && mode != "cloudless") BLOCKED else null)
    }
}
