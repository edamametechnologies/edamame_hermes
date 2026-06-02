<#
.SYNOPSIS
    Runs the EDAMAME for Hermes healthcheck on Windows.
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

& node (Join-Path $RootDir "service\healthcheck_cli.mjs") @Args
exit $LASTEXITCODE
