[CmdletBinding()]
param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\Helmion.Desktop\Assets\Helmion.ico')
)

$ErrorActionPreference = 'Stop'
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
[System.IO.Directory]::CreateDirectory(
  [System.IO.Path]::GetDirectoryName($target)
) | Out-Null

$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$icon = $null
$handle = [IntPtr]::Zero
try {
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $shape.AddArc(16, 16, 72, 72, 180, 90)
    $shape.AddArc(168, 16, 72, 72, 270, 90)
    $shape.AddArc(168, 168, 72, 72, 0, 90)
    $shape.AddArc(16, 168, 72, 72, 90, 90)
    $shape.CloseFigure()
    $background = [System.Drawing.SolidBrush]::new(
      [System.Drawing.Color]::FromArgb(255, 115, 230, 177)
    )
    try { $graphics.FillPath($background, $shape) } finally { $background.Dispose() }
  } finally {
    $shape.Dispose()
  }

  $pen = [System.Drawing.Pen]::new(
    [System.Drawing.Color]::FromArgb(255, 9, 32, 25),
    22
  )
  try {
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLine($pen, 72, 58, 72, 198)
    $graphics.DrawLine($pen, 72, 128, 186, 57)
    $graphics.DrawLine($pen, 72, 128, 186, 199)
  } finally {
    $pen.Dispose()
  }

  $dot = [System.Drawing.SolidBrush]::new(
    [System.Drawing.Color]::FromArgb(255, 9, 32, 25)
  )
  try { $graphics.FillEllipse($dot, 176, 43, 35, 35) } finally { $dot.Dispose() }

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
  $bitmap.Dispose()
}

Get-Item -LiteralPath $target |
  Select-Object FullName, Length
