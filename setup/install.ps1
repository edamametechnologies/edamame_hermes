<#
.SYNOPSIS
    Installs EDAMAME for Hermes (global per-user install) on Windows.

.DESCRIPTION
    PowerShell equivalent of setup/install.sh for Windows environments.
    Copies package files, renders config templates, and prints next steps.

.PARAMETER WorkspaceRoot
    Path to the workspace root. Defaults to the current directory.

.EXAMPLE
    .\setup\install.ps1
    .\setup\install.ps1 -WorkspaceRoot "C:\Users\me\projects\myapp"
#>
[CmdletBinding()]
param(
    [string]$WorkspaceRoot = ""
)

$ErrorActionPreference = "Stop"

$SourceRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not $WorkspaceRoot) { $WorkspaceRoot = Get-Location }
$WorkspaceRoot = (Resolve-Path $WorkspaceRoot).Path

$ConfigHome = Join-Path $env:APPDATA "hermes-edamame"
$StateHome  = Join-Path $env:LOCALAPPDATA "hermes-edamame\state"
$DataHome   = Join-Path $env:LOCALAPPDATA "hermes-edamame"

$InstallRoot = Join-Path $DataHome "current"
$ConfigPath  = Join-Path $ConfigHome "config.json"
$HermesMcpPath = Join-Path $ConfigHome "hermes-mcp.json"

$NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeBin) { $NodeBin = "node" }

foreach ($dir in @($ConfigHome, $StateHome, $DataHome)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

if (Test-Path $InstallRoot) { Remove-Item -Recurse -Force $InstallRoot }
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null

$DirsToInstall = @(
    "bridge", "adapters", "prompts", "service",
    "docs", "tests", "setup", ".hermes-plugin",
    "agents", "commands", "assets", "skills"
)
foreach ($d in $DirsToInstall) {
    $src = Join-Path $SourceRoot $d
    if (Test-Path $src) {
        Copy-Item -Recurse -Force $src (Join-Path $InstallRoot $d)
    }
}

$FilesToInstall = @("package.json", "README.md", ".mcp.json")
foreach ($f in $FilesToInstall) {
    $src = Join-Path $SourceRoot $f
    if (Test-Path $src) { Copy-Item -Force $src (Join-Path $InstallRoot $f) }
}

# --- Template rendering ---
$WorkspaceBasename = Split-Path -Leaf $WorkspaceRoot
$HashBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash(
    [System.Text.Encoding]::UTF8.GetBytes($WorkspaceRoot)
)
$HashHex = -join ($HashBytes | ForEach-Object { $_.ToString("x2") })
$AgentInstanceId = "$env:COMPUTERNAME-$($HashHex.Substring(0,12))"
$PskPath = Join-Path $StateHome "edamame-mcp.psk"

function PortablePath($p) { $p -replace '\\', '/' }

function Render-Template($Src, $Dst) {
    $content = Get-Content -Raw $Src
    $content = $content `
        -replace '__PACKAGE_ROOT__',                  (PortablePath $InstallRoot) `
        -replace '__CONFIG_PATH__',                   (PortablePath $ConfigPath) `
        -replace '__WORKSPACE_ROOT__',                (PortablePath $WorkspaceRoot) `
        -replace '__WORKSPACE_BASENAME__',            $WorkspaceBasename `
        -replace '__DEFAULT_AGENT_INSTANCE_ID__',     $AgentInstanceId `
        -replace '__DEFAULT_HOST_KIND__',             'edamame_app' `
        -replace '__DEFAULT_POSTURE_CLI_COMMAND__',   '' `
        -replace '__STATE_DIR__',                     (PortablePath $StateHome) `
        -replace '__EDAMAME_MCP_PSK_FILE__',          (PortablePath $PskPath) `
        -replace '__NODE_BIN__',                      (PortablePath $NodeBin)
    $parent = Split-Path -Parent $Dst
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Set-Content -Path $Dst -Value $content -Encoding UTF8
}

$ConfigTemplate = Join-Path $InstallRoot "setup\hermes-edamame-config.template.json"
if ((-not (Test-Path $ConfigPath)) -and (Test-Path $ConfigTemplate)) {
    Render-Template $ConfigTemplate $ConfigPath
}

$McpTemplate = Join-Path $InstallRoot "setup\hermes-mcp.template.json"
if (Test-Path $McpTemplate) {
    Render-Template $McpTemplate $HermesMcpPath
}

# --- MCP auto-injection into ~/.hermes/config.yaml (mcp_servers.edamame) ---
# Hermes declares MCP servers as YAML under a top-level `mcp_servers:` mapping.
# The key MUST be "edamame" to match server_key in builtin_supported_agents() /
# index.json so the EDAMAME app can list and clean the MCP state. PowerShell has
# no built-in YAML parser, so we splice line-by-line (idempotent on the
# `edamame:` child) the same way setup/install.sh's no-PyYAML fallback does.
$HermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:USERPROFILE ".hermes" }
$HermesConfigPath = Join-Path $HermesHome "config.yaml"

function Convert-YamlScalar($Value) {
    # A JSON double-quoted scalar is also a valid YAML double-quoted scalar.
    return ([string]$Value | ConvertTo-Json -Compress)
}

function New-EdamameYamlEntry($Command, $ArgList, $ChildIndent) {
    $item = $ChildIndent + "  "
    $arg  = $item + "  "
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add($ChildIndent + "edamame:")
    $lines.Add($item + "type: stdio")
    $lines.Add($item + "command: " + (Convert-YamlScalar $Command))
    $lines.Add($item + "args:")
    foreach ($a in $ArgList) { $lines.Add($arg + "- " + (Convert-YamlScalar $a)) }
    return $lines
}

