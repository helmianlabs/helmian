[CmdletBinding()]
param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\Helmion.Desktop\Assets\Helmion.ico'),
  [string]$SourceImage = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($SourceImage)) {
  $SourceImage = Join-Path $PSScriptRoot '..\Helmion.Desktop\Assets\Helmian-logo.png'
}
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HelmionIconNative {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr handle);
}
'@

$target = [System.IO.Path]::GetFullPath($OutputPath)
$sourcePath = [System.IO.Path]::GetFullPath($SourceImage)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Helmian logo source was not found: $sourcePath"
}
[System.IO.Directory]::CreateDirectory(
  [System.IO.Path]::GetDirectoryName($target)
) | Out-Null

$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$source = [System.Drawing.Image]::FromFile($sourcePath)
$icon = $null
$handle = [IntPtr]::Zero
try {
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $crop = [System.Drawing.Rectangle]::new(145, 70, 1120, 1120)
  $destination = [System.Drawing.Rectangle]::new(0, 0, 256, 256)
  $graphics.DrawImage($source, $destination, $crop, [System.Drawing.GraphicsUnit]::Pixel)

  $handle = $bitmap.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($handle)
  $stream = [System.IO.FileStream]::new(
    $target,
    [System.IO.FileMode]::Create,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try { $icon.Save($stream) } finally { $stream.Dispose() }
} finally {
  if ($icon) { $icon.Dispose() }
  if ($handle -ne [IntPtr]::Zero) {
    [void][HelmionIconNative]::DestroyIcon($handle)
  }
  $graphics.Dispose()
  $source.Dispose()
  $bitmap.Dispose()
}

Get-Item -LiteralPath $target |
  Select-Object FullName, Length
