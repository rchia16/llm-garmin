# AGENTS.md — Project Scaffolding and Development Rules

**Project:** Local Workout Builder  
**Version:** 2.0  
**Status:** Project-level agent instructions  
**Purpose:** Define the long-term goals, architecture, development philosophy, style, constraints, and working rules for all coding agents contributing to this project.

---

# 1. Project mission

Build a lightweight, local-first workout creation tool that allows a single user to describe a workout in natural language and quickly turn it into a structured, reviewable, editable, schedulable workout.

The intended experience is:

```text
Natural-language workout request
        ↓
Structured workout interpretation
        ↓
Deterministic target resolution
        ↓
Review / edit
        ↓
Choose or confirm workout day
        ↓
Schedule / export
```

The project should remain fast, understandable, local-first, and robust enough to become part of the user's regular training workflow.

The tool is not intended to become a general fitness social platform, coaching marketplace, cloud SaaS product, or large-scale athlete management system.

---

# 2. Primary product goals

The product should optimize for:

1. **Very low interaction cost**
   - A workout should be describable in one short prompt.
   - Review and confirmation should take seconds.
   - Scheduling should require minimal interaction.

2. **Local-first operation**
   - Core functionality should run on a normal laptop.
   - Internet access should not be required for workout creation.
   - Local inference should be the default.
   - Remote inference may be used through trusted private infrastructure such as Tailscale.

3. **Deterministic workout mathematics**
   - Numerical training calculations must not be delegated to an LLM.
   - Threshold pace, FTP, CSS, target ranges, and recalculation logic must be explicit, inspectable, and tested.

4. **Human review before external action**
   - AI-generated structure should always be reviewable before being scheduled or sent externally.
   - The user should be able to edit a single workout block without regenerating the whole workout.

5. **Graceful degradation**
   - If Garmin integration fails, local scheduling and FIT export should still work.
   - If the LLM fails, the workout engine should remain usable.
   - No single external dependency should make the project unusable.

6. **Replaceable integrations**
   - Garmin, TrainingPeaks, and other external destinations must be adapters around the core model.
   - The core application must not depend on a proprietary API structure.

---

# 3. Supported use case

The initial and primary user is a single local user.

Supported workout domains:

- running
- cycling
- swimming

Typical inputs:

```text
Tomorrow, 5 x 1 km at threshold with 90 sec recovery.
```

```text
Saturday ride 90 min Z2 with 3 x 8 min at 105% FTP.
```

```text
10 x 100 free at CSS + 5, 20 sec rest.
```

Typical workflow:

```text
Describe
→ Parse
→ Resolve profile-dependent targets
→ Review
→ Edit if needed
→ Confirm day
→ Schedule/export
```

---

# 4. Non-goals

Do not expand the project toward these unless explicitly requested:

- social networking
- public user accounts
- cloud-hosted athlete profiles
- large-scale multi-user deployment
- marketplace features
- coach dashboards
- nutrition planning
- strength programming
- automatic long-term training plans
- automatic clinical or medical recommendations
- injury diagnosis
- arbitrary sport support
- gamification
- paid subscriptions
- native mobile applications during early development

Avoid unnecessary scope growth.

---

# 5. Product philosophy

The project should behave like a **fast tool**, not a chatbot.

The LLM exists to interpret intent.

It should not become the central execution engine.

Core design rule:

```text
LLM = interpretation
Code = truth
```

The LLM may determine that a phrase means:

```text
5 x 1 km
at threshold
90 sec recovery
```

But deterministic code must decide:

- actual target pace
- actual target watts
- CSS-derived pace
- zone boundaries
- date conversion
- persistence
- export structure
- external payload generation

---

# 6. Canonical architecture

The project must retain one platform-independent canonical workout model.

Conceptual architecture:

```text
Natural language
       ↓
Workout parser
       ↓
Canonical workout
       ↓
Workout engine
       ↓
Review/edit state
       ↓
Destination adapter
       ├── Local calendar
       ├── FIT
       ├── Garmin Connect experimental
       ├── Garmin Training API
       └── TrainingPeaks
```

The canonical model is the center of the system.

External APIs must never become the internal data model.

---

# 7. Technology direction

Default stack:

## Core application

- TypeScript
- Node.js
- npm
- Zod
- SQLite

## User interface

- React
- TypeScript
- Vite
- responsive web/PWA

## Local inference

