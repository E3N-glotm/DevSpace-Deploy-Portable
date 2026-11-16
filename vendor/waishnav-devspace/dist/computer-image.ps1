param([string]$InputImage,[string]$OutputImage,[int]$MaxBytes,[int]$X,[int]$Y,[int]$Width,[int]$Height,[switch]$TryPng)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Bitmap]::new($InputImage)
$bitmap = $null
try {
    $rect = [System.Drawing.Rectangle]::new($X,$Y,$Width,$Height)
    $bitmap = $source.Clone($rect,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $source.Dispose()
    $source = $null
    # Lossless first for a requested region; preserve fine text when possible.
    if ($TryPng) {
        $bitmap.Save($OutputImage,[System.Drawing.Imaging.ImageFormat]::Png)
        if ((Get-Item -LiteralPath $OutputImage).Length -le $MaxBytes) {
            @{mimeType='image/png';width=$bitmap.Width;height=$bitmap.Height} | ConvertTo-Json -Compress
            exit 0
        }
    }
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'} | Select-Object -First 1
    for ($attempt=0; $attempt -lt 8; $attempt++) {
        foreach ($quality in @(95,85,72,58)) {
            $parameters = [System.Drawing.Imaging.EncoderParameters]::new(1)
            try {
                $parameters.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality,[long]$quality)
                $bitmap.Save($OutputImage,$codec,$parameters)
            } finally { $parameters.Dispose() }
            if ((Get-Item -LiteralPath $OutputImage).Length -le $MaxBytes) {
                @{mimeType='image/jpeg';width=$bitmap.Width;height=$bitmap.Height;quality=$quality} | ConvertTo-Json -Compress
                exit 0
            }
        }
        $next = [System.Drawing.Bitmap]::new([Math]::Max(1,[int]($bitmap.Width*0.75)),[Math]::Max(1,[int]($bitmap.Height*0.75)))
        $graphics = [System.Drawing.Graphics]::FromImage($next)
        try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($bitmap,0,0,$next.Width,$next.Height)
        } finally { $graphics.Dispose() }
        $bitmap.Dispose()
        $bitmap = $next
    }
    throw 'Unable to encode screenshot within the transport budget; request a smaller region.'
} finally {
    if ($source) { $source.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
}
