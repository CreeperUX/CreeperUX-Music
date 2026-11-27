plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.creeperux.sonus"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "com.creeperux.sonus"
        minSdk = 33 // Android 13
        targetSdk = 37
        versionCode = 4
        versionName = "0.3.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // the demo server the device tests sign in to: the PC's port 4633, which tools/test-device.ps1 forwards with adb reverse
        // (the preview ARM64 emulator's apps cannot reach 10.0.2.2); -Psonus.testServer=… for another
        testInstrumentationRunnerArguments["sonusServer"] = (project.findProperty("sonus.testServer") as String?) ?: "http://127.0.0.1:4633"
    }

    buildTypes {
        debug {
            // a test build installs beside a real one and never shares its data
            applicationIdSuffix = ".debug"
            resValue("string", "app_name", "Sonus 测试版")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            resValue("string", "app_name", "Sonus")
        }
        // the test build people install: built as a release is (R8, not debuggable, the baseline profile), so that it
        // runs as smoothly as the real one will; signed with the debug key and named as the debug build, so it updates
        // an installed "Sonus 测试版" in place. Compose in a debuggable build is much slower on a phone.
        create("preview") {
            initWith(getByName("release"))
            applicationIdSuffix = ".debug"
            resValue("string", "app_name", "Sonus 测试版")
            signingConfig = signingConfigs.getByName("debug")
            isProfileable = true // frame and trace tools may look at it (dumpsys gfxinfo works either way)
            matchingFallbacks += "release"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        resValues = true
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            // no native runtime on Windows ARM64 (see src/test/resources/robolectric.properties)
            it.systemProperty("robolectric.graphicsMode", "LEGACY")
            it.systemProperty("robolectric.sqliteMode", "LEGACY")
            it.systemProperty("robolectric.conscryptMode", "OFF")
        }
        animationsDisabled = true
    }

    packaging {
        resources.excludes += setOf("META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.coroutines.android)
    implementation(libs.coroutines.guava)
    implementation(libs.core.ktx)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.process)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)
    implementation(libs.media3.okhttp)
    implementation(libs.coil.compose)
    implementation(libs.coil.okhttp)
    implementation(libs.browser)
    implementation(libs.profileinstaller)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.truth)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.coroutines.test)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.truth)
    androidTestImplementation(libs.uiautomator)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
}