- llama.cpp
- GGUF instruction model
- constrained JSON output

## Optional remote inference

- llama.cpp server
- Dell ProMax GB10
- Tailscale

## Garmin experimental integration

- isolated Python bridge
- community Garmin Connect client
- local authentication only

## Garmin official integration

- future adapter
- only after official API access is available

## FIT generation

- official Garmin FIT tooling where feasible
- deterministic encoding
- round-trip validation

Do not introduce C#/.NET unless a future requirement clearly justifies it.

---

# 8. Hardware target

The application should be designed to work on:

## Primary local development/runtime target

- ThinkPad Carbon X1 2018-class laptop
- Windows
- modest CPU
- 8–16 GB RAM
- no discrete GPU assumed

## Optional acceleration target

- Dell ProMax GB10
- accessed remotely
- Tailscale
- used only for inference acceleration if desired

## Client targets

- Pixel 9 Pro
- iPhone X and above
- desktop browser
- laptop browser

Mobile devices should initially act as browser/PWA clients.

Do not require native mobile development for early versions.

---

# 9. Local-first requirements

Core workout creation must remain functional without:

- Garmin API
- TrainingPeaks API
- internet-hosted LLM
- cloud database

Local-only workflow should support:

```text
Prompt
→ Workout
→ Review
→ Save
→ Local calendar
→ FIT export
```

External integrations are optional destinations.

---

# 10. Data ownership and privacy

The application should assume personal workout/profile data belongs to the local user.

Default expectations:

- athlete profile stored locally
- workout history stored locally
- SQLite used for persistence
- no cloud telemetry by default
- no remote model calls unless explicitly configured
- Garmin credentials never stored as plain text
- external writes happen only after user confirmation

Do not introduce analytics or external telemetry without explicit approval.

---

# 11. Athlete profile philosophy

The profile exists to reduce repeated questions.

The project should remember useful training baselines such as:

## Running

- threshold pace
- threshold heart rate if provided
- pace zone system

## Cycling

- FTP
- threshold heart rate if provided
- power zone system

## Swimming

- CSS / threshold pace
- threshold method
- pool length

If a workout references a value the system does not know:

```text
threshold
FTP
CSS
```

the application should ask once.

The answer should update the profile.

If the user explicitly updates the baseline in a later prompt, that update should be accepted and reflected in future workouts.

---

# 12. Training-intensity philosophy

Training prescriptions have two layers:

```text
Prescription
Resolved value
```

Example:

```text
Prescription:
threshold

Resolved:
4:18/km
```

These must remain separate.

A relative prescription should never be destructively replaced by its current numeric result.

That allows later recalculation when the athlete profile changes.

---

# 13. Explicit vs relative targets

This distinction is fundamental.

Examples:

```text
4:30/km
300 W
1:35/100m
```

are explicit values.

By default they must remain unchanged if athlete baselines change.

Examples:

```text
threshold
Z2
105% FTP
CSS + 5
```

are relative values.

They must update if the relevant athlete baseline changes.

Default rule:

```text
baseline change
→ update relative targets
→ preserve explicit targets
```

The application may later expose a deliberate option to rescale explicit compatible targets, but this must not be the default.

---

# 14. Running calculations

Primary baseline:

```text
threshold pace
```

Running recalculation must preserve relative speed, not apply arbitrary fixed seconds.

Internal calculations should use speed relationships.

For threshold pace:

```text
P_t = seconds per km
```

and threshold-speed fraction:

```text
r
```

target pace is:

```text
P_target = P_t / r
```

This logic must remain deterministic and unit-tested.

Named running zones must be explicitly tied to a named convention.

Default:

```text
friel_trainingpeaks
```

Never call a zone scheme simply:

```text
standard
```

---

# 15. Cycling calculations

Primary baseline:

```text
FTP
```

Relative targets should preserve FTP fractions.

Example:

```text
105% FTP
```

must remain stored conceptually as:

```text
1.05 × FTP
```

not merely its current watt value.

Default zone convention:

```text
Coggan
```

Explicit watt values must remain fixed unless the user deliberately requests rescaling.

---

# 16. Swimming calculations

Primary baseline:

```text
threshold pace / CSS
```

Support relative prescriptions such as:

```text
CSS
CSS + 5 sec/100m
CSS - 2 sec/100m
```

These relationships should remain relative.

