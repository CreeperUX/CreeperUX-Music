package com.creeperux.sonus.data

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import com.creeperux.sonus.core.Login
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Seals and opens secrets. */
interface SecretBox {
    fun seal(plain: ByteArray): ByteArray
    fun open(sealed: ByteArray): ByteArray
}

/**
 * AES-256-GCM with a key that lives in the Android Keystore and never leaves it (on most phones it is in secure
 * hardware): what it seals can only be opened by this app on this device. Sealed: the 12-byte IV, then the ciphertext
 * with its tag.
 */
class KeystoreBox(private val alias: String = "sonus-sign-in") : SecretBox {
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val iv = cipher.iv
        check(iv.size == 12)
        return iv + cipher.doFinal(plain)
    }

    override fun open(sealed: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12)) }
        return cipher.doFinal(sealed, 12, sealed.size - 12)
    }
}

/**
 * The sign-in kept between runs: the server, the user and the token or API key ([Login]), sealed by [box]. Never the
 * password. The preferences file it lives in is left out of backups (the Keystore key would not come with it anyway).
 */
class LoginStore(private val prefs: SharedPreferences, private val box: SecretBox) {
    fun load(): Login? {
        val sealed = prefs.getString(KEY, null) ?: return null
        return try {
            Login.fromJson(String(box.open(Base64.decode(sealed, Base64.NO_WRAP)), Charsets.UTF_8))
        } catch (_: Exception) {
            null // the key is gone (a restore onto another phone, a reset Keystore): sign in again
        }
    }

    fun save(login: Login) = prefs.edit { putString(KEY, Base64.encodeToString(box.seal(login.toJson().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)) }

    fun clear() = prefs.edit { remove(KEY) }

    private companion object {
        const val KEY = "login"
    }
}
