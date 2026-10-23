$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force C:\ci-bootstrap,C:\actions-runner,C:\hostedtoolcache | Out-Null
Remove-Item C:\ci-bootstrap\failure.txt -Force -ErrorAction SilentlyContinue

function Download-Verified($Url, $Path, $Sha256) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
    if ((Get-FileHash -Algorithm SHA256 $Path).Hash.ToLowerInvariant() -ne $Sha256) {
        throw "Download checksum mismatch: $Path"
    }
}

function Install-Msi($Path) {
    $process = Start-Process msiexec.exe -ArgumentList @('/i', $Path, '/qn', '/norestart') -PassThru -Wait
    if ($process.ExitCode -notin @(0,3010)) { throw "MSI failed: $Path ($($process.ExitCode))" }
}

try {
    Set-Content C:\ci-bootstrap\status.txt 'installing-qemu-agent'
    $agent = Get-PSDrive -PSProvider FileSystem | ForEach-Object {
        Join-Path $_.Root 'guest-agent\qemu-ga-x86_64.msi'
    } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (!$agent) { throw 'QEMU guest agent installer is missing' }
    $virtioRoot = Split-Path (Split-Path $agent)
    $serialDriver = Join-Path $virtioRoot 'vioserial\2k22\amd64\vioser.inf'
    if (!(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like '*VEN_1AF4&DEV_1043*' -and $_.Status -eq 'OK' })) {
        & pnputil.exe /add-driver $serialDriver /install | Out-Null
        if ($LASTEXITCODE -notin @(0,3010)) { throw 'VirtIO serial driver installation failed' }
    }
    if (!(Get-Service QEMU-GA -ErrorAction SilentlyContinue)) { Install-Msi $agent }
    $adapter = Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -First 1
    $index = $adapter.InterfaceIndex
    Set-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4 -Dhcp Disabled
    Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
    Get-NetRoute -InterfaceIndex $index -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object DestinationPrefix -eq '0.0.0.0/0' | Remove-NetRoute -Confirm:$false
    New-NetIPAddress -InterfaceIndex $index -IPAddress '192.168.230.2' -PrefixLength 24 -DefaultGateway '192.168.230.1' | Out-Null
    Set-DnsClientServerAddress -InterfaceIndex $index -ServerAddresses '192.168.230.1'

    Set-Content C:\ci-bootstrap\status.txt 'installing-powershell-git-node'
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        Clear-DnsClientCache
        try { if (Resolve-DnsName github.com -Type A -DnsOnly -QuickTimeout -ErrorAction Stop) { break } } catch { }
        Start-Sleep -Seconds 2
    }
    if ($attempt -eq 20) { throw 'Dedicated network DNS did not become ready' }
    Download-Verified 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.7/PowerShell-7.6.7-win-x64.msi' C:\ci-bootstrap\powershell.msi 'ec575cef9ec56fcd905de0d5eeac9cb7f81a0a65abb87bb5cd0e87fdfe2b8cc0'
    Install-Msi C:\ci-bootstrap\powershell.msi
    Download-Verified 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/Git-2.56.0.2-64-bit.exe' C:\ci-bootstrap\git.exe '52188f917b378f00c70ec136bcf090005f30d44fbc4eba0bce759cc6592d60f6'
    $git = Start-Process C:\ci-bootstrap\git.exe -ArgumentList '/VERYSILENT /NORESTART /SP- /SUPPRESSMSGBOXES' -PassThru -Wait
    if ($git.ExitCode -ne 0) { throw 'Git installation failed' }
    $nodeVersion = '24.22.1'
    $nodeChecksums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt").Content
    $nodeHash = (($nodeChecksums -split "`n" | Where-Object { $_ -match "node-v$nodeVersion-x64.msi$" }) -split '\s+')[0]
    if ($nodeHash -notmatch '^[a-f0-9]{64}$') { throw 'Node checksum is missing' }
    Download-Verified "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-x64.msi" C:\ci-bootstrap\node.msi $nodeHash
    Install-Msi C:\ci-bootstrap\node.msi
    Download-Verified 'https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_windows_amd64.msi' C:\ci-bootstrap\gh.msi '7944b579d76359e5b859a263bf63583e271ae3fbd427ae46e133c1f348b46371'
    Install-Msi C:\ci-bootstrap\gh.msi
    Invoke-WebRequest -UseBasicParsing 'https://www.python.org/ftp/python/3.14.5/python-3.14.5-amd64.exe' -OutFile C:\ci-bootstrap\python.exe
    $pythonSignature = Get-AuthenticodeSignature C:\ci-bootstrap\python.exe
    if ($pythonSignature.Status -ne 'Valid' -or $pythonSignature.SignerCertificate.Subject -notmatch 'Python Software Foundation') { throw 'Python installer signature is invalid' }
    $python = Start-Process C:\ci-bootstrap\python.exe -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0' -PassThru -Wait
    if ($python.ExitCode -notin @(0,3010)) { throw 'Python installation failed' }

    Set-Content C:\ci-bootstrap\status.txt 'installing-msvc'
    Invoke-WebRequest -UseBasicParsing 'https://aka.ms/vs/17/release/vs_buildtools.exe' -OutFile C:\ci-bootstrap\vs-buildtools.exe
    $signature = Get-AuthenticodeSignature C:\ci-bootstrap\vs-buildtools.exe
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
        throw 'Visual Studio installer signature is invalid'
    }
    $vs = Start-Process C:\ci-bootstrap\vs-buildtools.exe -ArgumentList '--quiet --wait --norestart --nocache --installPath C:\BuildTools --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended' -PassThru -Wait
    if ($vs.ExitCode -notin @(0,3010)) { throw "MSVC installation failed ($($vs.ExitCode))" }

    Set-Content C:\ci-bootstrap\status.txt 'installing-actions-runner'
    Download-Verified 'https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-win-x64-2.338.0.zip' C:\ci-bootstrap\runner.zip 'f48e0750a21812bca5f82de5f7f5aeae71abee647fab5a582f1742d07eba455f'
    Expand-Archive C:\ci-bootstrap\runner.zip C:\actions-runner -Force
    $machinePath = [Environment]::GetEnvironmentVariable('Path','Machine')
    [Environment]::SetEnvironmentVariable('Path', "$machinePath;C:\Program Files\Git\bin;C:\Program Files\PowerShell\7", 'Machine')
    [Environment]::SetEnvironmentVariable('RUNNER_TOOL_CACHE','C:\hostedtoolcache','Machine')
    [Environment]::SetEnvironmentVariable('AGENT_TOOLSDIRECTORY','C:\hostedtoolcache','Machine')
    # This bootstrap's process-scoped Bypass can report an override even
    # after the machine setting is written successfully.
    Set-ExecutionPolicy RemoteSigned -Scope LocalMachine -Force -ErrorAction SilentlyContinue
    if ((Get-ExecutionPolicy -Scope LocalMachine) -ne 'RemoteSigned') { throw 'Machine execution policy was not configured' }
    Set-Service sshd -StartupType Disabled -ErrorAction SilentlyContinue
    Stop-Service WinRM -ErrorAction SilentlyContinue
    Set-Service WinRM -StartupType Disabled
    Remove-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name DefaultPassword,AutoLogonCount -ErrorAction SilentlyContinue
    Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name AutoAdminLogon -Value '0'
    Remove-Item C:\Windows\Panther\Unattend.xml,C:\Windows\Panther\Unattend\Unattend.xml -Force -ErrorAction SilentlyContinue
    Remove-Item C:\ci-bootstrap\*.msi,C:\ci-bootstrap\*.exe,C:\ci-bootstrap\*.zip -Force
    Set-Content C:\ci-bootstrap\status.txt 'ready-for-validation'
} catch {
    Set-Content C:\ci-bootstrap\status.txt 'failed'
    Set-Content C:\ci-bootstrap\failure.txt $_.Exception.Message
    throw
}