Do not force swimming into cycling/running percentage-zone systems unless later requirements explicitly justify it.

---

# 17. LLM role

The LLM should perform bounded semantic parsing.

Good LLM responsibilities:

- detect sport
- identify workout structure
- identify repeats
- identify work/recovery
- identify time/distance
- identify named targets
- identify profile updates
- interpret natural date phrases
- detect unresolved concepts

Bad LLM responsibilities:

- calculate threshold pace
- calculate FTP zones
- invent CSS
- invent athlete profile values
- decide Garmin payload fields
- perform numeric conversion
- silently repair invalid workout logic

The application must validate all LLM output before using it.

---

# 18. LLM output policy

Use constrained structured output.

Prefer:

```text
JSON Schema
```

over free-form text.

The LLM must output a structured intermediate object.

The application should reject invalid model output rather than trying to guess what it meant.

If parsing fails:

1. one controlled retry is acceptable
2. otherwise show a clear interpretation failure
3. do not fabricate missing values

---

# 19. Model selection philosophy

Model quality should be measured against project-specific fixtures.

Do not choose a model solely by:

- parameter count
- popularity
- benchmark marketing
- reasoning capability

Evaluate models on:

- valid structured output
- workout structure accuracy
- date extraction
- unit extraction
- repeat interpretation
- profile update extraction
- unresolved-value detection
- latency
- memory usage

Prefer the smallest model that reliably solves the task.

Current default direction:

```text
Ministral 3 3B Instruct
```

but the application must not hard-code itself to one model.

---

# 20. UI philosophy

The user interface should feel fast and minimal.

Primary flow:

```text
Describe
→ Review
→ Schedule
```

Avoid:

- excessive settings
- nested configuration dialogs
- chat-like back-and-forth for simple tasks
- dashboard overload

The main review screen should display the workout structure prominently.

---

# 21. Review/edit philosophy

The review screen is a required safety and usability layer.

The user should be able to see:

- workout name
- sport
- duration
- workout blocks
- repeat structure
- target values
- target source
- profile baseline
- scheduled date

Individual blocks should be editable independently.

Editing one block must not require another LLM call.

---

# 22. Baseline adjustment UI

The review screen should expose the relevant baseline:

```text
Running threshold pace
Cycling FTP
Swimming threshold pace
```

Changing the baseline should:

- immediately recalculate relative targets
- preserve explicit targets by default
- require no LLM call

The recalculation should be deterministic and visibly reflected in the workout.

---

# 23. Scheduling philosophy

Scheduling is day-based.

No time-of-day scheduling is required unless explicitly added later.

If the user specifies:

```text
tomorrow
Sunday
next Tuesday
```

the application should resolve that to an absolute date.

Before external scheduling, show the absolute day.

Canonical persisted dates should be:

```text
YYYY-MM-DD
```

Never persist only:

```text
tomorrow
```

---

# 24. Destination strategy

Destinations must use an adapter abstraction.

Expected destinations:

```text
LocalDestination
FitDestination
GarminConnectExperimentalDestination
GarminTrainingApiDestination
TrainingPeaksDestination
```

Not all destinations need to exist initially.

Core code must not care which destination is active.

---

# 25. Garmin integration strategy

Garmin integration should be layered.

## Reliable baseline

FIT export.

## Experimental automation

Private Garmin Connect endpoints through an isolated community client.

Treat this as:

```text
experimental
unsupported
replaceable
```

## Future preferred path

Official Garmin Training API when access becomes available.

Do not tightly couple the product to private Garmin internals.

---

# 26. Experimental Garmin rules

The experimental Garmin integration must:

- remain isolated from the core engine
- be clearly labelled experimental
- fail gracefully
- never block local workout creation
- avoid storing the Garmin password in project data
- verify external writes when possible

Expected flow:

```text
Create
→ Schedule
→ Read back
→ Verify
```

Do not report success merely because an HTTP request returned without error.

---

# 27. FIT strategy

FIT output is a first-class fallback, not an afterthought.

FIT generation should be deterministic.

Development verification should support:

```text
Canonical workout
→ FIT encode
→ FIT decode
→ compare
```

Round-trip testing should cover:

- step order
- repeat groups
- duration
- distance
- target values
- sport

---

# 28. Persistence philosophy

SQLite is the default local store.

Prefer simple storage.

Do not over-normalize nested workout structure during early versions.

A validated canonical workout may be stored as JSON alongside indexed metadata such as:

