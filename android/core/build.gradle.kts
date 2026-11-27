plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}



java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
}

dependencies {
    api(libs.coroutines.core)
    api(libs.serialization.json)
    api(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.truth)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

tasks.test {
    // the demo server test (DemoServerTest) starts tools/demo-server with node when it is on the PATH
    systemProperty("sonus.repo", rootProject.projectDir.parentFile.absolutePath)
    // another checkout's demo server and protocol files (one with a newer demo server than this one has)
    systemProperty("sonus.demoRepo", System.getenv("SONUS_DEMO_REPO").orEmpty())
    // RealGitHubTest reads the real GitHub's release list only when asked: -Psonus.realGitHub
    if (project.hasProperty("sonus.realGitHub")) systemProperty("sonus.realGitHub", "1")
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