try {
    $SnippetContent = Get-Content -Raw $HermesMcpPath | ConvertFrom-Json
    $Entry = $SnippetContent.mcpServers.'edamame'
    if ($Entry) {
        $Command = if ($Entry.command) { $Entry.command } else { $NodeBin }
        $ArgList = @($Entry.args)

        $ConfigDir = Split-Path -Parent $HermesConfigPath
        if ($ConfigDir -and -not (Test-Path $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null }

        if (Test-Path $HermesConfigPath) {
            Copy-Item -Force $HermesConfigPath "$HermesConfigPath.bak"
            $Existing = Get-Content -Raw $HermesConfigPath
        } else {
            $Existing = ""
        }

        $Lines = if ($Existing.Length -gt 0) { [System.Collections.Generic.List[string]]@($Existing -split "`r?`n") } else { New-Object System.Collections.Generic.List[string] }

        # Locate the top-level `mcp_servers:` key (no leading whitespace).
        $MsIdx = -1
        for ($i = 0; $i -lt $Lines.Count; $i++) {
            $line = $Lines[$i]
            if ($line.Length -eq 0) { continue }
            if ($line[0] -eq ' ' -or $line[0] -eq "`t") { continue }
            $stripped = $line.Trim()
            $keyPart = ($stripped -split ":", 2)[0].Trim()
            if ($keyPart -eq "mcp_servers") { $MsIdx = $i; break }
        }

        if ($MsIdx -lt 0) {
            $block = New-Object System.Collections.Generic.List[string]
            $block.Add("mcp_servers:")
            foreach ($l in (New-EdamameYamlEntry $Command $ArgList "  ")) { $block.Add($l) }
            if ($Existing.Trim().Length -gt 0) {
                $NewText = $Existing.TrimEnd() + "`n`n" + ($block -join "`n") + "`n"
            } else {
                $NewText = ($block -join "`n") + "`n"
            }
            Set-Content -Path $HermesConfigPath -Value $NewText -Encoding UTF8 -NoNewline
        } else {
            # Normalize inline content (`mcp_servers: {}`) to block style.
            $headerAfter = (($Lines[$MsIdx] -split ":", 2)[1]).Trim()
            if ($headerAfter -ne "" -and $headerAfter -ne "{}") {
                Write-Warning "mcp_servers had inline content; rewriting as block style"
            }
            $Lines[$MsIdx] = "mcp_servers:"

            $blockStart = $MsIdx + 1
            # Learn child indent from first non-blank child line (default 2).
            $childIndent = "  "
            for ($j = $blockStart; $j -lt $Lines.Count; $j++) {
                $ln = $Lines[$j]
                if ($ln.Trim().Length -eq 0) { continue }
                $indent = $ln.Length - $ln.TrimStart().Length
                if ($indent -eq 0) { break }
                $childIndent = $ln.Substring(0, $indent)
                break
            }

            # Block runs until next top-level (indent 0) non-blank line or EOF.
            $blockEnd = $blockStart
            $k = $blockStart
            while ($k -lt $Lines.Count) {
                $ln = $Lines[$k]
                if ($ln.Trim().Length -ne 0 -and ($ln.Length - $ln.TrimStart().Length) -eq 0) { break }
                $blockEnd = $k + 1
                $k++
            }

            $ci = $childIndent.Length
            $cleaned = New-Object System.Collections.Generic.List[string]
            $skipping = $false
            for ($m = $blockStart; $m -lt $blockEnd; $m++) {
                $ln = $Lines[$m]
                $indent = $ln.Length - $ln.TrimStart().Length
                $stripped = $ln.Trim()
                if (-not $skipping) {
                    if ($indent -eq $ci -and $stripped.StartsWith("edamame:")) { $skipping = $true; continue }
                    $cleaned.Add($ln)
                } else {
                    if ($stripped.Length -eq 0 -or $indent -gt $ci) { continue }
                    $skipping = $false
                    $cleaned.Add($ln)
                }
            }

            $newInner = New-Object System.Collections.Generic.List[string]
            foreach ($l in (New-EdamameYamlEntry $Command $ArgList $childIndent)) { $newInner.Add($l) }
            foreach ($l in $cleaned) { $newInner.Add($l) }

            $final = New-Object System.Collections.Generic.List[string]
            for ($p = 0; $p -lt $blockStart; $p++) { $final.Add($Lines[$p]) }
            foreach ($l in $newInner) { $final.Add($l) }
            for ($p = $blockEnd; $p -lt $Lines.Count; $p++) { $final.Add($Lines[$p]) }

            $NewText = (($final -join "`n").TrimEnd()) + "`n"
            Set-Content -Path $HermesConfigPath -Value $NewText -Encoding UTF8 -NoNewline
        }
    }
} catch {
    Write-Warning "Could not inject Hermes MCP entry: $_"
}

Write-Host @"

Installed EDAMAME for Hermes to:
  $InstallRoot

Primary config:
  $ConfigPath

Hermes MCP snippet:
  $HermesMcpPath

MCP server registered automatically in ~\.hermes\config.yaml

Next steps:
1. Launch Hermes and run the edamame_hermes_control_center tool.
2. Click 'Request pairing from app' in the control center, or paste a PSK manually.
3. Run: node "$InstallRoot\service\healthcheck_cli.mjs" --strict --json
"@
