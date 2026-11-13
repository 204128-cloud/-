$ErrorActionPreference = 'Stop'
[string[]]$repoPilotArgs = if ($args.Count -eq 0) { @('smoke') } else { @($args) }
$previousApiKey = $env:DASHSCOPE_API_KEY
$previousOffline = $env:PI_OFFLINE
$repoPilotExitCode = 0
try {
    $env:PI_OFFLINE = '1'
    $needsKey = $repoPilotArgs[0] -eq 'auth-check' -or
        ($repoPilotArgs[0] -in @('smoke', 'propose', 'repair', 'bench', 'bench-equal', 'chat', 'tui') -and [string]::IsNullOrWhiteSpace($env:DASHSCOPE_API_KEY))
    if ($needsKey) {
        $confirmation = Read-Host '请复制完整百炼北京按量 API Key，然后只按回车确认（无需粘贴，不显示、不保存）' -AsSecureString
        $confirmation.Dispose()
        $env:DASHSCOPE_API_KEY = Get-Clipboard -Raw
    }
    & node (Join-Path $PSScriptRoot 'src\cli.ts') @repoPilotArgs
    $repoPilotExitCode = $LASTEXITCODE
}
finally {
    $env:DASHSCOPE_API_KEY = $previousApiKey
    $env:PI_OFFLINE = $previousOffline
}
exit $repoPilotExitCode



