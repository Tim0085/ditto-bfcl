param([Parameter(Mandatory=$true)][string]$Stage,[Parameter(Mandatory=$true)][string]$Root,[string]$TargetedSplit,[string]$Authorization,[switch]$PlanOnly,[switch]$Live,[string]$EnvFile,[string]$LiveAuthorization)
$ErrorActionPreference='Stop'
# T9 C2: -EnvFile is the path of the key file. An empty value or one that names no file stops here (Test-Path reads no content) and is not echoed.
if($PSBoundParameters.ContainsKey('EnvFile') -and ([string]::IsNullOrWhiteSpace($EnvFile) -or -not (Test-Path -LiteralPath $EnvFile -PathType Leaf))){throw 'Key file path does not exist or is empty (-EnvFile takes the path of the key file)'}
function Test-SameStageValue($A,$B){
    if($null -eq $A -or $null -eq $B){return ($null -eq $A -and $null -eq $B)}
    if($A -is [pscustomobject] -or $B -is [pscustomobject]){
        if($A -isnot [pscustomobject] -or $B -isnot [pscustomobject]){return $false}
        $aKeys=@($A.PSObject.Properties.Name | Sort-Object);$bKeys=@($B.PSObject.Properties.Name | Sort-Object)
        if(($aKeys -join "`0") -cne ($bKeys -join "`0")){return $false}
        foreach($key in $aKeys){if(-not (Test-SameStageValue $A.$key $B.$key)){return $false}}
        return $true
    }
    if(($A -is [System.Collections.IEnumerable] -and $A -isnot [string]) -or ($B -is [System.Collections.IEnumerable] -and $B -isnot [string])){
        if($A -isnot [System.Collections.IEnumerable] -or $B -isnot [System.Collections.IEnumerable] -or $A -is [string] -or $B -is [string]){return $false}
        $left=@($A);$right=@($B);if($left.Count -ne $right.Count){return $false}
        for($i=0;$i -lt $left.Count;$i++){if(-not (Test-SameStageValue $left[$i] $right[$i])){return $false}}
        return $true
    }
    return (($A | ConvertTo-Json -Compress) -ceq ($B | ConvertTo-Json -Compress))
}
if(-not $env:TEMP -or -not $env:TEMP.Replace('\','/').StartsWith('F:/Academic/Ditto/experiments/sec1/_tmp/',[StringComparison]::OrdinalIgnoreCase)){$env:TEMP='F:\Academic\Ditto\experiments\sec1\_tmp\os\scheduler'}
$env:TMP=$env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
$nodeArgs=@('--import','./scripts/egress-offline-guard.mjs','--experimental-transform-types','scripts/t8a.ts')
if(-not (Test-Path -LiteralPath (Join-Path $Root 'plan.json'))){
    $planArgs=@('plan','--stage',$Stage,'--root',$Root)
    if($TargetedSplit){$planArgs+=@('--targeted-split',$TargetedSplit)}
    & node @nodeArgs @planArgs
    if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
} else {
    $frozen=Get-Content -LiteralPath (Join-Path $Root 'plan.json') -Raw | ConvertFrom-Json
    $requested=Get-Content -LiteralPath $Stage -Raw | ConvertFrom-Json
    $propertyNames=@('version','runId','stage','seed','rounds','blockSize','configs','batches','python','egress','endpoint','sampling','startupConcurrency','stall','score','hostSampleMs','targetedSplit','prices','launcher')
    foreach($name in $propertyNames){
        $a=$requested.$name; $b=$frozen.stage.$name
        if($name -eq 'launcher' -and $a -and $b){
            if($a -isnot [pscustomobject] -or $b -isnot [pscustomobject]){throw 'Stage differs from frozen plan at launcher: object required'}
            if($null -ne $a.imageId -and $a.imageId -isnot [string]){throw 'Stage differs from frozen plan at launcher.imageId: string required'}
            $a=$a | ConvertTo-Json -Depth 100 | ConvertFrom-Json
            if(-not $a.imageId){$a | Add-Member -NotePropertyName imageId -NotePropertyValue $b.imageId -Force}
        }
        if($name -eq 'targetedSplit'){
            if($TargetedSplit){$a=$TargetedSplit}
            if(($null -ne $a -and $a -isnot [string]) -or ($null -ne $b -and $b -isnot [string])){throw 'Stage differs from frozen plan at targetedSplit: string required'}
            if($a){$a=[System.IO.Path]::GetFullPath($a)}
            if($b){$b=[System.IO.Path]::GetFullPath($b)}
        }
        if(-not (Test-SameStageValue $a $b)){throw "Stage differs from frozen plan at '$name'; use the matching Stage or a new Root"}
    }
}
if(-not $PlanOnly){$runArgs=@('run','--root',$Root);if($Authorization){$runArgs+=@('--authorization',$Authorization)};if($Live){$runArgs+=@('--live')};if($EnvFile){$runArgs+=@('--key-file',$EnvFile)};if($LiveAuthorization){$runArgs+=@('--live-authorization',$LiveAuthorization)};& node @nodeArgs @runArgs;exit $LASTEXITCODE}
