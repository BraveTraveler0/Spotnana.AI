# Builds the Android APK.
#
#   npm run android:apk                      release APK for a phone (arm64), signed with your own key
#   npm run android:apk -- -Mode debug -Target x86_64    debug build for the emulator
#
# The build does NOT run inside the repo. The repo lives in OneDrive, and Gradle and the Rust
# compiler write gigabytes of build output that OneDrive would try to sync (file locks, sync
# storms) with paths long enough to trip Windows' 260-character limit. So the source is copied to
# a short local folder first (build output stays there between runs, so later builds are fast) and
# the finished APK is copied out to $Out.
#
# The signing key is made once and lives in ~/.artemis-android (outside the repo and OneDrive). It
# is what lets a newer APK install over an older one: keep a backup of that folder.
param(
  [ValidateSet('release', 'debug')][string]$Mode = 'release',
  [string]$Target = 'aarch64',
  [string]$Work = 'C:\build\artemis',
  [string]$Out = 'C:\build\artemis-out'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# ---- toolchain (Android Studio's own JDK, the SDK it manages, the NDK installed next to it)
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$ndk = Get-ChildItem (Join-Path $env:ANDROID_HOME 'ndk') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if (-not $ndk) { throw 'No Android NDK found. Install one with the SDK manager (ndk;27.2.12479018).' }
$env:NDK_HOME = $ndk.FullName
$cmake = Get-ChildItem (Join-Path $env:ANDROID_HOME 'cmake') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;" + $(if ($cmake) { "$($cmake.FullName)\bin;" } else { '' }) + $env:PATH

# ---- signing key, made once
$keyDir = Join-Path $env:USERPROFILE '.artemis-android'
$keystore = Join-Path $keyDir 'artemis-release.jks'
if (-not (Test-Path $keystore)) {
  New-Item -ItemType Directory -Force $keyDir | Out-Null
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $password = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  # keytool reports its progress on stderr, which PowerShell would otherwise treat as a failure.
  $stop = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore $keystore -alias artemis -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass $password -keypass $password -dname 'CN=Artemis AI, O=Artemis, C=US' 2>&1 | Out-Null
  $keytoolExit = $LASTEXITCODE
  $ErrorActionPreference = $stop
  if ($keytoolExit -ne 0 -or -not (Test-Path $keystore)) { throw 'Could not create the signing key.' }
  # Without its password file the key is unusable, so a key with no
  # password file is removed rather than left behind.
  try {
    Set-Content -Path (Join-Path $keyDir 'keystore.properties') -Value @("password=$password", 'keyAlias=artemis', ('storeFile=' + ($keystore -replace '\\', '/')))
  } catch {
    Remove-Item $keystore -Force -ErrorAction SilentlyContinue
    throw
  }
  Write-Host "Created your signing key in $keyDir. Back that folder up: without it a new APK can't install over the old one."
}

# ---- copy the source out of OneDrive (build output, dependencies and the personal feed stay behind)
New-Item -ItemType Directory -Force $Work, $Out | Out-Null
robocopy $repo $Work /MIR /XD node_modules target dist .git .claude iris-feed build .gradle /XF *.msi *.exe *.zip *.log local.properties /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the source failed (robocopy $LASTEXITCODE)." }

# ---- JavaScript dependencies, reinstalled only when package-lock.json changes
Push-Location $Work
try {
  $lockHash = (Get-FileHash 'package-lock.json').Hash
  # The marker lives inside node_modules: the mirror above deletes anything in $Work that the repo doesn't have,
  # except the folders it was told to leave alone.
  $marker = Join-Path $Work 'node_modules\.artemis-lock-hash'
  if (-not (Test-Path $marker) -or (Get-Content $marker) -ne $lockHash) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    Set-Content $marker $lockHash
  }

  $buildArgs = @('tauri', 'android', 'build', '--apk', '--target', $Target)
  if ($Mode -eq 'debug') { $buildArgs += '--debug' }

  # Tauri links the compiled library into the Gradle project with a symlink, and Windows only allows
  # that in Developer Mode (or as admin). Everything up to the link still succeeds, so when that is
  # the only thing that fails the library is copied in here and Gradle runs without its Rust step.
  $tauriLog = Join-Path $Work 'tauri-android-build.log'
  $stop = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  npx @buildArgs 2>&1 | Tee-Object -FilePath $tauriLog | ForEach-Object { "$_" }
  $tauriExit = $LASTEXITCODE
  $ErrorActionPreference = $stop
  if ($tauriExit -ne 0) {
    if (-not (Select-String -Path $tauriLog -Pattern 'symbolic link is not allowed' -Quiet)) { throw 'tauri android build failed.' }
    Write-Host ''
    Write-Host 'Windows would not create the symlink (Developer Mode is off); linking the library by copying it instead.'
    $triple = @{ aarch64 = 'aarch64-linux-android'; armv7 = 'armv7-linux-androideabi'; x86_64 = 'x86_64-linux-android'; i686 = 'i686-linux-android' }[$Target]
    $abi = @{ aarch64 = 'arm64-v8a'; armv7 = 'armeabi-v7a'; x86_64 = 'x86_64'; i686 = 'x86' }[$Target]
    $arch = @{ aarch64 = 'arm64'; armv7 = 'arm'; x86_64 = 'x86_64'; i686 = 'x86' }[$Target]
    if (-not $triple) { throw "Unknown target '$Target'." }
    $profileName = if ($Mode -eq 'debug') { 'debug' } else { 'release' }
    $lib = "src-tauri\target\$triple\$profileName\libartemis_ai_lib.so"
    if (-not (Test-Path $lib)) { throw "The Rust build did not produce $lib." }
    $jni = "src-tauri\gen\android\app\src\main\jniLibs\$abi"
    New-Item -ItemType Directory -Force $jni | Out-Null
    Copy-Item $lib $jni -Force
    $archCap = $arch.Substring(0, 1).ToUpper() + $arch.Substring(1)
    $profileCap = $profileName.Substring(0, 1).ToUpper() + $profileName.Substring(1)
    Push-Location 'src-tauri\gen\android'
    try {
      & .\gradlew.bat "assemble$archCap$profileCap" -x "rustBuild$archCap$profileCap" "-PabiList=$abi" "-ParchList=$arch" "-PtargetList=$Target"
      if ($LASTEXITCODE -ne 0) { throw 'Gradle build failed.' }
    } finally {
      Pop-Location
    }
  }

  $apk = Get-ChildItem 'src-tauri\gen\android\app\build\outputs\apk' -Recurse -Filter *.apk | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $apk) { throw 'The build finished but no APK was found.' }
  $dest = Join-Path $Out "Artemis-$Mode-$Target.apk"
  Copy-Item $apk.FullName $dest -Force
  Write-Host ''
  Write-Host "APK: $dest  ($([math]::Round((Get-Item $dest).Length / 1MB, 1)) MB)"
} finally {
  Pop-Location
}
