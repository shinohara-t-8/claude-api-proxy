<#
.SYNOPSIS
  新しいツール用 Claude API キーを Secret Manager に登録し、プロキシのマップを更新する。

.DESCRIPTION
  1. Secret Manager に claude-api-key-<tool-id> を作成（既存なら新バージョン追加）
  2. Cloud Run 実行 SA に secretAccessor を付与
  3. index.js の DEFAULT_TOOL_SECRET_MAP に tool id を追加
  4. -Push 指定時は commit & push（GitHub Actions でデプロイ）

.EXAMPLE
  .\scripts\add-tool.ps1 -ToolId "auditor" -ApiKey "sk-ant-..."

.EXAMPLE
  .\scripts\add-tool.ps1 -ToolId "auditor" -ApiKey "sk-ant-..." -Push
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,62}$')]
  [string]$ToolId,

  [Parameter(Mandatory = $true)]
  [string]$ApiKey,

  [string]$ProjectId = 't8studio-infra-jp',
  [string]$RuntimeSa = '970630623430-compute@developer.gserviceaccount.com',
  [switch]$Push
)

$ErrorActionPreference = 'Stop'

if ($ApiKey -notmatch '^sk-ant-') {
  throw 'ApiKey は sk-ant- で始まる必要があります（値はログに出しません）'
}

$root = Split-Path -Parent $PSScriptRoot
$indexPath = Join-Path $root 'index.js'
if (-not (Test-Path $indexPath)) {
  throw "index.js が見つかりません: $indexPath"
}

$secretName = "claude-api-key-$ToolId"
$member = "serviceAccount:$RuntimeSa"
$keyFile = Join-Path $env:TEMP ("claude-key-" + [guid]::NewGuid().ToString('N') + '.txt')

Write-Host "==> ToolId     : $ToolId"
Write-Host "==> Secret     : $secretName"
Write-Host "==> Project    : $ProjectId"
Write-Host "==> キー値は表示しません"

try {
  [System.IO.File]::WriteAllText($keyFile, $ApiKey.Trim())

  gcloud secrets describe $secretName --project=$ProjectId 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "==> シークレット作成中..."
    gcloud secrets create $secretName --replication-policy=automatic --project=$ProjectId | Out-Null
  } else {
    Write-Host "==> シークレットは既存。新バージョンを追加します..."
  }

  cmd /c "type `"$keyFile`" | gcloud secrets versions add $secretName --data-file=- --project=$ProjectId" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'secrets versions add に失敗しました' }
  Write-Host "==> シークレット登録完了"

  Write-Host "==> secretAccessor 付与中..."
  gcloud secrets add-iam-policy-binding $secretName `
    --member=$member `
    --role='roles/secretmanager.secretAccessor' `
    --project=$ProjectId `
    --quiet 1>$null
  Write-Host "==> IAM 完了"
}
finally {
  if (Test-Path $keyFile) { Remove-Item $keyFile -Force -ErrorAction SilentlyContinue }
}

# index.js の DEFAULT_TOOL_SECRET_MAP を更新
Write-Host "==> index.js のマップを更新中..."
$js = Get-Content -Raw -Path $indexPath -Encoding UTF8
$mapPattern = '(?s)(const DEFAULT_TOOL_SECRET_MAP = \{)(.*?)(\r?\n\};)'
$m = [regex]::Match($js, $mapPattern)
if (-not $m.Success) {
  throw 'DEFAULT_TOOL_SECRET_MAP が見つかりません'
}

$escapedId = [regex]::Escape($ToolId)
$mapBody = $m.Groups[2].Value
if ($mapBody -match "(?m)^\s*'?$escapedId'?\s*:") {
  Write-Host "==> マップに $ToolId は既にあるためスキップ"
} else {
  $entryKey = if ($ToolId -match '^[a-zA-Z_][a-zA-Z0-9_]*$') { $ToolId } else { "'$ToolId'" }
  $newLine = "  ${entryKey}: '$secretName',"
  $body = $mapBody.TrimEnd("`r", "`n", " ", "`t")
  if ($body -ne '' -and $body -notmatch ',\s*$') {
    $body = $body + ','
  }
  $body = $body + "`r`n" + $newLine
  $updated = $js.Substring(0, $m.Index) + $m.Groups[1].Value + $body + $m.Groups[3].Value + $js.Substring($m.Index + $m.Length)
  [System.IO.File]::WriteAllText($indexPath, $updated)
  Write-Host "==> マップに $ToolId を追加しました"
}

Write-Host ""
Write-Host "呼び出し側の設定例:"
Write-Host "  X-Tool-Id: $ToolId"
Write-Host "  URL: Cloud Run の claude-proxy URL"
Write-Host ""

if ($Push) {
  Push-Location $root
  try {
    git add index.js
    $status = git status --porcelain index.js
    if (-not $status) {
      Write-Host "==> index.js にコミット対象の差分なし（既に登録済みの可能性）"
    } else {
      git commit -m "Register tool '$ToolId' in Claude proxy secret map."
      git push origin HEAD
      Write-Host "==> push 完了。GitHub Actions がデプロイします"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "次のステップ: 差分を確認して push するとデプロイされます"
  Write-Host "  cd `"$root`""
  Write-Host "  git add index.js && git commit -m `"Register tool '$ToolId'`" && git push"
  Write-Host ""
  Write-Host "または再実行: .\scripts\add-tool.ps1 -ToolId $ToolId -ApiKey '...' -Push"
}
