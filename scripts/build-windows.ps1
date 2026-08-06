# Build a Windows installable / portable binary for Forge Database Manager.
# Requires Windows + JDK 21+ (jpackage). Optional: WiX Toolset for .exe / .msi.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
#   powershell -File scripts\build-windows.ps1 -Type exe
#   powershell -File scripts\build-windows.ps1 -Type msi
#   powershell -File scripts\build-windows.ps1 -Type app-image
#
# Default: app-image (portable folder + zip). exe/msi need WiX Toolset 3.x.
param(
    [ValidateSet("app-image", "exe", "msi")]
    [string]$Type = "app-image"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if (-not $IsWindows -and $env:OS -ne "Windows_NT") {
    Write-Error "Windows packages must be built on Windows (jpackage cannot cross-compile)."
}

function Find-JavaHome {
    if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\jpackage.exe"))) {
        return $env:JAVA_HOME
    }
    $candidates = @(
        "${env:ProgramFiles}\Java",
        "${env:ProgramFiles}\Eclipse Adoptium",
        "${env:ProgramFiles}\Microsoft",
        "${env:LOCALAPPDATA}\Programs\Eclipse Adoptium"
    ) | Where-Object { $_ -and (Test-Path $_) }

    foreach ($base in $candidates) {
        Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "jdk-21*" -or $_.Name -like "jdk21*" } |
            ForEach-Object {
                $jp = Join-Path $_.FullName "bin\jpackage.exe"
                if (Test-Path $jp) { return $_.FullName }
            }
    }
    return $null
}

$javaHome = Find-JavaHome
if (-not $javaHome) {
    Write-Error "jpackage not found. Install JDK 21+ and set JAVA_HOME."
}
$env:JAVA_HOME = $javaHome
$env:Path = "$javaHome\bin;" + $env:Path

$arch = $env:PROCESSOR_ARCHITECTURE
switch -Regex ($arch) {
    "ARM64|aarch64" {
        $JfxPlatform = "win-aarch64"
        $ArchDir = "arm64"
        $ArchLabel = "arm64"
    }
    default {
        $JfxPlatform = "win"
        $ArchDir = "amd64"
        $ArchLabel = "x86_64"
    }
}

$AppName = "Forge Database Manager"
$AppVersion = "1.0.0"
$MainClass = "com.forgesystem.dbmanager.Launcher"
$Vendor = "Forge System"
$SrcIcon = Join-Path $Root "src\main\resources\icons\app-icon.png"
$WinIcon = Join-Path $Root "packaging\windows\AppIcon.ico"
$InputDir = Join-Path $Root "target\jpackage-input"
$DistDir = Join-Path $Root "dist\windows\$ArchDir"
$BinaryDir = Join-Path $Root "binary\windows\$ArchDir"

Write-Host "==> Target arch: $ArchDir ($ArchLabel)"
Write-Host "==> JavaFX platform: $JfxPlatform"
Write-Host "==> Package type: $Type"
Write-Host "==> Building application jars"

& mvn -q "-DskipTests" clean package `
    "-Djavafx.platform=$JfxPlatform" `
    "-Dshade.skip=true"
if ($LASTEXITCODE -ne 0) { throw "Maven package failed" }

Write-Host "==> Assembling jpackage input"
if (Test-Path $InputDir) { Remove-Item -Recurse -Force $InputDir }
New-Item -ItemType Directory -Path $InputDir | Out-Null
Copy-Item (Join-Path $Root "target\database-manager-$AppVersion.jar") $InputDir
& mvn -q dependency:copy-dependencies `
    "-Djavafx.platform=$JfxPlatform" `
    "-DoutputDirectory=$InputDir" `
    "-DincludeScope=runtime"
if ($LASTEXITCODE -ne 0) { throw "Maven dependency:copy-dependencies failed" }

Write-Host "==> Preparing Windows icon"
New-Item -ItemType Directory -Force -Path (Join-Path $Root "packaging\windows") | Out-Null
$iconArgs = @()
if (Test-Path $SrcIcon) {
    $magick = Get-Command magick -ErrorAction SilentlyContinue
    $convert = Get-Command convert -ErrorAction SilentlyContinue
    if ($magick) {
        & magick $SrcIcon -define icon:auto-resize=256,128,64,48,32,16 $WinIcon
    } elseif ($convert) {
        & convert $SrcIcon -define icon:auto-resize=256,128,64,48,32,16 $WinIcon
    } elseif (-not (Test-Path $WinIcon)) {
        Write-Host "    Warning: ImageMagick not found; building without custom .ico"
        Write-Host "    Install ImageMagick or place AppIcon.ico in packaging\windows\"
    }
    if (Test-Path $WinIcon) {
        $iconArgs = @("--icon", $WinIcon)
    }
}

Write-Host "==> Creating Windows package with jpackage"
if (Test-Path $DistDir) { Remove-Item -Recurse -Force $DistDir }
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

$year = (Get-Date).Year
$jpackageArgs = @(
    "--type", $Type,
    "--name", $AppName,
    "--app-version", $AppVersion,
    "--vendor", $Vendor,
    "--copyright", "Copyright (c) $year $Vendor",
    "--description", "Desktop database manager with embedded HTML UI",
    "--input", $InputDir,
    "--main-jar", "database-manager-$AppVersion.jar",
    "--main-class", $MainClass,
    "--dest", $DistDir,
    "--java-options", "-Dfile.encoding=UTF-8"
) + $iconArgs

if ($Type -eq "exe" -or $Type -eq "msi") {
    $jpackageArgs += @("--win-menu", "--win-shortcut")
}

& jpackage @jpackageArgs
if ($LASTEXITCODE -ne 0) { throw "jpackage failed" }

if ($Type -eq "app-image") {
    Write-Host "==> Creating portable zip"
    $appDir = Get-ChildItem -Path $DistDir -Directory | Select-Object -First 1
    if ($appDir) {
        $zipPath = Join-Path $DistDir "forge-database-manager-$AppVersion-windows-$ArchLabel.zip"
        if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
        Compress-Archive -Path $appDir.FullName -DestinationPath $zipPath
    }
}

New-Item -ItemType Directory -Force -Path $BinaryDir | Out-Null
Get-ChildItem -Path $DistDir -File -Include *.exe,*.msi,*.zip -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item $_.FullName $BinaryDir -Force }

if ($Type -eq "app-image") {
    Get-ChildItem -Path $DistDir -Directory | ForEach-Object {
        $dest = Join-Path $BinaryDir $_.Name
        if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
        Copy-Item $_.FullName $dest -Recurse
    }
}

Write-Host ""
Write-Host "Windows $ArchDir package(s) created in:"
Write-Host "  $BinaryDir"
Get-ChildItem $BinaryDir | Format-Table Name, Length, LastWriteTime
Write-Host ""
Write-Host "Run the app from the app-image folder, or install the .exe / .msi if built."
Write-Host "For exe/msi installers, install WiX Toolset 3.x then re-run with -Type exe"