```text
id
sport
name
scheduled_date
created_at
updated_at
```

Runtime validation is mandatory when loading persisted structured data.

---

# 29. Coding style

Favor:

- clarity
- small pure functions
- explicit units
- explicit domain names
- strict TypeScript
- discriminated unions
- typed results
- immutable transformations where practical
- central constants
- readable tests

Avoid:

- `any`
- giant classes
- giant files
- hidden global state
- unnecessary inheritance
- premature microservices
- generic frameworks for problems not yet present
- duplicated conversion logic
- magic numbers
- over-engineered dependency injection

Prefer boring, testable code over clever abstractions.

---

# 30. Naming conventions

Names should expose meaning and units.

Good:

```text
thresholdPaceSecPerKm
distanceMeters
durationSeconds
ftpWatts
thresholdPaceSecPer100m
```

Avoid:

```text
pace
value
distance
duration
threshold
```

when the unit or meaning is ambiguous.

---

# 31. Comments and documentation

Comments should explain:

- why a scientific convention is used
- units
- unusual edge cases
- external API assumptions
- non-obvious transformations

Do not comment obvious syntax.

Example:

Good:

```text
// Friel running zones are defined in pace ratios.
// Convert to speed ratios before applying threshold-speed scaling.
```

Bad:

```text
// Add one to counter
counter++;
```

---

# 32. Testing philosophy

Tests should protect behavior that matters to the user.

Prioritize:

1. scientific calculations
2. target resolution
3. explicit vs relative preservation
4. nested workout structure
5. dates
6. persistence
7. export correctness
8. adapter behavior

Do not chase coverage percentage at the expense of useful tests.

---

# 33. Deterministic test requirements

Tests must not depend on:

- current real date
- live Garmin data
- network availability
- local timezone assumptions
- random athlete values

Inject:

- reference date
- timezone/context
- fixture profiles
- fixture workouts
- mock external services

---

# 34. LLM tests

LLM evaluation should use a fixed fixture set.

Representative prompt classes:

- simple easy session
- repeats
- mixed durations
- named zones
- explicit pace
- explicit watts
- threshold targets
- FTP percentages
- CSS offsets
- profile updates
- missing baselines
- date phrases
- shorthand
- ambiguous wording

Track:

```text
schema validity
semantic correctness
latency
memory
hallucinated values
```

Do not judge by prose quality.

---

# 35. Error-handling philosophy

Errors should be explicit and recoverable.

Examples:

## Missing baseline

Return:

```text
RUNNING_THRESHOLD_PACE_REQUIRED
```

not:

```text
4:30/km guessed
```

## LLM unavailable

Allow:

```text
retry
manual editing
```

## Garmin unavailable

Allow:

```text
local save
FIT export
retry later
```

## Invalid external write

Do not mark workout as synchronized.

---

# 36. Scientific integrity rule

No hidden training assumptions.

If the application uses:

```text
Friel
Coggan
CSS
```

the code should say so explicitly.

Do not create proprietary-looking thresholds or zones without evidence or documentation.

Where multiple accepted conventions exist, the chosen convention should be named and replaceable.

---

# 37. Security philosophy

Keep the attack surface small.

Prefer:

- localhost binding
- local database
- private Tailscale access
- no public server
- no unnecessary open ports
- no stored plain-text credentials

External authentication should be isolated.

Secrets must never be committed.

---

# 38. Repository hygiene

Do not commit:

```text
node_modules/
*.db
.env
API credentials
Garmin tokens
GGUF model files
build artifacts
temporary test files
Python virtual environments
```

Provide appropriate `.gitignore`.

Large models should live outside Git.

---

# 39. Dependency philosophy

Add dependencies only when they clearly reduce development risk or complexity.

Before adding a package, consider:

1. Can this be implemented safely in a few lines?
2. Does the dependency create native Windows build problems?
3. Is the package maintained?
4. Is the dependency central or incidental?
5. Will it complicate deployment?

Avoid large frameworks for simple utilities.

---

# 40. Development environment assumptions

Expected local tools:

- VS Code
- Git
- Node.js LTS
- npm
- Python 3.11/3.12 for later Garmin bridge
- llama.cpp for later phases
- Tailscale
- Chrome/Edge

Optional:

- PowerShell 7
- Windows Terminal
- DB Browser for SQLite

Do not assume Docker is installed.

