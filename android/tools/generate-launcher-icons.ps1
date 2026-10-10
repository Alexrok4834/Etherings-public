param(
    [string]$Source = (Join-Path $PSScriptRoot '..\..\..\logo_gold.png'),
    [string]$Resources = (Join-Path $PSScriptRoot '..\app\src\main\res')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$sourceBitmap = [System.Drawing.Bitmap]::new($sourcePath)

try {
    $minX = $sourceBitmap.Width
    $minY = $sourceBitmap.Height
    $maxX = -1
    $maxY = -1
    for ($y = 0; $y -lt $sourceBitmap.Height; $y++) {
        for ($x = 0; $x -lt $sourceBitmap.Width; $x++) {
            if ($sourceBitmap.GetPixel($x, $y).A -le 1) {
                continue
            }
            $minX = [Math]::Min($minX, $x)
            $minY = [Math]::Min($minY, $y)
            $maxX = [Math]::Max($maxX, $x)
            $maxY = [Math]::Max($maxY, $y)
        }
    }
    if ($maxX -lt $minX -or $maxY -lt $minY) {
        throw 'Launcher source has no visible pixels.'
    }

    $sourceBounds = [System.Drawing.Rectangle]::new(
        $minX,
        $minY,
        $maxX - $minX + 1,
        $maxY - $minY + 1
    )

    function Write-Icon {
        param(
            [string]$Path,
            [int]$CanvasSize,
            [double]$MaximumWidth,
            [double]$MaximumHeight
        )

        $scale = [Math]::Min(
            $MaximumWidth / $sourceBounds.Width,
            $MaximumHeight / $sourceBounds.Height
        )
        $targetWidth = [Math]::Max(1, [Math]::Round($sourceBounds.Width * $scale))
        $targetHeight = [Math]::Max(1, [Math]::Round($sourceBounds.Height * $scale))
        $targetX = [Math]::Round(($CanvasSize - $targetWidth) / 2)
        $targetY = [Math]::Round(($CanvasSize - $targetHeight) / 2)
        $targetBounds = [System.Drawing.Rectangle]::new(
            $targetX,
            $targetY,
            $targetWidth,
            $targetHeight
        )

        $output = [System.Drawing.Bitmap]::new(
            $CanvasSize,
            $CanvasSize,
            [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
        )
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($output)
            try {
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
                $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                $graphics.DrawImage(
                    $sourceBitmap,
                    $targetBounds,
                    $sourceBounds,
                    [System.Drawing.GraphicsUnit]::Pixel
                )
            }
            finally {
                $graphics.Dispose()
            }

            $directory = Split-Path -Parent $Path
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
            $output.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $output.Dispose()
        }
    }

    $densities = @{
        'mdpi' = 1.0
        'hdpi' = 1.5
        'xhdpi' = 2.0
        'xxhdpi' = 3.0
        'xxxhdpi' = 4.0
    }

    foreach ($density in $densities.GetEnumerator()) {
        $legacySize = [Math]::Round(48 * $density.Value)
        $legacyDirectory = Join-Path $Resources "mipmap-$($density.Key)"
        $legacyWidth = [Math]::Round($legacySize * 0.88)
        $legacyHeight = [Math]::Round($legacySize * 0.88)
        Write-Icon (Join-Path $legacyDirectory 'ic_launcher.png') `
            $legacySize $legacyWidth $legacyHeight
        Copy-Item -LiteralPath (Join-Path $legacyDirectory 'ic_launcher.png') `
            -Destination (Join-Path $legacyDirectory 'ic_launcher_round.png') -Force

        $adaptiveSize = [Math]::Round(108 * $density.Value)
        $adaptiveSafeDiameter = [Math]::Round(64 * $density.Value)
        $sourceDiagonal = [Math]::Sqrt(($sourceBounds.Width * $sourceBounds.Width) `
                + ($sourceBounds.Height * $sourceBounds.Height))
        $safeScale = $adaptiveSafeDiameter / $sourceDiagonal
        Write-Icon (Join-Path $legacyDirectory 'ic_launcher_foreground.png') `
            $adaptiveSize `
            ([Math]::Round($sourceBounds.Width * $safeScale)) `
            ([Math]::Round($sourceBounds.Height * $safeScale))
    }
}
finally {
    $sourceBitmap.Dispose()
}
