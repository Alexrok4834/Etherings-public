val roomSqliteTempDir = file(".gradle/room-sqlite-tmp").apply { mkdirs() }
System.setProperty("org.sqlite.tmpdir", roomSqliteTempDir.absolutePath)

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "EtheringsAndroid"
include(":app")
