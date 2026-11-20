param([string]$SourceRoot,[string]$Root,[string]$StagingPath,[switch]$FailAfterVerify)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $SourceRoot 'setup/portable-updater.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
foreach($fn in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
 . ([scriptblock]::Create($fn.Extent.Text))
}
$UpdateRoot=Join-Path $Root '.update-staging'
$CurrentVersion='1.1.41';$LaunchAckPath='';$UiPid=0;$Repository='fixture/repository'
$ProgressFile=Join-Path $Root 'data/state/update-progress.json'
function Write-UpdateLog([string]$Message){}
function Write-UpdateProgress {param($Phase,$Message,$BytesReceived,$BytesTotal,$Transport)}
function Write-UpdateResult($Result){}
function Stop-PortableUiBeforeApply($UiPid){}
function Stop-PortableBeforeApply {}
function Assert-PortableExecutableImagesDrained {}
function Remove-TransientUpdateTask {}
function Invoke-Manager {param($Command,[switch]$IgnoreFailure)}
function Start-Process {param($FilePath,$WorkingDirectory)}
$script:OriginalVerify=(Get-Command Invoke-BlockmapPlanVerification).ScriptBlock
$script:PostVerified=$false
function Invoke-BlockmapPlanVerification {
 param([string]$Stage,[object]$StageInfo,[string]$PayloadRoot,[switch]$Installed)
 & $script:OriginalVerify @PSBoundParameters
 if($Installed){$script:PostVerified=$true;if($FailAfterVerify){throw 'injected post-verify failure'}}
}
if($FailAfterVerify){
 try{$null=Apply-StagedUpdate;throw 'rollback scenario did not fail'}
 catch{
  if($_.Exception.Message -notmatch 'injected post-verify failure'){throw}
  if(-not $script:PostVerified){throw 'installed validation never executed'}
  $version=(Get-Content (Join-Path $Root 'VERSION-MANIFEST.json') -Raw|ConvertFrom-Json).runtime.devspacePortable
  if($version -ne '1.1.41'){throw 'rollback did not restore the original manifest'}
  '{"rollbackVerified":true}'
 }
}else{
 $result=Apply-StagedUpdate
 if(-not $result.success -or -not $script:PostVerified){throw 'blockmap transaction did not finish'}
 '{"applyVerified":true}'
}
