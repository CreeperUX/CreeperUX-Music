// The Android client of Sonus: `core` is plain Kotlin (the Subsonic client, the library, the queue: what the Windows
// app's Sonus.Core does), tested on the JVM; `app` is the Android app on top of it.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
