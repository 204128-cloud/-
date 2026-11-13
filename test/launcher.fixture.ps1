$global:repoPilotPromptCalls = 0
$global:LASTEXITCODE = 0
$global:repoPilotClipboardCalls = 0
function global:Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    $global:repoPilotPromptCalls++
    $secure = [Security.SecureString]::new()
    $testInput = [string]$env:REPOPILOT_TEST_TYPED_KEY
    foreach ($testCharacter in $testInput.ToCharArray()) { $secure.AppendChar($testCharacter) }
    $secure
}
function global:Get-Clipboard {
    param([switch]$Raw)
    $global:repoPilotClipboardCalls++
    'sk-LOCAL_FAKE_LAUNCHER_TEST'
}
function global:node {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$TestNodeArgs)
    [pscustomobject]@{
        command = $TestNodeArgs[1]
        promptCalls = $global:repoPilotPromptCalls
        clipboardCalls = $global:repoPilotClipboardCalls
        keyLoaded = $env:DASHSCOPE_API_KEY -eq 'sk-LOCAL_FAKE_LAUNCHER_TEST'
        offline = $env:PI_OFFLINE -eq '1'
    }
}
$fixtureOriginalKey = [string]$env:REPOPILOT_TEST_EXISTING_KEY
$env:DASHSCOPE_API_KEY = $fixtureOriginalKey
$env:PI_OFFLINE = 'fixture-before'
$execution = & (Join-Path (Split-Path -Parent $PSScriptRoot) 'Start-RepoPilot.ps1') @args
[pscustomobject]@{
    execution = $execution
    keyRestored = [string]$env:DASHSCOPE_API_KEY -ceq $fixtureOriginalKey
    offlineRestored = $env:PI_OFFLINE -eq 'fixture-before'
} | ConvertTo-Json -Depth 4

