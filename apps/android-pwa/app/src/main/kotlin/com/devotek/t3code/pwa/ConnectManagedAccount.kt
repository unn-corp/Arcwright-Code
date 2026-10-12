package com.devotek.t3code.pwa

import java.io.IOException
import kotlinx.coroutines.*

/** SDK state establishes identity; persisted references never establish an account themselves. */
class ConnectManagedAccount(private val auth: ConnectAuth, private val dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate) : NativeManagedAccount {
    override fun capture(userId: String, sessionId: String): ConnectAuthStatus {
        val fence = auth.accountFence()
        if (fence.phase in setOf("initializing", "error", "signingIn")) throw IOException("Account restoration pending")
        if (fence.userId != userId || fence.sessionId != sessionId) throw ManagedAuthRejected()
        validate(fence)
        return fence
    }
    override fun validate(fence: ConnectAuthStatus) {
        val status = auth.accountFence()
        if (status.generation != fence.generation || status.userId != fence.userId || status.sessionId != fence.sessionId || status.phase == "signedOut") throw ManagedAuthRejected()
        if (!auth.isCurrent(fence)) throw IOException("Account restoration pending")
    }
    override fun current(fence: ConnectAuthStatus) = auth.isCurrent(fence)
    override fun relayToken(forceRefresh: Boolean): String = runBlocking {
        withContext(dispatcher) { withTimeout(15_000) { auth.getRelayToken(forceRefresh) } }
    }
}
