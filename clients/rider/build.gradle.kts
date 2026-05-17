plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "dev.devradar"
version = "0.2.3"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // Built against IntelliJ IDEA Community; the plugin only uses generic
        // platform APIs, so it also loads in Rider, PyCharm, GoLand, etc.
        intellijIdeaCommunity("2024.2.5")
        instrumentationTools()
    }
    implementation("com.google.code.gson:gson:2.10.1")
}

intellijPlatform {
    buildSearchableOptions = false
    pluginConfiguration {
        name = "devradar"
        ideaVersion {
            sinceBuild = "242"
            untilBuild = provider { null }
        }
    }
}

kotlin {
    jvmToolchain(21)
}

tasks {
    wrapper {
        gradleVersion = "8.10.2"
    }
}
