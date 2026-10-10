import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("androidx.room")
}

val releaseSigningEnvironment = mapOf(
    "path" to providers.environmentVariable("ETHERINGS_ANDROID_KEYSTORE_PATH").orNull,
    "storePassword" to providers.environmentVariable("ETHERINGS_ANDROID_KEYSTORE_PASSWORD").orNull,
    "alias" to providers.environmentVariable("ETHERINGS_ANDROID_KEY_ALIAS").orNull,
    "keyPassword" to providers.environmentVariable("ETHERINGS_ANDROID_KEY_PASSWORD").orNull,
).mapValues { (_, value) -> value?.takeIf { it.isNotBlank() } }
val hasAnyReleaseSigningValue = releaseSigningEnvironment.values.any { it != null }
val hasCompleteReleaseSigningEnvironment = releaseSigningEnvironment.values.all { it != null }

if (hasAnyReleaseSigningValue && !hasCompleteReleaseSigningEnvironment) {
    throw GradleException("Android release signing environment is incomplete.")
}

val releaseKeystoreFile = releaseSigningEnvironment["path"]?.let { file(it).canonicalFile }
if (releaseKeystoreFile != null && releaseKeystoreFile.toPath().startsWith(rootProject.projectDir.canonicalFile.toPath())) {
    throw GradleException("Android release keystore must be outside the repository.")
}

android {
    namespace = "xyz.etherings.player"
    compileSdk = 36
    testBuildType = if (providers.gradleProperty("alphaSilverReviewTest").orNull == "true")
        "alphaDev" else "debug"

    defaultConfig {
        applicationId = "xyz.etherings.player"
        minSdk = 28
        targetSdk = 36
        versionCode = 17
        versionName = "0.1.16"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "ETHERINGS_API_BASE_URL", "\"https://api.etherings.xyz\"")
        buildConfigField("String", "ALPHA_DEV_API_BASE_URL", "\"\"")
        buildConfigField("String", "ALPHA_SILVER_RPC_URL", "\"\"")
        buildConfigField("boolean", "IS_ALPHA_DEV", "false")
        buildConfigField("boolean", "ALPHA_SILVER_CANDIDATE_REVIEW_ENABLED", "false")
        buildConfigField("boolean", "ALPHA_SILVER_OPENING_SIGN_ENABLED", "false")
        buildConfigField("boolean", "RAFFLE_V2_PAID_DRAW_ENABLED", "false")
    }

    signingConfigs {
        if (hasCompleteReleaseSigningEnvironment) {
            create("release") {
                storeFile = releaseKeystoreFile
                storePassword = releaseSigningEnvironment.getValue("storePassword")
                keyAlias = releaseSigningEnvironment.getValue("alias")
                keyPassword = releaseSigningEnvironment.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("boolean", "RAFFLE_V2_PAID_DRAW_ENABLED", "true")
            if (providers.gradleProperty("alphaWalletSmoke").orNull == "true") {
                applicationIdSuffix = ".walletsmoke"
            }
        }
        create("alphaDev") {
            initWith(getByName("debug"))
            val walletBindingProof = providers.gradleProperty("alphaWalletBindingProof").orNull == "true"
            applicationIdSuffix = if (walletBindingProof) ".alphadev.walletproof" else ".alphadev"
            manifestPlaceholders["alphaDevAppLabel"] = if (walletBindingProof) "EtheRings Wallet Proof" else "EtheRings Alpha Dev"
            matchingFallbacks += listOf("debug")
            buildConfigField("String", "ETHERINGS_API_BASE_URL", "\"\"")
            buildConfigField("String", "ALPHA_DEV_API_BASE_URL", "\"https://alpha-dev.example.invalid\"")
            buildConfigField("String", "ALPHA_SILVER_RPC_URL", "\"https://alpha-dev.example.invalid/rpc/devnet\"")
            buildConfigField("String", "ALPHA_SILVER_IPFS_GATEWAY", "\"https://tomato-giant-orangutan-407.mypinata.cloud/ipfs/\"")
            buildConfigField("String", "ALPHA_SILVER_PROGRAM_ID", "\"3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX\"")
            buildConfigField("String", "ALPHA_BINDING_ENVIRONMENT", "\"alpha-local\"")
            buildConfigField("boolean", "ALPHA_SILVER_CANDIDATE_REVIEW_ENABLED", "true")
            buildConfigField("boolean", "ALPHA_SILVER_OPENING_SIGN_ENABLED", "true")
            buildConfigField("boolean", "IS_ALPHA_DEV", "true")
        }
        release {
            buildConfigField("String", "ETHERINGS_API_BASE_URL", "\"https://api.etherings.xyz\"")
            buildConfigField("boolean", "RAFFLE_V2_PAID_DRAW_ENABLED", "true")
            if (hasCompleteReleaseSigningEnvironment) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        create("alphaRelease") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
            buildConfigField("String", "ETHERINGS_API_BASE_URL", "\"\"")
            buildConfigField("String", "ALPHA_DEV_API_BASE_URL", "\"https://api.etherings.xyz\"")
            buildConfigField("String", "ALPHA_SILVER_RPC_URL", "\"https://api.etherings.xyz/rpc/devnet\"")
            buildConfigField("String", "ALPHA_SILVER_IPFS_GATEWAY", "\"https://tomato-giant-orangutan-407.mypinata.cloud/ipfs/\"")
            buildConfigField("String", "ALPHA_SILVER_PROGRAM_ID", "\"3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX\"")
            buildConfigField("String", "ALPHA_BINDING_ENVIRONMENT", "\"alpha-public\"")
            buildConfigField("boolean", "ALPHA_SILVER_CANDIDATE_REVIEW_ENABLED", "true")
            buildConfigField("boolean", "ALPHA_SILVER_OPENING_SIGN_ENABLED", "true")
            buildConfigField("boolean", "IS_ALPHA_DEV", "true")
        }
    }

    sourceSets.getByName("alphaRelease").java.srcDir("src/alphaDev/java")

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }

}

