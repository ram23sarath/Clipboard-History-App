Add-Type -AssemblyName System.Drawing

$sourcePath = "D:\Sherry\Projects\Chrome Extension\icons\icon128.png"
$img = [System.Drawing.Image]::FromFile($sourcePath)

$sizes = @(16, 32, 48)

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $size, $size)
    $outputPath = "D:\Sherry\Projects\Chrome Extension\icons\icon$size.png"
    $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Created: $outputPath"
    $g.Dispose()
    $bmp.Dispose()
}

$img.Dispose()
Write-Host "All icons created successfully!"
