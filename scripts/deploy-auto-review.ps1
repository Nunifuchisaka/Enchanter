# PRの自動レビュー＋自動マージを、自分の全リポジトリに展開するスクリプト(Windows PowerShell)
#
# やること(リポジトリごと):
#   1. シークレット CLAUDE_CODE_OAUTH_TOKEN を登録(上書き)
#   2. .github/workflows/auto-review-merge.yml(Enchanterと同じ呼び出しファイル)を既定ブランチに追加/更新
# 対象外: フォーク、アーカイブ済み、空のリポジトリ
#
# 前提: GitHub CLI (gh) にログイン済み。トークンは `claude setup-token` で取得したもの。
# 使い方: PowerShellで  powershell -ExecutionPolicy Bypass -File .\scripts\deploy-auto-review.ps1
#         一部だけにしたい場合は  -Repos Enchanter,Nightsoul  のように指定

param(
  [string]$Owner = 'Nunifuchisaka',
  [string[]]$Repos,
  [switch]$Force   # 同名の別内容ファイルがあっても上書きする
)

$path = '.github/workflows/auto-review-merge.yml'

# ワークフローファイルの書き込みには workflow 権限が必要
gh auth refresh -h github.com -s workflow
if ($LASTEXITCODE -ne 0) { Write-Error 'gh の権限更新に失敗しました'; exit 1 }

$secure = Read-Host 'CLAUDE_CODE_OAUTH_TOKEN を貼り付けてEnter' -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $token) { Write-Error 'トークンが空です'; exit 1 }

# 配る中身は Enchanter の main にある呼び出しファイル
$content = (gh api "repos/$Owner/Enchanter/contents/$path" -q .content) -join '' -replace '\s', ''
if (-not $content) { Write-Error "Enchanter の $path を取得できませんでした"; exit 1 }

if ($Repos) {
  $targets = $Repos | ForEach-Object { if ($_ -like '*/*') { $_ } else { "$Owner/$_" } }
} else {
  $targets = gh repo list $Owner --limit 500 --source --no-archived --json nameWithOwner -q '.[].nameWithOwner'
}

$ok = @(); $ng = @()
foreach ($r in $targets) {
  Write-Host "== $r"
  $token | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo $r
  if ($LASTEXITCODE -ne 0) { $ng += "$r (シークレット登録失敗)"; continue }

  $sha = gh api "repos/$r/contents/$path" -q .sha 2>$null
  $hasFile = ($LASTEXITCODE -eq 0 -and $sha)
  if ($hasFile) {
    $current = (gh api "repos/$r/contents/$path" -q .content) -join '' -replace '\s', ''
    if ($current -eq $content) { Write-Host '  ワークフローは最新'; $ok += $r; continue }
    if (-not $Force) { $ng += "$r (別内容の $path があるためスキップ。上書きするなら -Force)"; continue }
  }
  $ghArgs = @('api', '-X', 'PUT', "repos/$r/contents/$path",
            '-f', 'message=PRの自動レビュー(Claude)と自動マージのワークフローを追加',
            '-f', "content=$content", '--silent')
  if ($hasFile) { $ghArgs += @('-f', "sha=$sha") }
  gh @ghArgs
  if ($LASTEXITCODE -ne 0) { $ng += "$r (ワークフロー追加失敗。空のリポジトリやブランチ保護の可能性)"; continue }
  $ok += $r
}

Write-Host ''
Write-Host "完了: $($ok.Count) 件"
if ($ng.Count) { Write-Host "失敗: $($ng.Count) 件"; $ng | ForEach-Object { Write-Host "  $_" } }