androidComponents {
    onVariants(selector().withBuildType("alphaDev")) { variant ->
        variant.outputs.forEach {
            it.versionName.set("0.5.0a")
            it.versionCode.set(40)
        }
    }
    onVariants(selector().withBuildType("alphaRelease")) { variant ->
        val alphaVersionName = providers.gradleProperty("alphaReleaseVersionName").orNull ?: "1.2.1a"
        val alphaVersionCode = (providers.gradleProperty("alphaReleaseVersionCode").orNull ?: "48")
            .toIntOrNull() ?: throw GradleException("alphaReleaseVersionCode must be an integer")
        require(alphaVersionName.isNotBlank() && alphaVersionCode > 17) {
            "Alpha release version must be named and newer than MVP versionCode 17"
        }
        variant.outputs.forEach {
            it.versionName.set(alphaVersionName)
            it.versionCode.set(alphaVersionCode)
        }
    }
}

gradle.taskGraph.whenReady {
    val releasePackagingRequested = allTasks.any { task ->
        task.project == project && task.name in setOf(
            "packageRelease",
            "assembleRelease",
            "bundleRelease",
            "packageAlphaRelease",
            "assembleAlphaRelease",
            "bundleAlphaRelease",
        )
    }
    if (releasePackagingRequested && !hasCompleteReleaseSigningEnvironment) {
        throw GradleException(
            "Signed Android release packaging requires the approved environment-only signing inputs.",
        )
    }
}

room {
    schemaDirectory("$projectDir/schemas")
}

dependencies {
    val walletCoreAar = file("libs/wallet-core-4.8.2.aar")
    require(walletCoreAar.isFile) { "Verified Trust Wallet Core 4.8.2 AAR is missing" }
    val digest = MessageDigest.getInstance("SHA-256")
    walletCoreAar.inputStream().use { input ->
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
    require(actualHash == "6ae99d5a58108c4b6e4fb7c5438540fe53ba9e690711630974732b1f2cc0413d") {
        "Trust Wallet Core 4.8.2 AAR checksum mismatch"
    }
    implementation(files(walletCoreAar))

    implementation("androidx.room:room-runtime:2.8.4")
    implementation("androidx.work:work-runtime:2.11.1")
    implementation("com.google.zxing:core:3.5.4")
    annotationProcessor("androidx.room:room-compiler:2.8.4")

    testImplementation("junit:junit:4.13.2")
    testImplementation("androidx.test:core:1.7.0")
    testImplementation("androidx.room:room-testing:2.8.4")
    testImplementation("androidx.work:work-testing:2.11.1")
    testImplementation("org.robolectric:robolectric:4.16.1")
    androidTestImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
