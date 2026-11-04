<#
.SYNOPSIS
  Risen Team Schedule Builder - local Windows launcher.

.DESCRIPTION
  Starts the bundled Next.js standalone server on loopback only and opens the
  browser once the application has confirmed it is healthy.

  Design rules this script is written against:

    * Fixed port 3178, bound to 127.0.0.1 only. Nothing is reachable from the
      local network, and nothing about the port is configurable by accident.
    * Normal launch never runs `npm install` and never runs `npm run build`.
      The launcher only starts an already-built standalone server. If no build
      exists it says so and stops; it does not start a multi-minute build from
      a double-click.
    * A second launch does not start a second server. It probes
      `/api/health`, and if the answer carries the Risen application identity
      it simply opens the browser against the running instance.
    * An unrelated service already listening on 3178 is NEVER killed, never
      stopped and never "replaced". The launcher reports it and exits non-zero.
    * The browser is opened only after a successful health response, so the
      operator never lands on a connection-refused tab.
    * Portable user data and logs use %LOCALAPPDATA%\RisenTeamSchedule-v1.0.
      A source checkout keeps its existing data/risen-team.db when present.
      An explicit RISEN_DB_PATH always wins over either default.

.PARAMETER NoBrowser
  Start (or attach to) the server without opening a browser.

.PARAMETER TimeoutSeconds
  How long to wait for the freshly started server to answer `/api/health`.

.EXAMPLE
  .\start.bat
  .\start.bat --NoBrowser
#>

[CmdletBinding()]
param(
  [switch]$NoBrowser,
  [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------
# Constants. These are the launcher contract; they are deliberately not
# configurable from the environment so a stray variable cannot point the
# launcher at another machine or another port.
# --------------------------------------------------------------------------
$AppIdentity      = 'risen-team-schedule-builder-v1'
$Port             = 3178
$BindAddress      = '127.0.0.1'
$BaseUrl          = "http://${BindAddress}:${Port}"
$HealthUrl        = "${BaseUrl}/api/health"
$MinimumNodeMajor = 22
$DataFolderName   = 'RisenTeamSchedule-v1.0'
$PackageFolderName = 'RisenTeamSchedule'
$LogFilesToKeep   = 5

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot   = Split-Path -Parent $ScriptDir

Write-Host "Risen Team Schedule Builder" -ForegroundColor Cyan
Write-Host "Application folder : $AppRoot"

# --------------------------------------------------------------------------
# Paths: source checkouts preserve copied schedule data when present.
# Portable releases use a versioned OS user-data folder.
# --------------------------------------------------------------------------
function Resolve-DatabasePath {
  $explicit = $env:RISEN_DB_PATH
  if (-not [string]::IsNullOrWhiteSpace($explicit)) {
    # Explicit override wins, and is reported so an operator can see which
    # database the launch is actually using.
    Write-Host "Database (override): $([System.IO.Path]::GetFullPath($explicit.Trim()))"
    return [System.IO.Path]::GetFullPath($explicit.Trim())
  }

  # Preserve an existing database copied with this source checkout. Portable
  # staging excludes data/, so extracted releases use the versioned OS folder.
  $sourceDatabase = Join-Path $AppRoot 'data\risen-team.db'
  if (Test-Path -LiteralPath $sourceDatabase -PathType Leaf) {
    Write-Host "Database (source)  : $sourceDatabase"
    return $sourceDatabase
  }

  $base = $env:LOCALAPPDATA
  if ([string]::IsNullOrWhiteSpace($base)) {
    $base = Join-Path $env:USERPROFILE 'AppData\Local'
  }
  $path = Join-Path (Join-Path $base $DataFolderName) 'risen-team.db'
  Write-Host "Database           : $path"
  return $path
}

$DatabasePath = Resolve-DatabasePath
$DataDirectory = Split-Path -Parent $DatabasePath
$LogDirectory = Join-Path $DataDirectory 'logs'

function Ensure-Directory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

# --------------------------------------------------------------------------
# Node resolution: a Node runtime bundled with the portable release is always
# preferred, because it is the exact version the bundle was built against. A
# system Node is used only as a fallback, and only when it is new enough.
# --------------------------------------------------------------------------
function Resolve-NodeExecutable {
  $bundled = Join-Path $AppRoot 'runtime\node\node.exe'
  if (Test-Path -LiteralPath $bundled) {
    Write-Host "Node (bundled)     : $bundled"
    return $bundled
  }

  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $command) {
    throw @"
Node.js was not found.

Install Node.js $MinimumNodeMajor or newer from https://nodejs.org and run this
launcher again, or ship a bundled runtime in:
  $bundled
"@
  }

  $versionText = & node.exe --version 2>$null
  if ($versionText -match 'v(\d+)\.') {
    $major = [int]$Matches[1]
    if ($major -lt $MinimumNodeMajor) {
      throw @"
Node.js $versionText is too old. Node $MinimumNodeMajor or newer is required.

Update Node.js from https://nodejs.org and run this launcher again.
"@
    }
    Write-Host "Node (system)      : $($command.Source) ($versionText)"
  } else {
    Write-Host "Node (system)      : $($command.Source)"
  }
  return $command.Source
}

# --------------------------------------------------------------------------
# Health probing. A probe answers three distinct things:
#   1. is anything listening at all?
#   2. if so, does it identify itself as this application?
#   3. what status/body did it return?
# Those must stay separate: an unrelated service on the port and a Risen
# instance with a broken database are handled in completely different ways.
# --------------------------------------------------------------------------
function Read-AppIdentity {
  param([string]$Body)
  if ([string]::IsNullOrWhiteSpace($Body)) { return $null }
  try { $parsed = $Body | ConvertFrom-Json } catch { return $null }
  if ($parsed -and $parsed.PSObject.Properties['app']) { return [string]$parsed.app }
  return $null
}

function Get-HealthStatus {
  $status = [pscustomobject]@{ Reachable = $false; Identity = $null; StatusCode = 0 }

  try {
    $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3
    $status.Reachable = $true
    $status.StatusCode = [int]$response.StatusCode
    $status.Identity = Read-AppIdentity -Body $response.Content
    return $status
  } catch {
    # A 500 from our own route still carries the identity, and it arrives as an
    # exception under Windows PowerShell 5.1, so the body has to be recovered
    # from the response stream rather than discarded.
    $httpResponse = $null
    if ($_.Exception.PSObject.Properties['Response']) { $httpResponse = $_.Exception.Response }
    if (-not $httpResponse) { return $status }

    $status.Reachable = $true
    try { $status.StatusCode = [int]$httpResponse.StatusCode } catch { $status.StatusCode = 0 }
    try {
      $stream = $httpResponse.GetResponseStream()
      if ($stream.CanSeek) { $stream.Position = 0 }
      $reader = New-Object System.IO.StreamReader($stream)
      $body = $reader.ReadToEnd()
      $reader.Dispose()
      $status.Identity = Read-AppIdentity -Body $body
    } catch { }
    return $status
  }
}

$Probe = Get-HealthStatus

if ($Probe.Reachable -and $Probe.Identity -eq $AppIdentity) {
  if ($Probe.StatusCode -eq 200) {
    # Repeated launch: reuse the running instance instead of fighting for the port.
    Write-Host "Already running - opening the existing instance." -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process $BaseUrl }
    Write-Host $BaseUrl
    exit 0
  }

  $statusDetail = if ($Probe.StatusCode -gt 0) { " (HTTP $($Probe.StatusCode))" } else { "" }
  Write-Error @"
Risen Team Schedule Builder is already running on port $Port, but its health check is failing$statusDetail. Close/restart the existing Risen process and check the server log.
"@
  exit 5
}

