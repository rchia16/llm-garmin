$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $projectDirectory "Start Local Workout Builder.cmd"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Local Workout Builder.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $projectDirectory
$shortcut.Description = "Start the local workout builder"
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
$shortcut.Save()

Write-Host "Created: $shortcutPath"
