<#
.SYNOPSIS
    Uninstalls EDAMAME for Hermes on Windows.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$UserProfile = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$AppDataRoot = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $UserProfile "AppData\Roaming" }
$LocalAppDataRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $UserProfile "AppData\Local" }

$ConfigHome = Join-Path $AppDataRoot "hermes-edamame"
$StateHome = Join-Path $LocalAppDataRoot "hermes-edamame\state"
$DataHome = Join-Path $LocalAppDataRoot "hermes-edamame"
$HermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $UserProfile ".hermes" }
$HermesConfigPath = Join-Path $HermesHome "config.yaml"

function Remove-HermesMcpEntry {
    param([Parameter(Mandatory = $true)][string]$ConfigPath)
    if (-not (Test-Path $ConfigPath)) { return }
    $Raw = Get-Content -Raw $ConfigPath
    if (-not $Raw.Contains("edamame")) { return }

    $Lines = [System.Collections.Generic.List[string]]@($Raw -split "`r?`n")

    # Locate the top-level `mcp_servers:` key.
    $MsIdx = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $line = $Lines[$i]
        if ($line.Length -eq 0) { continue }
        if ($line[0] -eq ' ' -or $line[0] -eq "`t") { continue }
        $keyPart = (($line.Trim()) -split ":", 2)[0].Trim()
        if ($keyPart -eq "mcp_servers") { $MsIdx = $i; break }
    }
    if ($MsIdx -lt 0) { return }

    $blockStart = $MsIdx + 1
    $blockEnd = $blockStart
    $k = $blockStart
    while ($k -lt $Lines.Count) {
        $ln = $Lines[$k]
        if ($ln.Trim().Length -ne 0 -and ($ln.Length - $ln.TrimStart().Length) -eq 0) { break }
        $blockEnd = $k + 1
        $k++
    }

    # Determine child indent from first non-blank child line (default 2).
    $ci = 2
    for ($j = $blockStart; $j -lt $blockEnd; $j++) {
        if ($Lines[$j].Trim().Length -eq 0) { continue }
        $ci = $Lines[$j].Length - $Lines[$j].TrimStart().Length
        break
    }

    $cleaned = New-Object System.Collections.Generic.List[string]
    $skipping = $false
    $found = $false
    for ($m = $blockStart; $m -lt $blockEnd; $m++) {
        $ln = $Lines[$m]
        $indent = $ln.Length - $ln.TrimStart().Length
        $stripped = $ln.Trim()
        if (-not $skipping) {
            if ($indent -eq $ci -and $stripped.StartsWith("edamame:")) { $skipping = $true; $found = $true; continue }
            $cleaned.Add($ln)
        } else {
            if ($stripped.Length -eq 0 -or $indent -gt $ci) { continue }
            $skipping = $false
            $cleaned.Add($ln)
        }
    }
    if (-not $found) { return }

    Copy-Item -Force $ConfigPath "$ConfigPath.bak"

    $hasRemaining = $false
    foreach ($l in $cleaned) { if ($l.Trim().Length -ne 0) { $hasRemaining = $true; break } }

    $final = New-Object System.Collections.Generic.List[string]
    if ($hasRemaining) {
        for ($p = 0; $p -lt $blockStart; $p++) { $final.Add($Lines[$p]) }
        foreach ($l in $cleaned) { $final.Add($l) }
        for ($p = $blockEnd; $p -lt $Lines.Count; $p++) { $final.Add($Lines[$p]) }
    } else {
        # Drop the now-empty mcp_servers: header too.
        for ($p = 0; $p -lt $MsIdx; $p++) { $final.Add($Lines[$p]) }
        for ($p = $blockEnd; $p -lt $Lines.Count; $p++) { $final.Add($Lines[$p]) }
    }

    $NewText = (($final -join "`n").TrimEnd()) + "`n"
    Set-Content -Path $ConfigPath -Value $NewText -Encoding UTF8 -NoNewline
}

Remove-HermesMcpEntry -ConfigPath $HermesConfigPath

foreach ($PathToRemove in @($DataHome, $ConfigHome, $StateHome)) {
    if (Test-Path $PathToRemove) {
        Remove-Item -Recurse -Force $PathToRemove
    }
}

Write-Host @"
Uninstalled EDAMAME for Hermes from:
  $DataHome
"@
