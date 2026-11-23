# ---------- Couchwave installer for Windows ----------
# In PowerShell:  irm https://raw.githubusercontent.com/Hoyle95/couchwave/main/install.ps1 | iex
# Installs Node.js, yt-dlp and ffmpeg if they're missing (with winget), downloads the newest Couchwave release
# into your Couchwave folder, starts it with the PC, lets friends on your home network in, and starts it.
# Run it again to update: config.json and data\ are kept. Optional: $env:COUCHWAVE_DIR (where to install),
# $env:COUCHWAVE_PORT (the port for a new install; otherwise the first free one from 3000), $env:COUCHWAVE_NO_BROWSER (don't open a browser at the end).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Url = 'https://raw.githubusercontent.com/Hoyle95/couchwave/main/install.ps1'
$Dir = if ($env:COUCHWAVE_DIR) { $env:COUCHWAVE_DIR } else { Join-Path $HOME 'Couchwave' }
$Task = if ($env:COUCHWAVE_TASK) { $env:COUCHWAVE_TASK } else { 'Couchwave' }
$User = if ($env:COUCHWAVE_FOR) { $env:COUCHWAVE_FOR } else { $env:USERNAME }

function Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Has($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $all = @($env:Path -split ';') + ([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') + ([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')
  $env:Path = ($all | Where-Object { $_ } | Select-Object -Unique) -join ';'
}
function Port {
  try { $p = (Get-Content (Join-Path $Dir 'config.json') -Raw | ConvertFrom-Json).port; if ($p) { return [int]$p } } catch {}
  if ($env:COUCHWAVE_PORT) { return [int]$env:COUCHWAVE_PORT }
  return 3000
}
function Free($port) {
  node -e "const s = require('net').createServer(); s.once('error', () => process.exit(1)); s.listen($port, () => s.close(() => process.exit(0)))" 2>$null
  return $LASTEXITCODE -eq 0
}
function IsCouchwave($port) {
  try {
    $body = (Invoke-WebRequest "http://localhost:$port/manifest.json" -UseBasicParsing -TimeoutSec 2).Content
    if ($body -is [byte[]]) { $body = [Text.Encoding]::UTF8.GetString($body) }
    return ($body | ConvertFrom-Json).name -eq 'Couchwave'
  } catch { return $false }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Couchwave needs administrator rights once, to start with the PC and let friends on your network in.'
  Write-Host 'Windows will ask; the install carries on in a new window.'
  $again = "`$env:COUCHWAVE_DIR='$Dir'; `$env:COUCHWAVE_FOR='$User'; `$env:COUCHWAVE_PORT='$env:COUCHWAVE_PORT'; irm $Url | iex"
  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', $again
  return
}

Step 'Checking for Node.js, yt-dlp and ffmpeg'
Refresh-Path
$nodeOk = $false
if (Has node) {
  $v = ((node --version) -replace '^v', '').Split('.')
  $nodeOk = ([int]$v[0] -gt 18) -or ([int]$v[0] -eq 18 -and [int]$v[1] -ge 11)
}
$needed = @()
if (-not $nodeOk) { $needed += 'OpenJS.NodeJS.LTS' }
if (-not (Has yt-dlp)) { $needed += 'yt-dlp.yt-dlp' }
elseif (-not (Has ffmpeg)) { $needed += 'Gyan.FFmpeg' }
if ($needed.Count) {
  if (-not (Has winget)) { throw "winget isn't on this PC. Install 'App Installer' from the Microsoft Store, then run this again." }
  foreach ($id in $needed) {
    Write-Host "  installing $id"
    winget install --exact --id $id --silent --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Null
  }
  Refresh-Path
}
foreach ($tool in 'node', 'yt-dlp', 'ffmpeg') {
  if (-not (Has $tool)) { throw "$tool still can't be found after installing it. Restart the PC, then run this again." }
}
Write-Host "  Node.js $(node --version), yt-dlp $(yt-dlp --version)"

Step 'Downloading the newest Couchwave'
$headers = @{ 'User-Agent' = 'Couchwave installer' }
if ($env:GITHUB_TOKEN) { $headers.Authorization = "Bearer $env:GITHUB_TOKEN" }
$releases = Invoke-RestMethod 'https://api.github.com/repos/Hoyle95/couchwave/releases?per_page=10' -Headers $headers
$release = $releases | Where-Object { -not $_.draft } | Select-Object -First 1
$asset = $release.assets | Where-Object { $_.name -like 'couchwave-*.zip' } | Select-Object -First 1
if (-not $asset) { throw "Couldn't find the Couchwave download on GitHub. Try again in a few minutes." }
if ("$($asset.digest)" -notmatch '^sha256:([0-9a-f]{64})$') { throw "GitHub gave no checksum to check the Couchwave download against, so it wasn't installed. Try again in a few minutes." }
$sum = $Matches[1].ToLower()
$zip = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $sum) {
  Remove-Item $zip -Force
  throw "The Couchwave download doesn't match its checksum, so it wasn't installed. Try again in a few minutes."
}
Write-Host "  $($release.tag_name)"

