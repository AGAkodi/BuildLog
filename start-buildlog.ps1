$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:APP_URL = 'https://squatting-gumming-private.ngrok-free.dev'
$env:GITHUB_REDIRECT_URI = "$env:APP_URL/api/auth/github/callback"
$env:BUFFER_REDIRECT_URI = "$env:APP_URL/api/buffer/callback"
$env:CLOUDFLARE_ACCOUNT_ID = '87e417780a5ad16b038f47920cfa5466'
$env:CLOUDFLARE_D1_DATABASE_ID = '99371620-fc03-430e-89c2-6143707cc2de'

function Initialize-BuildLogCredential($variable, $label) {
    $credentialPath = Join-Path $PSScriptRoot ".env.$variable.clixml"
    $current = [Environment]::GetEnvironmentVariable($variable, 'Process')
    if (-not $current) {
        if (Test-Path -LiteralPath $credentialPath) {
            $secureValue = Import-Clixml -LiteralPath $credentialPath
        } else {
            $secureValue = Read-Host "Enter $label" -AsSecureString
            if ($secureValue.Length -eq 0) { throw "$label cannot be empty." }
            $secureValue | Export-Clixml -LiteralPath $credentialPath
        }
        $current = [System.Net.NetworkCredential]::new('', $secureValue).Password
        [Environment]::SetEnvironmentVariable($variable, $current, 'Process')
    } elseif (-not (Test-Path -LiteralPath $credentialPath)) {
        ConvertTo-SecureString -String $current -AsPlainText -Force | Export-Clixml -LiteralPath $credentialPath
    }
    if (-not $current) { throw "$label cannot be empty." }
}

Initialize-BuildLogCredential 'CLOUDFLARE_API_TOKEN' 'Cloudflare D1 API token'
Initialize-BuildLogCredential 'GITHUB_CLIENT_ID' 'GitHub client ID'
Initialize-BuildLogCredential 'GITHUB_CLIENT_SECRET' 'GitHub client secret'
Initialize-BuildLogCredential 'BUFFER_CLIENT_ID' 'Buffer client ID'
Initialize-BuildLogCredential 'BUFFER_CLIENT_SECRET' 'Buffer client secret'
if (-not (Test-Path -LiteralPath '.env.key')) { throw 'The encryption key file .env.key is missing. Restore its backup to avoid losing existing Buffer connections.' }
Write-Host 'Starting BuildLog. Keep this window and ngrok open.'
& node --env-file=.env.key server.js
