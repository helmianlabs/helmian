@{
    RootModule        = 'Helmion.Voice.psm1'
    ModuleVersion     = '1.0.0'
    GUID              = 'd9a4f6b2-3c71-4e58-9f0a-6b2d5e8c1a47'
    Author            = 'DairyForge LLC'
    CompanyName       = 'DairyForge LLC'
    Copyright         = '(c) DairyForge LLC. BUSL-1.1.'
    Description       = 'Helmion''s local voice stack from PowerShell: Whisper for speech to text, Kokoro for text to speech, both offline. No edge-tts, no SAPI, no network.'

    PowerShellVersion = '5.1'

    FunctionsToExport = @(
        'Invoke-HelmionSpeak'
        'Start-HelmionDictation'
        'Stop-HelmionDictation'
        'Test-HelmionDictationRunning'
        'Get-HelmionDictationProcess'
        'Register-HelmionVoiceHotkey'
        'Unregister-HelmionVoiceHotkey'
        'Start-HelmionConversation'
        'Stop-HelmionConversation'
        'Get-HelmionVoiceStatus'
        'Get-HelmionVoiceHostPath'
        'Get-HelmionVoiceLogPath'
        'Test-HelmionVoice'
    )
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()

    PrivateData       = @{
        PSData = @{
            Tags       = @('voice', 'speech', 'whisper', 'kokoro', 'dictation', 'offline')
            LicenseUri = 'https://spdx.org/licenses/BUSL-1.1.html'
        }
    }
}
