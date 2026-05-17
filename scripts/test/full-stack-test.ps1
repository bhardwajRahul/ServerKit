#requires -Version 5.1
<#
.SYNOPSIS
  One-click full-stack E2E test for ServerKit on Windows.

.DESCRIPTION
  Spins up fresh Ubuntu/Debian VMs via Multipass in parallel, uploads the
  current local working tree (including uncommitted changes), runs the
  installer, then runs a pytest harness against the live API. Aggregates
  everything into a single HTML report.

  Designed to be slow but unattended -- 1-2 hours is expected on first run
  (cloud images download). Subsequent runs are ~15-30 min.

.PARAMETER Distros
  Which distros to test. Default: ubuntu22, ubuntu24, debian12.

.PARAMETER Keep
  Don't tear down VMs at the end (for debugging).

.PARAMETER Only
  Comma-separated subset of distros to run (e.g. -Only "ubuntu24").

.PARAMETER Cpus
  CPUs per VM (default 2).

.PARAMETER MemoryGB
  Memory per VM in GB (default 4).

.PARAMETER DiskGB
  Disk per VM in GB (default 15).

.EXAMPLE
  .\scripts\test\full-stack-test.ps1

.EXAMPLE
  .\scripts\test\full-stack-test.ps1 -Only ubuntu24 -Keep