if ($Probe.Reachable) {
  # Something else owns the port. Never kill it: this machine is shared with
  # whatever the operator was already doing.
  $described = if ($Probe.Identity) { "another application ('$($Probe.Identity)')" } else { 'an unrelated service' }
  Write-Error @"
Port $Port is already in use by $described, not by $AppIdentity.

This launcher will not stop or replace another application. Either close that
application yourself, or free the port and run this launcher again.
"@
  exit 4
}

# --------------------------------------------------------------------------
# Locate an already-built standalone server. This is the only place the
# launcher looks for the application; it never builds it.
#
# SOURCE CHECKOUT vs END-USER PACKAGE:
#   - Source checkout: `npm run build` alone produces `.next/standalone`
#     WITHOUT `.next/static` and `public` copied into the standalone folder.
#     Launching that directly would show unstyled HTML.
#     The root launcher therefore prefers the prepared portable staging
#     `dist/portable/RisenTeamSchedule/` which is known to be complete.
#   - Portable release: AppRoot itself contains server.js + .next/static + public.
#   - If only an incomplete `.next/standalone` exists, we fail clearly and tell
#     the developer to run `npm run prepare:portable` instead of opening a broken UI.
# --------------------------------------------------------------------------
function Test-CompleteServerDirectory {
  param([string]$Dir)
  if ([string]::IsNullOrWhiteSpace($Dir)) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $Dir 'server.js'))) { return $false }
  # Next.js standalone requires `.next/static` to be present alongside the server
  # for CSS/JS to be served. Without it the browser shows unstyled HTML.
  if (-not (Test-Path -LiteralPath (Join-Path $Dir '.next\static'))) { return $false }
  return $true
}

