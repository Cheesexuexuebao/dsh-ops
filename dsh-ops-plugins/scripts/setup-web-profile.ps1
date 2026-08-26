# Install ops plugins into the local web profile (~/.dsh/profiles/web).
# Uses repo root derived from this script — no hard-coded D: paths.
param(
  [string]$Profile = "web"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$plugins = @(
  "ssh-connection",
  "ssh-ops",
  "ssh-monitor",
  "ops-workspace",
  "ops-skin"
)

foreach ($name in $plugins) {
  $path = Join-Path $Root $name
  if (-not (Test-Path (Join-Path $path "package.json"))) {
    throw "Missing plugin: $path"
  }
  Write-Host "dsh plugin --profile $Profile add $path"
  dsh plugin --profile $Profile add $path
}

Write-Host "Done. From deepseek-harness root: pnpm dsh web"
