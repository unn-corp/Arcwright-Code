package com.devotek.t3code.pwa

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.*
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

/** Separate from every WebView key. Only the public JWK leaves Android Keystore. */
class NativeDpopKey(private val pair: KeyPair) {
    companion object {
        private const val ALIAS = "arcwright-connect-background-dpop-v1"
        fun androidKey(): NativeDpopKey {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (store.containsAlias(ALIAS)) return NativeDpopKey(KeyPair(store.getCertificate(ALIAS).publicKey, store.getKey(ALIAS, null) as PrivateKey))
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            generator.initialize(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
            return NativeDpopKey(generator.generateKeyPair())
        }
        private fun encoded(bytes: ByteArray) = bytes.toByteString().base64Url().trimEnd('=')
        private fun coordinate(value: java.math.BigInteger) = value.toByteArray().takeLast(32).toByteArray().let { ByteArray(32 - it.size) + it }
        fun rawSignature(der: ByteArray): ByteArray {
            // P-256 JCA signatures are a short DER SEQUENCE of two positive INTEGERs.
            require(der.size in 8..72 && der[0] == 0x30.toByte() && (der[1].toInt() and 255) == der.size - 2)
            var position = 2
            fun integer(): ByteArray {
                require(der[position++].toInt() == 2)
                val size = der[position++].toInt() and 255
                require(size in 1..33 && position + size <= der.size)
                val bytes = der.copyOfRange(position, position + size); position += size
                val unsigned = if (size == 33) { require(bytes[0].toInt() == 0); bytes.copyOfRange(1, size) } else bytes
                return ByteArray(32 - unsigned.size) + unsigned
            }
            val result = integer() + integer(); require(position == der.size); return result
        }
    }
    private val public = pair.public as ECPublicKey
    private val x = encoded(coordinate(public.w.affineX))
    private val y = encoded(coordinate(public.w.affineY))
    val thumbprint = encoded(MessageDigest.getInstance("SHA-256").digest("{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"$x\",\"y\":\"$y\"}".toByteArray(Charsets.UTF_8)))
    fun proof(method: String, url: String, nowMillis: Long, token: String? = null, nonce: String? = null): String {
        val header = JSONObject().put("typ", "dpop+jwt").put("alg", "ES256").put("jwk", JSONObject().put("kty", "EC").put("crv", "P-256").put("x", x).put("y", y))
        val claims = JSONObject().put("jti", java.util.UUID.randomUUID().toString()).put("iat", nowMillis / 1000).put("htu", url).put("htm", method)
        if (token != null) claims.put("ath", encoded(MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))))
        if (nonce != null) claims.put("nonce", nonce)
        val unsigned = encoded(header.toString().toByteArray(Charsets.UTF_8)) + "." + encoded(claims.toString().toByteArray(Charsets.UTF_8))
        val signature = Signature.getInstance("SHA256withECDSA").apply { initSign(pair.private); update(unsigned.toByteArray(Charsets.US_ASCII)) }.sign()
        return unsigned + "." + encoded(rawSignature(signature))
    }
}
