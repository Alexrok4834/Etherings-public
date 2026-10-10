import java.security.MessageDigest
import java.util.Base64

plugins {
    id("com.android.application")
}

val releaseSigningEnvironment = mapOf(
    "path" to providers.environmentVariable("ETHERINGS_ALPHA_ANDROID_KEYSTORE_PATH").orNull,
    "storePassword" to providers.environmentVariable("ETHERINGS_ALPHA_ANDROID_KEYSTORE_PASSWORD").orNull,
    "alias" to providers.environmentVariable("ETHERINGS_ALPHA_ANDROID_KEY_ALIAS").orNull,
    "keyPassword" to providers.environmentVariable("ETHERINGS_ALPHA_ANDROID_KEY_PASSWORD").orNull,
).mapValues { (_, value) -> value?.takeIf { it.isNotBlank() } }
val hasAnyReleaseSigningValue = releaseSigningEnvironment.values.any { it != null }
val hasCompleteReleaseSigningEnvironment = releaseSigningEnvironment.values.all { it != null }

if (hasAnyReleaseSigningValue && !hasCompleteReleaseSigningEnvironment) {
    throw GradleException("Alpha release signing environment is incomplete.")
}

val releaseKeystoreFile = releaseSigningEnvironment["path"]?.let { file(it).canonicalFile }
if (releaseKeystoreFile != null && releaseKeystoreFile.toPath().startsWith(rootProject.projectDir.canonicalFile.toPath())) {
    throw GradleException("Alpha release keystore must be outside the repository.")
}

android {
    namespace = "xyz.etherings.alpha"
    compileSdk = 36

    defaultConfig {
        applicationId = "xyz.etherings.alpha"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1-alpha"
        buildConfigField("String", "ALPHA_API_BASE_URL", "\"\"")
        buildConfigField("String", "ALPHA_BINDING_ENVIRONMENT", "\"\"")
        buildConfigField("String", "RELEASE_CHANNEL", "\"alpha\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasCompleteReleaseSigningEnvironment) {
            create("alphaRelease") {
                storeFile = releaseKeystoreFile
                storePassword = releaseSigningEnvironment.getValue("storePassword")
                keyAlias = releaseSigningEnvironment.getValue("alias")
                keyPassword = releaseSigningEnvironment.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("String", "ALPHA_API_BASE_URL", "\"http://127.0.0.1:19081\"")
            buildConfigField("String", "ALPHA_BINDING_ENVIRONMENT", "\"alpha-local\"")
            val gatewayPolicy = providers.gradleProperty("alphaGatewayPolicyFile").orNull
                ?.let { file(it).readBytes() }
            val encodedPolicy = gatewayPolicy?.let { Base64.getEncoder().encodeToString(it) } ?: ""
            buildConfigField("String", "ALPHA_GATEWAY_POLICY_B64", "\"$encodedPolicy\"")
            val silverPolicy = providers.gradleProperty("alphaSilverPolicyFile").orNull
                ?.let { file(it).readBytes() }
            val encodedSilverPolicy = silverPolicy?.let { Base64.getEncoder().encodeToString(it) } ?: ""
            buildConfigField("String", "ALPHA_SILVER_POLICY_B64", "\"$encodedSilverPolicy\"")
            val silverGenesis = providers.gradleProperty("alphaSilverGenesisHash").orNull ?: ""
            require(silverGenesis.isEmpty() || silverGenesis.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}"))) {
                "Alpha Silver proof genesis hash is not a base58 address"
            }
            buildConfigField("String", "ALPHA_SILVER_GENESIS_HASH", "\"$silverGenesis\"")
            buildConfigField("String", "ALPHA_SILVER_RPC_URL", "\"http://127.0.0.1:19082\"")
        }
        release {
            buildConfigField("String", "ALPHA_GATEWAY_POLICY_B64", "\"\"")
            buildConfigField("String", "ALPHA_SILVER_POLICY_B64", "\"\"")
            buildConfigField("String", "ALPHA_SILVER_GENESIS_HASH", "\"\"")
            buildConfigField("String", "ALPHA_SILVER_RPC_URL", "\"\"")
            if (hasCompleteReleaseSigningEnvironment) {
                signingConfig = signingConfigs.getByName("alphaRelease")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

gradle.taskGraph.whenReady {
    val releasePackagingRequested = allTasks.any { task ->
        task.project == project && task.name in setOf(
            "packageRelease", "assembleRelease", "bundleRelease"
        )
    }
    if (releasePackagingRequested && !hasCompleteReleaseSigningEnvironment) {
        throw GradleException("Alpha release packaging requires separate Alpha signing inputs.")
    }
}

dependencies {
    val walletCoreAar = file("libs/wallet-core-4.8.2.aar")
    require(walletCoreAar.isFile) { "Trust Wallet Core 4.8.2 AAR is missing" }
    val digest = MessageDigest.getInstance("SHA-256")
    walletCoreAar.inputStream().use { input ->
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    require(digest.digest().joinToString("") { "%02x".format(it) } ==
            "6ae99d5a58108c4b6e4fb7c5438540fe53ba9e690711630974732b1f2cc0413d") {
        "Trust Wallet Core 4.8.2 AAR checksum mismatch"
    }
    implementation(files(walletCoreAar))
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
