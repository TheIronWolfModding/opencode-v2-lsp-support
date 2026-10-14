function Get-Greeting([string]$Name) {
    return "Hello, $Name!"
}

Write-Output (Get-Greeting -Name "world")
