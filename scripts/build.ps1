[CmdletBinding()]
param(
    [string]$OutputDir = "dist"
)

$ErrorActionPreference = "Stop"

$RootPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OutputRoot = [System.IO.Path]::GetFullPath((Join-Path $RootPath $OutputDir))

function Assert-InRepo {
    param([string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $fullPath.StartsWith($RootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside repo: $fullPath"
    }
    return $fullPath
}

function Remove-DirectoryInRepo {
    param([string]$Path)

    $fullPath = Assert-InRepo $Path
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
}

function New-ExtensionZip {
    param(
        [string]$SourceDir,
        [string]$ZipPath
    )

    $sourceFullPath = Assert-InRepo $SourceDir
    $zipFullPath = Assert-InRepo $ZipPath

    if (Test-Path -LiteralPath $zipFullPath) {
        Remove-Item -LiteralPath $zipFullPath -Force
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $sourceRoot = [System.IO.Path]::GetFullPath($sourceFullPath).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )

    $zipStream = [System.IO.File]::Open($zipFullPath, [System.IO.FileMode]::CreateNew)
    try {
        $archive = New-Object System.IO.Compression.ZipArchive(
            $zipStream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false
        )
        try {
            $files = Get-ChildItem -LiteralPath $sourceRoot -File -Recurse
            foreach ($file in $files) {
                $relativePath = $file.FullName.Substring($sourceRoot.Length).TrimStart(
                    [System.IO.Path]::DirectorySeparatorChar,
                    [System.IO.Path]::AltDirectorySeparatorChar
                )
                $entryName = $relativePath -replace "\\", "/"
                $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
                $entryStream = $entry.Open()
                $fileStream = [System.IO.File]::OpenRead($file.FullName)
                try {
                    $fileStream.CopyTo($entryStream)
                }
                finally {
                    $fileStream.Dispose()
                    $entryStream.Dispose()
                }
            }
        }
        finally {
            $archive.Dispose()
        }
    }
    finally {
        $zipStream.Dispose()
    }
}

function Copy-ExtensionFiles {
    param([string]$PackageDir, [string]$IconFile)

    $rootFiles = Get-ChildItem -LiteralPath $RootPath -File | Where-Object {
        $_.Extension -in @(".js", ".html", ".css") -or
        $_.Name -eq "LICENSE"
    }

    foreach ($file in $rootFiles) {
        Copy-Item -LiteralPath $file.FullName -Destination $PackageDir
    }

    Copy-Item -LiteralPath (Join-Path $RootPath $IconFile) -Destination $PackageDir
}

function New-ManifestVariant {
    param(
        [ValidateSet("chrome", "firefox")]
        [string]$Browser,
        [string]$IconFile
    )

    $manifest = Get-Content -Raw -LiteralPath (Join-Path $RootPath "manifest.json") | ConvertFrom-Json

    if ($Browser -eq "chrome") {
        $manifest.icons = [ordered]@{ "128" = $IconFile }
        if ($manifest.PSObject.Properties.Name -contains "browser_specific_settings") {
            $manifest.PSObject.Properties.Remove("browser_specific_settings")
        }
        if ($manifest.PSObject.Properties.Name -contains "background" -and
            $manifest.background.PSObject.Properties.Name -contains "scripts") {
            $manifest.background.PSObject.Properties.Remove("scripts")
        }
    }
    else {
        $manifest.icons = [ordered]@{ "96" = $IconFile }
        if ($manifest.PSObject.Properties.Name -contains "background") {
            $backgroundScript = "background.js"
            if ($manifest.background.PSObject.Properties.Name -contains "service_worker") {
                $backgroundScript = $manifest.background.service_worker
                $manifest.background.PSObject.Properties.Remove("service_worker")
            }
            if (-not ($manifest.background.PSObject.Properties.Name -contains "scripts")) {
                $manifest.background | Add-Member -NotePropertyName "scripts" -NotePropertyValue @($backgroundScript)
            }
        }
        else {
            $manifest | Add-Member -NotePropertyName "background" -NotePropertyValue ([ordered]@{
                scripts = @("background.js")
            })
        }
    }

    $manifest.action.default_icon = $IconFile
    return $manifest
}

function Write-Package {
    param(
        [ValidateSet("chrome", "firefox")]
        [string]$Browser,
        [string]$IconFile,
        [string]$Version
    )

    $packageDir = Assert-InRepo (Join-Path $OutputRoot $Browser)
    New-Item -ItemType Directory -Path $packageDir -Force | Out-Null

    Copy-ExtensionFiles -PackageDir $packageDir -IconFile $IconFile

    $manifest = New-ManifestVariant -Browser $Browser -IconFile $IconFile
    $manifestPath = Join-Path $packageDir "manifest.json"
    $json = $manifest | ConvertTo-Json -Depth 32
    $json = $json -replace "\\u003c", "<" -replace "\\u003e", ">" -replace "\\u0026", "&"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($manifestPath, $json + [System.Environment]::NewLine, $utf8NoBom)

    Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json | Out-Null

    $zipPath = Assert-InRepo (Join-Path $OutputRoot ("volume-control-$Browser-v$Version.zip"))
    New-ExtensionZip -SourceDir $packageDir -ZipPath $zipPath

    Write-Host "Created $zipPath"
}

Push-Location $RootPath
try {
    foreach ($requiredFile in @("manifest.json", "ico.svg", "chrome.png")) {
        if (-not (Test-Path -LiteralPath (Join-Path $RootPath $requiredFile))) {
            throw "Required file is missing: $requiredFile"
        }
    }

    $baseManifest = Get-Content -Raw -LiteralPath (Join-Path $RootPath "manifest.json") | ConvertFrom-Json
    $version = $baseManifest.version

    Remove-DirectoryInRepo $OutputRoot
    New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null

    Write-Package -Browser "firefox" -IconFile "ico.svg" -Version $version
    Write-Package -Browser "chrome" -IconFile "chrome.png" -Version $version
}
finally {
    Pop-Location
}