---

# 41. Development workflow for agents

Before modifying code:

1. inspect the workspace
2. read this file
3. read the current README
4. inspect existing tests
5. identify the active development phase
6. identify what is explicitly out of scope
7. inspect existing conventions before introducing new ones

Do not overwrite existing architecture without understanding it.

---

# 42. Implementation behavior for agents

Agents should:

- implement rather than only propose when asked to code
- run tests after modifications
- fix locally fixable failures
- keep changes scoped
- avoid speculative rewrites
- preserve working behavior
- explain assumptions
- update documentation when behavior changes

Agents should not:

- silently broaden scope
- add unrelated features
- refactor the whole repository without need
- change scientific conventions without explicit reason
- invent API credentials
- create external accounts
- apply for API access
- perform externally facing actions on the user's behalf unless explicitly authorized and supported

---

# 43. Decision hierarchy

When requirements conflict, use this priority:

1. user instruction in the current task
2. safety and data integrity
3. canonical architecture
4. deterministic scientific correctness
5. local-first behavior
6. simplicity
7. performance
8. extensibility
9. cosmetic elegance

Do not sacrifice correctness for UI polish.

---

# 44. Style hierarchy

The application should feel:

```text
fast
minimal
clear
predictable
local
trustworthy
```

Avoid making it feel:

```text
chatty
bloated
complex
enterprise
opaque
```

---

# 45. Project phases

The project should progress in controlled phases.

## Phase 1 — deterministic core

Build:

- canonical schema
- athlete profile
- calculations
- target resolution
- baseline recalculation
- date utilities
- SQLite
- tests

No LLM or UI.

## Phase 2 — local natural-language parsing

Add:

- llama.cpp
- model configuration
- constrained structured output
- prompt fixtures
- unresolved profile handling
- model benchmarking

## Phase 3 — review UI

Add:

- React
- responsive layout
- Describe screen
- Review screen
- block editing
- baseline adjustment
- date selection
- local calendar

## Phase 4 — FIT output

Add:

- workout FIT generation
- round-trip validation
- download/export flow

## Phase 5 — experimental Garmin Connect

Add:

- isolated Python bridge
- authentication
- workout creation
- scheduling
- verification
- graceful fallback

## Phase 6 — hardening

Add:

- PWA
- installer/start scripts
- mobile polish
- backup/export
- robust error handling
- LLM benchmark refinement
- history improvements

## Phase 7 — official integrations

When access is available:

- Garmin Training API adapter
- optional TrainingPeaks adapter

Do not jump phases without user approval when phase boundaries materially change dependencies or architecture.

---

# 46. Phase completion rule

At the end of each development phase, verify:

```text
tests pass
typecheck passes
build passes
manual/demo flow works
README updated
scope respected
```

Do not automatically begin the next phase.

Report completion and wait unless the user has explicitly requested continuation.

---

# 47. Versioning approach

Use semantic project versions once the first prototype is usable.

Suggested progression:

```text
0.1.0 deterministic core
0.2.0 local LLM parsing
0.3.0 review UI
0.4.0 FIT export
0.5.0 experimental Garmin
0.9.0 hardened local beta
1.0.0 stable local-first workflow
```

Version numbers are guidance, not immutable requirements.

---

# 48. Configuration philosophy

Configuration should remain small.

Likely settings:

```text
LLM backend
local/remote LLM URL
selected model
default zone systems
database path
Garmin connector enabled/disabled
```

Avoid large configuration files with unused options.

Prefer sensible defaults.

---

# 49. Logging

Logging should help diagnose failures without leaking sensitive data.

Log:

- workout parsing status
- validation failures
- target resolution failures
- destination adapter results
- FIT validation results

Do not log:

- passwords
- auth tokens
- secrets

Prompt logging should be local only and optional if later enabled.

---

# 50. Performance expectations

The UI and deterministic engine should feel immediate.

Target behavior:

```text
profile calculations: effectively instant
block edits: instant
baseline recalculation: instant
SQLite operations: instant
```

LLM parsing may take several seconds on the Carbon X1.

That is acceptable.

Do not add complexity merely to optimize sub-second operations that are already negligible.

---

# 51. Cross-platform expectations

Primary development is Windows.

Core logic should remain portable to:

- Windows
- Linux
- macOS

Avoid Windows-only assumptions in the domain layer.

Path handling should use platform-safe utilities.

