# Local Workout Builder

Phase 1 is a deterministic, local-first workout engine for running, cycling, and swimming.

It currently provides:

- Zod-validated canonical workouts and athlete profiles
- deterministic pace, power, and swimming-threshold calculations
- explicit versus profile-derived target handling
- baseline recalculation without an LLM
- local SQLite persistence
- a CLI demonstration and Vitest test suite
- a browser review UI for structured workout examples

It deliberately does not include natural-language parsing, FIT generation, Garmin, TrainingPeaks, or cloud services. Natural-language parsing remains a later phase.

## Requirements

- Node.js 20 LTS or newer
- npm

## Install and verify

```powershell
npm install
npm run typecheck
npm test
npm run build
```

## Run the UI

```powershell
npm run dev
```

Open the local URL printed by Vite. The UI supports the structured running example, date selection, baseline editing, deterministic target recalculation, and browser-local saving. It does not call an LLM yet.

## Run the demo

```powershell
npm run demo
```

The demo uses the deterministic engine to resolve a threshold workout, changes the running baseline, proves that derived targets change while explicit targets remain fixed, and round-trips the workout through `data/workout.db`.

## Architecture

```text
Canonical Zod model -> deterministic workout engine -> SQLite repository
```

The source is intentionally a single package:

```text
src/domain/    schemas and canonical types
src/engine/    sport calculations and target resolution
src/dates/     deterministic calendar helpers
src/storage/   SQLite persistence
src/demo.ts    command-line proof of the core flow
src/ui/        browser review interface
tests/         fixtures and behavior tests
data/          local database files
```

Future phases can attach an LLM before the canonical model and UI/export/integration adapters after the engine without changing the domain calculations.
