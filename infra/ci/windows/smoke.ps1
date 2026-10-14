$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine')

$source = @'
#include <windows.h>
#include <stdio.h>
int main(void) { puts("native-windows-ready"); return GetCurrentProcessId() ? 0 : 1; }
'@
Set-Content -Encoding Ascii C:\ci-bootstrap\compiler-smoke.c $source
& cmd.exe /d /s /c 'call C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat >nul && cl.exe /nologo /WX /FoC:\ci-bootstrap\compiler-smoke.obj /FeC:\ci-bootstrap\compiler-smoke.exe C:\ci-bootstrap\compiler-smoke.c && C:\ci-bootstrap\compiler-smoke.exe'
if ($LASTEXITCODE -ne 0) { throw 'Windows SDK/MSVC compilation failed' }

function Tcp($address,$port) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync($address,$port)
        if (!$task.Wait(1500)) { return $false }
        return $client.Connected
    } catch { return $false } finally { $client.Dispose() }
}
if (!(Tcp 'github.com' 443)) { throw 'Public GitHub HTTPS is unreachable' }
$gateway = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4 | Select-Object -First 1).NextHop
foreach ($target in @('67.222.144.10',$gateway,'192.168.122.28','169.254.169.254')) {
    foreach ($port in @(22,80,443,2375)) {
        if (Tcp $target $port) { throw 'Host/private/metadata boundary failed' }
    }
}
if ((Get-Content C:\ci-bootstrap\status.txt) -ne 'ready-for-validation') { throw 'Bootstrap incomplete' }
if ((Test-Path C:\actions-runner\.runner) -or (Test-Path C:\actions-runner\.credentials)) { throw 'Image contains runner registration' }
if (@(Get-Service | Where-Object Name -like 'actions.runner.*').Count) { throw 'Image contains runner service' }
if ((Get-CimInstance Win32_ComputerSystem).PartOfDomain) { throw 'Image joined to external domain' }

$result = [ordered]@{
    verified_at = [DateTime]::UtcNow.ToString('o')
    platform = [string](& node.exe -p "process.platform + '-' + process.arch")
    node_version = [string](& node.exe --version)
    git_version = [string](& git.exe --version)
    python_version = [string](& python.exe --version)
    powershell_version = [string](& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')
    runner_version = [string](& C:\actions-runner\bin\Runner.Listener.exe --version)
    github_cli = [string]((& gh.exe --version | Select-Object -First 1))
    bash = [string](& 'C:\Program Files\Git\bin\bash.exe' --noprofile --norc -c 'printf bash-ready')
    native_compile = $true
    public_https = $true
    host_private_metadata_blocked = $true
    registration_absent = $true
    windows_license = @(Get-CimInstance SoftwareLicensingProduct | Where-Object { $_.Name -like 'Windows*' -and $_.PartialProductKey } | Select-Object Name,LicenseStatus,GracePeriodRemaining)
}
$result | ConvertTo-Json -Depth 4