if (Test-Path (Join-Path $Dir 'server.js')) {
  Step "Stopping the Couchwave in $Dir, to update it"
  if (Select-String -Path (Join-Path $Dir 'server.js') -Pattern "'--stop'" -SimpleMatch -Quiet) {
    Push-Location $Dir
    try { node server.js --stop | Out-Null } catch {}
    Pop-Location
  }
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  if (IsCouchwave (Port)) {
    Get-CimInstance Win32_Process -Filter "name='cmd.exe'" | Where-Object { $_.CommandLine -match 'start\.cmd' } |
      ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }
    Start-Sleep -Seconds 2
  }
}

Step "Installing it in $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Expand-Archive -Path $zip -DestinationPath $Dir -Force
Remove-Item $zip -Force
$config = Join-Path $Dir 'config.json'
if (-not (Test-Path $config)) {
  $port = Port
  if (-not $env:COUCHWAVE_PORT) {
    while (-not (Free $port) -and $port -lt 3100) { $port++ }
    if ($port -ne 3000) { Write-Host "  port 3000 is already used by something else, so Couchwave gets port $port" }
  }
  $password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 12 | ForEach-Object { [char]$_ })
  @{ password = $password; port = $port } | ConvertTo-Json | Set-Content $config -Encoding ascii
}

Step 'Letting friends on your home network in'
$port = Port
Get-NetFirewallRule -DisplayName $Task -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $Task -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private | Out-Null
Write-Host "  port $port, on networks Windows calls private"

Step 'Starting Couchwave, and with the PC from now on'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c start.cmd' -WorkingDirectory $Dir
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U
Register-ScheduledTask -TaskName $Task -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $Task
$port = Port
$up = $false
for ($i = 0; $i -lt 60 -and -not $up; $i++) { if (IsCouchwave $port) { $up = $true } else { Start-Sleep -Seconds 1 } }
$password = try { (Get-Content $config -Raw | ConvertFrom-Json).password } catch { '' }
$ips = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
  Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
  ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -and $_ -notlike '169.254.*' } | Select-Object -Unique

Write-Host ''
if ($up) { Write-Host 'Couchwave is running!' -ForegroundColor Green }
elseif (-not (Free $port)) {
  Write-Host "Couchwave is installed, but port $port is used by another program, so it can't start." -ForegroundColor Yellow
  Write-Host "  Pick another port: change ""port"" in $config, then run this line again."
}
else { Write-Host "Couchwave is installed, but it hasn't started yet. If it doesn't, the reason is in $Dir\data\server.log" -ForegroundColor Yellow }
Write-Host "  Open it:          http://localhost:$port"
foreach ($ip in $ips) { Write-Host "  Friends at home:  http://${ip}:$port" }
if ($password) { Write-Host "  Room password:    $password   (in $config)" }
Write-Host "  It starts with the PC. To stop it, double-click stop.cmd in $Dir."
if (Test-Path (Join-Path $Dir 'update.cmd')) { Write-Host "  To update later, double-click update.cmd in $Dir (or run this line again)." }
else { Write-Host '  Run the same line again any time to update.' }
Write-Host '  To let friends in from the internet, see'
Write-Host '  https://github.com/Hoyle95/couchwave/blob/main/docs/INSTALL.md#letting-friends-in'
if ($up -and -not $env:COUCHWAVE_NO_BROWSER) { try { Start-Process "http://localhost:$port" } catch {} }