Shell scripts should have Windows-compatible equivalents where needed.

---

# 52. UI accessibility

When the UI is introduced:

- use readable contrast
- use clear labels
- avoid tiny controls
- support keyboard interaction where practical
- do not rely only on color to convey target source or status
- make touch targets appropriate for mobile

The interface should remain usable on older iPhones and small screens.

---

# 53. Review-state clarity

The user should be able to distinguish:

```text
explicit target
profile-derived target
unresolved target
```

Do not hide this distinction.

The review UI may use labels such as:

```text
EXPLICIT
PROFILE
NEEDS INPUT
```

but keep visual treatment compact.

---

# 54. Profile update transparency

When a prompt changes the athlete profile, show the change.

Example:

```text
Running threshold:
4:25/km → 4:18/km
```

Profile changes should not occur silently.

Future UI should allow confirmation before persisting significant baseline updates if ambiguity exists.

---

# 55. External-action transparency

Before sending externally, the user should know:

- destination
- scheduled date
- workout summary

External action should happen only after confirmation.

No hidden background synchronization in early versions.

---

# 56. Offline behavior

Without internet:

- app should open
- existing profile should load
- deterministic workout engine should work
- local calendar should work
- local LLM should work if configured
- FIT generation should work

Only external sync should fail.

---

# 57. Documentation requirements

The repository README should describe:

- project purpose
- architecture
- development setup
- current phase
- supported sports
- supported workflows
- how to run
- how to test
- known limitations
- next phase

This AGENTS file describes agent behavior and long-term project principles.

Do not duplicate this file verbatim into README.

---

# 58. Architecture documentation

As the system grows, maintain a short architecture document if needed.

Prefer diagrams such as:

```text
UI
 ↓
Application service
 ↓
Canonical workout engine
 ↓
Persistence / adapters
```

Keep architecture documentation aligned with actual code.

Avoid aspirational diagrams describing components that do not exist.

---

# 59. Technical-debt policy

Technical debt is acceptable during prototyping when it is:

- explicit
- contained
- reversible
- documented

Do not accept debt that compromises:

- scientific calculations
- data integrity
- external write verification
- credential safety
- canonical schema clarity

---

# 60. Refactoring policy

Refactor when:

- duplicated domain logic appears
- units become ambiguous
- schemas drift
- adapters leak into core logic
- tests expose brittle design

Do not refactor merely for stylistic preference when code is already clear and tested.

---

# 61. API abstraction rule

External service APIs should map:

```text
Canonical workout
→ adapter transformation
→ external request
```

Never:

```text
external API payload
→ becomes canonical workout
```

unless importing an external workout is explicitly added later.

---

# 62. Failure-first integration design

Every external adapter must define:

- authentication failure
- network failure
- schema rejection
- rate limiting
- write success
- write verification failure
- recovery behavior

A failed external integration must never corrupt the local workout.

---

# 63. Garmin developer-program constraint

The project currently assumes official Garmin API access may not be available.

Therefore:

```text
official Garmin API access
```

must never be required for local development or core functionality.

The official adapter should remain optional until access exists.

---

# 64. Experimental integration disclaimer

Reverse-engineered Garmin Connect functionality is:

```text
experimental
unsupported
subject to breakage
```

Treat it as a convenience layer.

Do not design the product around permanent availability of private endpoints.

---

# 65. No external approvals

Agents must not:

- apply for Garmin API access
- apply for TrainingPeaks API access
- create developer accounts
- submit external forms

The user will perform externally facing approval actions.

---

# 66. Definition of a successful prototype

The prototype succeeds when the user can perform this workflow locally:

```text
Type:
"Tomorrow 6 x 800 m at threshold,
90 sec recovery,
15 min warm-up,
10 min cooldown."

↓ parse

Review:
6 × 800 m
threshold-derived pace
90 sec recovery

↓ optionally change threshold

Targets update immediately

↓ confirm

Workout saved locally

↓ output

FIT available
and/or
Garmin scheduled experimentally
```

The workflow should be fast enough to use casually before training.

---

# 67. Final agent behavior rule

When working in this repository:

**Protect simplicity.**

Prefer the smallest implementation that:

- preserves the canonical architecture
- keeps calculations deterministic
- remains local-first
- is easy to test
- is easy to replace
- moves the user closer to a working tool

Do not turn the prototype into a platform before the core experience is proven.