function Resolve-ServerDirectory {
  $candidates = @(
    # 1. Preferred: prepared portable staging from a source checkout.
    (Join-Path $AppRoot "dist\portable\$PackageFolderName\server.js"),
    # 2. Portable release itself (AppRoot is the extracted folder).
    (Join-Path $AppRoot 'server.js'),
    # 3. Plain `npm run build` in a developer checkout - only if complete.
    (Join-Path $AppRoot '.next\standalone\server.js')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $dir = Split-Path -Parent $candidate
      if (Test-CompleteServerDirectory -Dir $dir) {
        return $dir
      }
    }
  }
  return $null
}

$ServerDirectory = Resolve-ServerDirectory

if (-not $ServerDirectory) {
  # Detect incomplete standalone to give a precise developer instruction.
  $standaloneServer = Join-Path $AppRoot '.next\standalone\server.js'
  $standaloneDir = Join-Path $AppRoot '.next\standalone'
  if (Test-Path -LiteralPath $standaloneServer) {
    if (-not (Test-Path -LiteralPath (Join-Path $standaloneDir '.next\static'))) {
      Write-Error @"
Incomplete production build found in:
  $standaloneDir

Next.js standalone output does NOT automatically contain .next/static and public
in the correct runtime location. Launching it directly would show unstyled HTML
and a stuck loading screen.

Fix it by staging a complete portable bundle:

  npm run build
  npm run prepare:portable

Then launch either:
  dist\portable\$PackageFolderName\start.bat   (preferred, complete)
  or re-run this root start.bat which will now pick the prepared package.

The end-user ZIP always runs the prepared portable layout and never this incomplete
standalone folder.
"@
      exit 3
    }
  }

  Write-Error @"
No built application was found in:
  $AppRoot

This launcher intentionally does not install dependencies or build the app.
Build it once, then launch:

  npm ci
  npm run build
  npm run prepare:portable

After that, start either:
  dist\portable\$PackageFolderName\start.bat   (source checkout, preferred)
  or the extracted portable release's own start.bat (end-user)

Both work offline with no further npm commands.
"@
  exit 3
}

Write-Host "Server             : $(Join-Path $ServerDirectory 'server.js')"

# Nothing is created on disk until the launcher knows it can actually start
# something, so a mistaken run leaves no stray user-data folder behind.
Ensure-Directory -Path $DataDirectory
Ensure-Directory -Path $LogDirectory

# --------------------------------------------------------------------------
# Launcher logs live beside the user data, rotate, and never touch the
# application folder.
# --------------------------------------------------------------------------
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutLog = Join-Path $LogDirectory "server-$Stamp.out.log"
$ErrLog = Join-Path $LogDirectory "server-$Stamp.err.log"
Write-Host "Logs               : $LogDirectory"

# Keep the log folder from growing without bound.
Get-ChildItem -LiteralPath $LogDirectory -Filter 'server-*.log' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $LogFilesToKeep |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

$NodeExecutable = Resolve-NodeExecutable

# The standalone server reads PORT/HOSTNAME from the environment. HOSTNAME is
# pinned to the loopback address: the app must not be reachable from the LAN.
$env:PORT = "$Port"
$env:HOSTNAME = $BindAddress
$env:NODE_ENV = 'production'
$env:RISEN_DB_PATH = $DatabasePath

Write-Host "Starting server on $BaseUrl ..."

$ServerProcess = Start-Process -FilePath $NodeExecutable `
  -ArgumentList @('server.js') `
  -WorkingDirectory $ServerDirectory `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog

# --------------------------------------------------------------------------
# Wait for a real health response before opening anything.
# --------------------------------------------------------------------------
$Ready = $false
$Deadline = (Get-Date).AddSeconds($TimeoutSeconds)

while ((Get-Date) -lt $Deadline) {
  if ($ServerProcess.HasExited) { break }

  $Attempt = Get-HealthStatus
  if ($Attempt.Reachable -and $Attempt.Identity -eq $AppIdentity) {
    if ($Attempt.StatusCode -eq 200) { $Ready = $true; break }
    Write-Host "Health responded $($Attempt.StatusCode) - waiting for the database to open ..." -ForegroundColor Yellow
  }
  Start-Sleep -Milliseconds 400
}

if (-not $Ready) {
  Write-Error @"
The server did not become healthy on $BaseUrl within $TimeoutSeconds seconds.

Nothing was opened in the browser. Recent output:
  $OutLog
  $ErrLog
"@
  if (Test-Path -LiteralPath $ErrLog) {
    Write-Host "--- last lines of server error log ---"
    Get-Content -LiteralPath $ErrLog -Tail 20
  }
  if (-not $ServerProcess.HasExited) {
    Write-Host "The server process (PID $($ServerProcess.Id)) is still running; stop it before retrying."
  }
  exit 5
}

Write-Host "Healthy. Risen Team Schedule Builder is running on $BaseUrl" -ForegroundColor Green
Write-Host "Server process PID : $($ServerProcess.Id)"

if (-not $NoBrowser) {
  # Only now: the tab is opened against an application that has already
  # confirmed it can serve requests.
  Start-Process $BaseUrl
}

exit 0
