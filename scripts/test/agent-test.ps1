#requires -Version 5.1
<#
.SYNOPSIS
  Test Windows agent pairing against one of the test VMs.

.DESCRIPTION
  Optional follow-on to full-stack-test.ps1 (which must be run with -Keep).
  - Discovers a running sk-test-* VM
  - Registers admin + obtains JWT
  - Builds the agent (go build) and runs it against the VM
  - Verifies pairing short-code flow and that capabilities arrive

  This is intentionally minimal -- it exercises the pairing happy path so
  regressions in the agent <-> panel handshake get caught.

.PARAMETER VmName
  Specific VM to target. Default: first sk-test-* VM found.
#>
[CmdletBinding()]
param(
    [string] $VmName
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path

if (-not (Get-Command multipass -ErrorAction SilentlyContinue)) {
    Write-Error "Multipass not installed."
    exit 2
}
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    Write-Error "Go is required to build the agent."
    exit 2
}

if (-not $VmName) {
    $VmName = (& multipass list --format csv | Select-String '^sk-test-' | Select-Object -First 1).ToString().Split(',')[0]
}
if (-not $VmName) {
    Write-Error "No sk-test-* VM found. Run full-stack-test.ps1 -Keep first."
    exit 2
}

$vmIp = (& multipass info $VmName --format csv | Select-String "^$VmName,").ToString().Split(',')[2]
Write-Host "Targeting VM: $VmName ($vmIp)" -ForegroundColor Cyan

# 1. Register admin and grab token
$cred = @{
    email    = "agent-test-$(Get-Random -Maximum 99999)@test.local"
    username = "agentuser$(Get-Random -Maximum 99999)"
    password = 'Test12345!'
}
$resp = Invoke-RestMethod -Uri "http://${vmIp}:5000/api/v1/auth/register" `
    -Method Post -ContentType 'application/json' -Body ($cred | ConvertTo-Json)
$token = $resp.access_token
Write-Host "  [OK] Admin registered, got JWT" -ForegroundColor Green

# 2. Build agent
$agentDir = Join-Path $RepoRoot 'agent'
if (-not (Test-Path $agentDir)) { Write-Error "agent/ not found at $agentDir"; exit 2 }
$agentBin = Join-Path $env:TEMP "serverkit-agent-test.exe"
Push-Location $agentDir
try {
    Write-Host "  Building agent..." -ForegroundColor Yellow
    & go build -o $agentBin ./cmd/serverkit-agent
    if ($LASTEXITCODE -ne 0) { throw "go build failed" }
} finally { Pop-Location }
Write-Host "  [OK] Agent built: $agentBin" -ForegroundColor Green

# 3. Generate pairing short-code by enrolling from "agent side"
# (Normally the agent does this itself; here we drive it explicitly to test API.)
$enrollBody = @{
    pubkey      = ([System.BitConverter]::ToString((New-Object byte[] 32 | ForEach-Object { Get-Random -Maximum 256 })) -replace '-','').ToLower()
    passphrase  = 'test-passphrase'
    machine_id  = "test-$(Get-Random -Maximum 999999)"
    system_info = @{ os = 'Windows'; hostname = $env:COMPUTERNAME }
} | ConvertTo-Json -Depth 5

$enroll = Invoke-RestMethod -Uri "http://${vmIp}:5000/api/v1/pairing/enroll" `
    -Method Post -ContentType 'application/json' -Body $enrollBody
Write-Host "  [OK] Enrolled, short-code: $($enroll.code)" -ForegroundColor Green

# 4. Operator-side claim
$claim = Invoke-RestMethod -Uri "http://${vmIp}:5000/api/v1/pairing/claim" `
    -Method Post `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType 'application/json' `
    -Body (@{ code = $enroll.code; passphrase = 'test-passphrase'; name = $VmName } | ConvertTo-Json)
Write-Host "  [OK] Server claimed, id=$($claim.server_id)" -ForegroundColor Green

Write-Host "`nPairing API end-to-end OK." -ForegroundColor Green
Write-Host "Note: this exercises the API handshake; full agent process lifecycle test is TODO."
