param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentDirectory = Join-Path $projectDirectory '.venv'
$pythonExecutable = Join-Path $environmentDirectory 'Scripts\python.exe'
$requirements = Join-Path $projectDirectory 'python\requirements.txt'

function Show-PythonInstallGuidance {
    Write-Host 'Garmin integration requires Python 3.12+. Python 3.13 is recommended.'
    Write-Host 'Download: https://www.python.org/downloads/windows/'
    Write-Host 'Install Python, reopen your terminal, and rerun the launcher.'
    Write-Host 'The app can still run without Garmin integration.'
}

function Test-SupportedPython($Executable, $Arguments = @()) {
    try {
        & $Executable @Arguments -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' *> $null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

function Test-BridgeDependencies {
    try {
        & $pythonExecutable -c 'import garminconnect, dotenv' *> $null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

try {
    if (Test-Path -LiteralPath $environmentDirectory) {
        if (-not (Test-Path -LiteralPath $pythonExecutable) -or -not (Test-SupportedPython $pythonExecutable)) {
            Show-PythonInstallGuidance
            throw 'Existing .venv is incompatible or incomplete. It was not overwritten. Follow the README Python setup instructions.'
        }
    } elseif ($CheckOnly) {
        Show-PythonInstallGuidance
        throw 'Optional Garmin Python environment is not set up yet.'
    } else {
        $candidateExecutable = $null
        $candidateArguments = @()
        if (Get-Command py -ErrorAction SilentlyContinue) {
            foreach ($version in @('-3.13', '-3.12', '-3')) {
                if (Test-SupportedPython 'py' @($version)) {
                    $candidateExecutable = 'py'
                    $candidateArguments = @($version)
                    break
                }
            }
        }
        if (-not $candidateExecutable) {
            foreach ($command in @('python', 'python3')) {
                if ((Get-Command $command -ErrorAction SilentlyContinue) -and (Test-SupportedPython $command)) {
                    $candidateExecutable = $command
                    break
                }
            }
        }
        if (-not $candidateExecutable) {
            Show-PythonInstallGuidance
            throw 'No compatible Python installation was found.'
        }
        Write-Host 'Creating the optional Garmin Python environment...'
        & $candidateExecutable @candidateArguments -m venv $environmentDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Could not create .venv. Local workout creation remains available.' }
    }

    if (-not (Test-BridgeDependencies)) {
        if ($CheckOnly) { throw 'Garmin Python dependencies are missing.' }
        Write-Host 'Installing the optional Garmin Python dependencies...'
        & $pythonExecutable -m pip install --disable-pip-version-check -r $requirements
        if ($LASTEXITCODE -ne 0) { throw 'Garmin dependency installation failed. Check internet access and retry setup.' }
        if (-not (Test-BridgeDependencies)) { throw 'Garmin dependencies could not be imported after installation.' }
    }
    Write-Host 'Garmin Python bridge ready. Sign in using Connect Garmin in the app.'
    exit 0
} catch {
    Write-Host "Optional Garmin setup: $($_.Exception.Message)"
    exit 1
}
