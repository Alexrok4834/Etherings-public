param(
    [Parameter(Mandatory = $true)][string]$KeystorePath,
    [switch]$PasswordFromClipboard
)

$ErrorActionPreference = 'Stop'
$expectedCert = 'D5:B4:E5:BC:88:5F:44:4E:F0:12:67:51:E1:0B:CB:E5:53:A6:83:7F:43:94:79:74:8D:DD:64:DC:E4:F5:6D:C9'
$keystore = (Resolve-Path -LiteralPath $KeystorePath -ErrorAction Stop).Path
$androidRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
$gradle = @(Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.gradle\wrapper\dists\gradle-9.4.1-bin') `
    -Filter 'gradle.bat' -File -Recurse -ErrorAction Stop)
if ($gradle.Count -ne 1) { throw 'Expected one installed Gradle 9.4.1 binary.' }
if (-not (Test-Path -LiteralPath $keytool -PathType Leaf)) {
    throw 'JAVA_HOME does not contain keytool.exe.'
}
if (-not (Test-Path -LiteralPath $keystore -PathType Leaf)) {
    throw 'Production keystore file is missing.'
}

function Reveal([Security.SecureString]$secure) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$storeSecure = $null
$clipboardPassword = $null
if ($PasswordFromClipboard) {
    $clipboardPassword = Get-Clipboard -Raw
    Set-Clipboard -Value ''
    if ([string]::IsNullOrEmpty($clipboardPassword) -or $clipboardPassword -match '[\r\n]') {
        throw 'Clipboard must contain exactly one nonempty password line.'
    }
} else {
    $storeSecure = Read-Host 'Your single password for the .p12 keystore and its private key (hidden)' -AsSecureString
}
try {
    $env:ETHERINGS_ANDROID_KEYSTORE_PATH = $keystore
    $env:ETHERINGS_ANDROID_KEYSTORE_PASSWORD = if ($PasswordFromClipboard) {
        $clipboardPassword
    } else {
        Reveal $storeSecure
    }

    $certificate = & $keytool -list -v -storetype PKCS12 `
        -keystore $keystore -storepass:env ETHERINGS_ANDROID_KEYSTORE_PASSWORD 2>&1
    if ($LASTEXITCODE -ne 0) {
        if (($certificate -join "`n") -match 'keystore password was incorrect') {
            throw 'The password for the .p12 keystore file is incorrect.'
        }
        throw 'Could not open the .p12 keystore file with keytool.'
    }
    $listing = $certificate -join "`n"
    $aliases = @([regex]::Matches($listing, '(?m)^Alias name:\s*(.+?)\s*$'))
    if ($aliases.Count -ne 1 -or $listing -notmatch 'Entry type: PrivateKeyEntry') {
        throw 'Expected exactly one private-key entry in the production keystore.'
    }
    $alias = $aliases[0].Groups[1].Value
    $fingerprint = [regex]::Match($listing, 'SHA256:\s*([0-9A-Fa-f:]+)').Groups[1].Value
    if ($fingerprint.Replace(':', '').ToUpperInvariant() -ne $expectedCert.Replace(':', '')) {
        throw 'Keystore certificate does not match the recorded production signer.'
    }
    Write-Host "Production signer certificate matched; key alias: $alias"
    $env:ETHERINGS_ANDROID_KEY_ALIAS = $alias
    $env:ETHERINGS_ANDROID_KEY_PASSWORD = $env:ETHERINGS_ANDROID_KEYSTORE_PASSWORD

    Push-Location $androidRoot
    try {
        $versionNameArg = '-PalphaReleaseVersionName=1.2.1a'
        $versionCodeArg = '-PalphaReleaseVersionCode=48'
        & $gradle[0].FullName --offline --no-daemon --max-workers=1 $versionNameArg `
            $versionCodeArg :app:assembleAlphaRelease
        if ($LASTEXITCODE -ne 0) { throw "Alpha release build failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }

    $apks = @(Get-ChildItem -LiteralPath (Join-Path $androidRoot 'app\build\outputs\apk\alphaRelease') `
        -Filter '*.apk' -File -ErrorAction Stop)
    if ($apks.Count -ne 1) { throw 'Expected exactly one Alpha release APK.' }
    $hash = (Get-FileHash -LiteralPath $apks[0].FullName -Algorithm SHA256).Hash
    Write-Host "Signed Alpha APK: $($apks[0].FullName)"
    Write-Host "Size: $($apks[0].Length) bytes; SHA-256: $hash"
} finally {
    Remove-Item Env:ETHERINGS_ANDROID_KEYSTORE_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:ETHERINGS_ANDROID_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:ETHERINGS_ANDROID_KEY_ALIAS -ErrorAction SilentlyContinue
    Remove-Item Env:ETHERINGS_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
    $clipboardPassword = $null
    if ($storeSecure) { $storeSecure.Dispose() }
}