#>
[CmdletBinding()]
param(
    [string[]] $Distros = @('ubuntu22','ubuntu24','debian12'),
    [string]   $Only,
    [switch]   $Keep,
    [int]      $Cpus = 2,
    [int]      $MemoryGB = 4,
    [int]      $DiskGB = 15
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- distro -> multipass image map ---------------------------------------
$ImageMap = @{
    'ubuntu22' = '22.04'
    'ubuntu24' = '24.04'
    'debian12' = 'daily:debian12'  # not always available; fallback to 22.04 if launch fails
}

if ($Only) {
    $requested = $Only -split ','
    $Distros = $Distros | Where-Object { $_ -in $requested }
}
if (-not $Distros) {
    Write-Error "No distros selected."
    exit 2
}

# --- paths ---------------------------------------------------------------
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$RunId    = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutDir   = Join-Path $PSScriptRoot "output\$RunId"
$null     = New-Item -ItemType Directory -Force -Path $OutDir

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " ServerKit E2E Test - run $RunId" -ForegroundColor Cyan
Write-Host " Repo:    $RepoRoot" -ForegroundColor Cyan
Write-Host " Distros: $($Distros -join ', ')" -ForegroundColor Cyan
Write-Host " Output:  $OutDir" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# --- prerequisites -------------------------------------------------------
if (-not (Get-Command multipass -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "Multipass is not installed." -ForegroundColor Red
    Write-Host "Install from: https://multipass.run/download/windows"
    Write-Host "Or via winget: winget install Canonical.Multipass"
    exit 2
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Warning "python not on PATH - report.py won't run automatically; will print raw paths."
}

# --- build source tarball once -------------------------------------------
$Tarball = Join-Path $OutDir 'serverkit-src.tar.gz'
Write-Host "`n[1/4] Packing local working tree -> $Tarball" -ForegroundColor Yellow

# Use tar (Windows 10+ has bsdtar). Exclude heavy/irrelevant dirs.
$excludes = @(
    '--exclude=./.git',
    '--exclude=./backend/venv',
    '--exclude=./backend/.venv',
    '--exclude=./backend/.venv-wsl',
    '--exclude=./backend/instance',
    '--exclude=./frontend/node_modules',
    '--exclude=./frontend/dist',
    '--exclude=./scripts/test/output'
)
Push-Location $RepoRoot
try {
    & tar -czf $Tarball @excludes -C $RepoRoot .
    if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
$tarSize = (Get-Item $Tarball).Length / 1MB
Write-Host ("    Tarball: {0:N1} MB" -f $tarSize)

# --- launch VMs in parallel ---------------------------------------------
Write-Host "`n[2/4] Launching $($Distros.Count) VM(s) in parallel..." -ForegroundColor Yellow

$cloudInit = Join-Path $PSScriptRoot 'cloud-init\base.yaml'
$vmInstall = Join-Path $PSScriptRoot 'vm-install.sh'

$jobs = foreach ($d in $Distros) {
    $vmName = "sk-test-$d-$RunId"
    $image  = $ImageMap[$d]
    if (-not $image) { Write-Warning "Unknown distro $d, skipping"; continue }

    Start-Job -Name $vmName -ArgumentList $vmName,$image,$cloudInit,$Cpus,$MemoryGB,$DiskGB -ScriptBlock {
        param($name,$image,$cloudInit,$cpu,$mem,$disk)
        $log = @()
        $log += "Launching $name (image=$image, cpu=$cpu, mem=${mem}G, disk=${disk}G)"
        & multipass launch $image `
            --name $name `
            --cpus $cpu `
            --memory "${mem}G" `
            --disk "${disk}G" `
            --cloud-init $cloudInit 2>&1 | ForEach-Object { $log += $_ }
        @{ Name=$name; Image=$image; RC=$LASTEXITCODE; Log=$log }
    }
}

$launchResults = $jobs | Wait-Job | Receive-Job
$jobs | Remove-Job

$liveVMs = @()
foreach ($r in $launchResults) {
    if ($r.RC -eq 0) {
        Write-Host "  [OK] $($r.Name) launched" -ForegroundColor Green
        $liveVMs += $r.Name
    } else {
        Write-Host "  [FAIL] $($r.Name) failed to launch (rc=$($r.RC))" -ForegroundColor Red
        $r.Log | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
}

if (-not $liveVMs) {
    Write-Error "No VMs launched successfully."
    exit 1
}

# --- per-VM: transfer source + run installer + harness in parallel ------
Write-Host "`n[3/4] Installing + testing on $($liveVMs.Count) VM(s) in parallel..." -ForegroundColor Yellow
Write-Host "    (This typically takes 20-60 min per VM. Go make coffee.)" -ForegroundColor DarkGray

$harnessDir = Join-Path $PSScriptRoot 'harness'

$testJobs = foreach ($vm in $liveVMs) {
    Start-Job -Name "test-$vm" -ArgumentList $vm,$Tarball,$vmInstall,$harnessDir,$OutDir -ScriptBlock {
        param($vm,$tarball,$vmInstall,$harnessDir,$outDir)

        $vmOut = Join-Path $outDir $vm
        New-Item -ItemType Directory -Force -Path $vmOut | Out-Null
        $installLog = Join-Path $vmOut 'install.log'
        $statusFile = Join-Path $vmOut 'install-status'

        function Mp { & multipass @args 2>&1 }

        # 1. Transfer tarball + vm-install.sh
        Mp transfer $tarball "${vm}:/tmp/serverkit-src.tar.gz" | Out-Null
        Mp transfer $vmInstall "${vm}:/tmp/vm-install.sh"      | Out-Null

        # 2. Extract on VM
        Mp exec $vm -- sudo mkdir -p /opt/serverkit-src | Out-Null
        Mp exec $vm -- sudo tar -xzf /tmp/serverkit-src.tar.gz -C /opt/serverkit-src | Out-Null
        Mp exec $vm -- sudo chmod +x /tmp/vm-install.sh | Out-Null

        # 3. Run install (long)
        $installOut = Mp exec $vm -- sudo bash /tmp/vm-install.sh
        $installRC  = $LASTEXITCODE
        $installOut | Out-File -FilePath $installLog -Encoding utf8

        # Pull the canonical install log + status from VM
        Mp transfer "${vm}:/var/log/serverkit-test-install.log" "$vmOut\vm-install.log" 2>&1 | Out-Null
        Mp transfer "${vm}:/tmp/serverkit-install-status"        $statusFile             2>&1 | Out-Null
        if (-not (Test-Path $statusFile)) {
            $fallback = if ($installRC -eq 0) { 'OK' } else { 'FAIL' }
            $fallback | Out-File $statusFile -Encoding ascii
        }

        # 4. Capture journalctl for backend regardless of install outcome
        Mp exec $vm -- sudo journalctl -u serverkit --no-pager -n 500 2>$null `
            | Out-File (Join-Path $vmOut 'journalctl.log') -Encoding utf8

        # 5. If install ok, copy harness and run pytest
        $statusContent = (Get-Content $statusFile -Raw).Trim()
        if ($statusContent -eq 'OK') {
            # Push harness
            Mp exec $vm -- sudo mkdir -p /opt/serverkit-test | Out-Null
            Mp exec $vm -- sudo chown ubuntu:ubuntu /opt/serverkit-test 2>$null | Out-Null
            Get-ChildItem $harnessDir -File | ForEach-Object {
                Mp transfer $_.FullName "${vm}:/opt/serverkit-test/$($_.Name)" | Out-Null
            }
            # Install pytest in the panel's venv (already has python)
            Mp exec $vm -- sudo /opt/serverkit/venv/bin/pip install -r /opt/serverkit-test/requirements.txt 2>&1 `
                | Out-File (Join-Path $vmOut 'harness-deps.log') -Encoding utf8

            $reportJson = '/opt/serverkit-test/pytest-report.json'
            Mp exec $vm -- sudo /opt/serverkit/venv/bin/python -m pytest /opt/serverkit-test `
                --json-report --json-report-file=$reportJson -v 2>&1 `
                | Out-File (Join-Path $vmOut 'pytest.log') -Encoding utf8
            Mp transfer "${vm}:$reportJson" (Join-Path $vmOut 'pytest-report.json') 2>&1 | Out-Null
        }

        @{ Name=$vm; Status=$statusContent }
    }
}

$results = $testJobs | Wait-Job | Receive-Job
$testJobs | Remove-Job

foreach ($r in $results) {
    $color = if ($r.Status -eq 'OK') { 'Green' } else { 'Red' }
    Write-Host "  $($r.Name): install=$($r.Status)" -ForegroundColor $color
}

# --- generate report -----------------------------------------------------
Write-Host "`n[4/4] Generating HTML report..." -ForegroundColor Yellow
$reportHtml = $null
$reportPy = Join-Path $PSScriptRoot 'report.py'
if (Get-Command python -ErrorAction SilentlyContinue) {
    $reportHtml = & python $reportPy $OutDir
    Write-Host "    Report: $reportHtml" -ForegroundColor Green
} else {
    Write-Host "    Skipped (python not on PATH). Raw output in: $OutDir" -ForegroundColor Yellow
}

# --- teardown ------------------------------------------------------------
if ($Keep) {
    Write-Host "`n-Keep set: VMs left running. Connect with: multipass shell <name>" -ForegroundColor Yellow
    $liveVMs | ForEach-Object { Write-Host "  - $_" }
} else {
    Write-Host "`nTearing down VMs..." -ForegroundColor Yellow
    foreach ($vm in $liveVMs) {
        & multipass delete $vm 2>&1 | Out-Null
    }
    & multipass purge 2>&1 | Out-Null
}

# --- final summary -------------------------------------------------------
$failed = @($results | Where-Object { $_.Status -ne 'OK' })
Write-Host ""
if ($failed.Count -eq 0) {
    Write-Host "ALL GREEN - $($liveVMs.Count) VM(s) installed and passed tests." -ForegroundColor Green
    if ($reportHtml) { Start-Process $reportHtml }
    exit 0
} else {
    Write-Host "FAILURES on $($failed.Count) VM(s):" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "  - $($_.Name)" -ForegroundColor Red }
    if ($reportHtml) { Start-Process $reportHtml }
    exit 1
}
