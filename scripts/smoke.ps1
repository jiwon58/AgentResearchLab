param(
    [string]$RustKernel,
    [string]$Database = ':memory:'
)

$ErrorActionPreference = 'Stop'
$previousDatabase = $env:LAB_DB
$previousKernel = $env:LAB_RUST_BIN
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    $env:LAB_DB = $Database
    if ($RustKernel) { $env:LAB_RUST_BIN = (Resolve-Path -LiteralPath $RustKernel).Path }

    node --test tests/*.test.ts scripts/*.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Automated tests failed' }

    $demoJson = node apps/lab/main.ts demo
    if ($LASTEXITCODE -ne 0) { throw 'The manufacturing demo failed to execute' }
    $demo = $demoJson | ConvertFrom-Json
    if ($demo.run.status -notin @('SUCCESS', 'INCONCLUSIVE') -or $demo.progressLedger.validation.independentReproducibility -ne 'PASS') {
        throw 'The demo did not satisfy the frozen validation protocol'
    }

    $benchmarkJson = node apps/lab/main.ts benchmark
    if ($LASTEXITCODE -ne 0) { throw 'The smoke benchmark failed to execute' }
    $benchmark = $benchmarkJson | ConvertFrom-Json
    if ($benchmark.orchestration.Count -ne 4 -or $benchmark.evolution.conditions.Count -ne 7) {
        throw 'The benchmark is missing comparison conditions'
    }
    [pscustomobject]@{
        Run = $demo.run.id
        Runtime = $demo.run.plan.runtime
        Reproduction = $demo.progressLedger.validation.independentReproducibility
        Comparison = $benchmark.comparisonId
        Evaluation = $benchmark.kind
    }
} finally {
    $env:LAB_DB = $previousDatabase
    $env:LAB_RUST_BIN = $previousKernel
    Pop-Location
}
