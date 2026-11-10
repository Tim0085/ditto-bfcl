# Test-only: the guarded test process may not touch a path with a directory named private, so this shell puts the
# fake key file there and starts the real command line, the way an operator would. Paths arrive by environment variable.
$ErrorActionPreference='Stop'
$directory=Join-Path (Split-Path -Parent $env:T9_KEY_SOURCE) 'private'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$key=Join-Path $directory 'fake-live.keys'
Copy-Item -LiteralPath $env:T9_KEY_SOURCE -Destination $key -Force
& node --experimental-transform-types scripts/t8a.ts run --root $env:T9_RUN_ROOT --live --key-file $key --live-authorization $env:T9_AUTHORIZATION
exit $LASTEXITCODE
