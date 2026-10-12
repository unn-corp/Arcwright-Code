package com.devotek.t3code.pwa

import android.app.Activity
import android.os.Bundle
import android.content.Intent
import kotlinx.coroutines.launch

/** Dedicated callback activity: no arbitrary URL can navigate the privileged bundled WebView. */
class ConnectAuthCallbackActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val callback = intent?.dataString
        if (ConnectAuth.acceptsCallback(callback)) {
            val app = application as ArcwrightApplication
            app.authScope.launch { app.connectAuth.handleCallback(callback!!) }
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
        finish()
    }
}
