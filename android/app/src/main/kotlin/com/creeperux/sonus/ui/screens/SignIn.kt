package com.creeperux.sonus.ui.screens

import android.content.Context
import android.content.Intent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import com.creeperux.sonus.AppGraph
import com.creeperux.sonus.R
import com.creeperux.sonus.core.DeviceLogin
import com.creeperux.sonus.core.DeviceLoginStart
import com.creeperux.sonus.core.DeviceLoginState
import com.creeperux.sonus.core.Hosts
import com.creeperux.sonus.core.SubsonicClient
import com.creeperux.sonus.ui.components.PillButton
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.theme.Display
import com.creeperux.sonus.ui.theme.Sonus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Signing in (LoginView.cs): the server, the user and the password, kept as a token (never the password); or in the
 * browser, where the user signs in on the server's own page and allows this app, which then gets a key of its own.
 */
@Composable
fun SignInScreen(graph: AppGraph, message: String?) {
    val c = Sonus.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(graph.settings.lastServer) }
    var user by remember { mutableStateOf(graph.settings.lastUser) }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf(message) }
    var busy by remember { mutableStateOf(false) }
    var browser by remember { mutableStateOf<DeviceLoginStart?>(null) }
    var browserJob by remember { mutableStateOf<Job?>(null) }

    fun signIn() {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                graph.signedIn(SubsonicClient.signIn(server, user, password, graph.clientName))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                android.util.Log.w("Sonus", "sign-in failed", e)
                error = e.message ?: "登录失败。"
            } finally {
                busy = false
            }
        }
    }

    fun signInInBrowser() {
        if (busy) return
        busy = true
        error = null
        browserJob = scope.launch {
            try {
                val (address, supported) = DeviceLogin.probe(server)
                if (!supported) {
                    error = "这个服务器不支持在浏览器中登录，请用用户名和密码登录。"
                    return@launch
                }
                val start = DeviceLogin.start(address, "Sonus", graph.deviceName)
                browser = start
                openBrowser(context, start.verificationUrl)
                val (state, login) = DeviceLogin.await(start)
                browser = null
                when (state) {
                    DeviceLoginState.Approved -> graph.signedIn(login!!)
                    DeviceLoginState.Denied -> error = "登录请求被拒绝了。"
                    else -> error = "登录请求已过期，请再试一次。"
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                android.util.Log.w("Sonus", "browser sign-in failed", e)
                error = e.message ?: "登录失败。"
            } finally {
                busy = false
                browser = null
            }
        }
    }

    Box(Modifier.fillMaxSize().background(c.window).systemBarsPadding().imePadding(), contentAlignment = Alignment.Center) {
        Column(
            Modifier
                .widthIn(max = 460.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(c.panel)
                .padding(horizontal = 28.dp, vertical = 32.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.logo), null, Modifier.size(44.dp))
                Spacer(Modifier.width(10.dp))
                Text("Sonus", style = TextStyle(fontFamily = Display, fontWeight = FontWeight.Bold, fontSize = 22.sp), color = c.text)
            }
            Spacer(Modifier.height(24.dp))
            Text("连接你的音乐服务器", style = Sonus.type.pageTitle, color = c.text)
            Spacer(Modifier.height(6.dp))
            Text("Sonus 播放你自己服务器上的音乐。填写服务器地址，再用账号密码登录，或在浏览器中登录。", style = Sonus.type.body, color = c.textMuted)
            Spacer(Modifier.height(20.dp))

            val browserStart = browser
            if (browserStart != null) {
                BrowserWait(browserStart, { openBrowser(context, browserStart.verificationUrl) }) {
                    browserJob?.cancel()
                    browser = null
                    busy = false
                }
                return@Column
            }

            Field("服务器地址", server, { server = it; error = null }, "server", KeyboardType.Uri, placeholder = "例如 192.168.1.10:4533")
            if (Hosts.isPlainOverInternet(server)) {
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.Top) {
                    KitIcon("alert", size = 14.dp, tint = c.warn)
                    Spacer(Modifier.width(6.dp))
                    Text("这是互联网上的 HTTP 地址：登录信息会以明文传输。建议使用 HTTPS。", style = Sonus.type.caption, color = c.warn)
                }
            }
            Spacer(Modifier.height(12.dp))
            Field("用户名", user, { user = it; error = null }, "user", KeyboardType.Text)
            Spacer(Modifier.height(12.dp))
            Field("密码", password, { password = it; error = null }, "password", KeyboardType.Password, secret = true, onDone = ::signIn)
            if (error != null) {
                Spacer(Modifier.height(12.dp))
                Text(error.orEmpty(), style = Sonus.type.bodySmall, color = c.bad, modifier = Modifier.testTag("signin-error"))
            }
            Spacer(Modifier.height(24.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                PillButton("登录", ::signIn, Modifier.testTag("signin"), primary = true, enabled = !busy && server.isNotBlank() && user.isNotBlank())
                PillButton("在浏览器中登录", ::signInInBrowser, Modifier.testTag("signin-browser"), enabled = !busy && server.isNotBlank(), icon = "external")
                if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = c.accent, strokeWidth = 2.dp)
            }
            Spacer(Modifier.height(16.dp))
            Text("Sonus 不会保存你的密码：只保存服务器给的登录凭证，并用这台设备的安全硬件加密。", style = Sonus.type.caption, color = c.textQuiet)
        }
    }
}

@Composable
private fun BrowserWait(start: DeviceLoginStart, reopen: () -> Unit, cancel: () -> Unit) {
    val c = Sonus.colors
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(c.raised).padding(20.dp)) {
        Text("在浏览器中完成登录", style = Sonus.type.panelHeading, color = c.text)
        Spacer(Modifier.height(8.dp))
        Text("在打开的网页上登录服务器，确认下面的代码和网页上显示的一致，然后允许 Sonus 访问。", style = Sonus.type.bodySmall, color = c.textMuted)
        Spacer(Modifier.height(16.dp))
        Text(start.userCode, style = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 30.sp, letterSpacing = 2.sp), color = c.text, modifier = Modifier.testTag("user-code"))
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            PillButton("重新打开浏览器", reopen, icon = "external")
            PillButton("取消", cancel)
            CircularProgressIndicator(Modifier.size(18.dp), color = c.accent, strokeWidth = 2.dp)
        }
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    tag: String,
    type: KeyboardType,
    secret: Boolean = false,
    placeholder: String? = null,
    onDone: (() -> Unit)? = null,
) {
    val c = Sonus.colors
    OutlinedTextField(
        value, onChange,
        modifier = Modifier.fillMaxWidth().testTag(tag),
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it, color = c.textQuiet) } },
        singleLine = true,
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = type, imeAction = if (onDone != null) ImeAction.Done else ImeAction.Next, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        shape = RoundedCornerShape(8.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = c.accent, unfocusedBorderColor = c.divider, focusedLabelColor = c.accentText, unfocusedLabelColor = c.textMuted,
            cursorColor = c.accent, focusedTextColor = c.text, unfocusedTextColor = c.text,
        ),
    )
}

/** The server's approval page, in a Custom Tab (the user's browser, with its own sign-ins), else any browser. */
private fun openBrowser(context: Context, url: String) {
    try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, url.toUri())
    } catch (_: Exception) {
        context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
