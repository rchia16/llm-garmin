# Local Workout Builder

Phase 1's deterministic core and Phase 2's local interpretation boundary are implemented. The Phase 3 browser review UI supports running, cycling, and swimming; Phase 4 FIT and Garmin Connect JSON workout downloads are implemented, with Garmin/device compatibility still needing manual validation.

It currently provides:

- Zod-validated canonical workouts and athlete profiles
- deterministic pace, power, and swimming-threshold calculations
- explicit versus profile-derived target handling
- baseline recalculation without an LLM
- local SQLite persistence
- a CLI demonstration and Vitest test suite
- a browser review UI with block creation, drag/reorder controls, nested repeat editing, and dark mode
- Garmin FIT workout download for the reviewed run, ride, or swim
- Garmin Connect workout JSON download for optional third-party browser-extension import
- a replaceable structured-output model adapter for local `llama-server`

It deliberately does not include Garmin account scheduling/sync, TrainingPeaks, or cloud services.

## Create workouts without an LLM

Select **Run**, **Ride**, or **Swim**, then paste one of the examples below into **Describe** and click **Interpret workout**. These recognized formats are parsed locally and require no LLM or GB10 access.

Use the headings `Warm Up:`, `Main Set:`, and `Warm Down:`. Write repeats as `N x (...)`, separating the steps inside parentheses with `+`.

### Run

```text
Warm Up:
10 mins in Z2.

Main Set:
8 x (2 mins in Z5 + 2 min recoveries in Z1).

Warm Down:
5 mins in Z2.
```

For an explicit pace range, this format also works:

```text
1:45:00 @ 06:00-06:40 min/km
Zone 1-Zone 2
```

This creates a 105-minute work block. The zone label remains a note; the explicit pace range takes priority.

### Ride

```text
Warm Up:
5 mins in Z2.

Main Set:
3 x (6 mins in Z4 + 3 mins recovery in Z1).

Warm Down:
5 mins in Z1.
```

### Swim

```text
Warm Up:
1 x (100 FS in Z2 + 100 Pull in Z2 + 10 secs rest).

Main Set:
4 x (100 FS in Z4 + 20 secs rest),
4 x (100 Pull in Z3 + 20 secs rest).

Warm Down:
200 Choice in Z2.
```

Swimming distances without a unit, such as `100 FS`, are interpreted as metres. Stroke and equipment instructions remain in the block notes.

### Format rules

- Use explicit units for run/ride steps: `mins`, `secs`, `m`, or `km`.
- Keep repeat groups inside parentheses, including their rest or recovery.
- Use `Z1`–`Z5` for running/swimming and `Z1`–`Z6` for cycling. Running and swimming also support `Z5a`, `Z5b`, and `Z5c`.
- Enter running threshold pace, cycling FTP, or swimming CSS to resolve zone-based targets. Parsing itself does not need these values.
- Free-form wording outside recognized formats may invoke the configured LLM. Without one, use these formats or edit blocks manually.
- Always review the resulting blocks and targets before exporting.

## Requirements

- Windows, macOS, or Linux
- Node.js 20 LTS or newer, which includes npm
- A web browser such as Chrome or Edge

If Node.js is not installed, download the **LTS** version from [nodejs.org](https://nodejs.org/), install it using the default options, and open a new terminal window. Check that it is available with:

```powershell
node --version
npm --version
```

You should see Node 20 or newer and an npm version number.

## Beginner setup: install and start the app

1. Open PowerShell or Windows Terminal.

2. Move into the project folder. Replace the path if you put the repository somewhere else:

```powershell
cd "C:\Users\raych\Projects\llm-garmin"
```

3. Install the project dependencies:

```powershell
npm install
```

4. Start the local web app:

```powershell
npm run dev
```

5. Open the local address printed by Vite, usually `http://localhost:5173/`, in your browser. Keep the terminal open while using the app. Press `Ctrl+C` in that terminal to stop it.

The app works immediately for deterministic workout formats. Natural-language interpretation requires a local or remote `llama-server`; see [Local interpretation](#local-interpretation). Inference is optional.

## One-click Windows startup

After Node.js has been installed, you can start the app by double-clicking **Start Local Workout Builder.cmd** in the project folder. On the first run it installs the npm dependencies, starts the local server, and opens the app at `http://localhost:5173/`. A server window stays open while the app is running; close that window to stop it.

To create a desktop icon, double-click **Create Local Workout Builder Shortcut.cmd** once. It creates **Local Workout Builder.lnk** on your Windows desktop. The shortcut uses the project folder as its working directory, so the repository can be moved only if the shortcut is recreated afterward.

The launcher does not install Node.js, configure the GB10, or start `llama-server`. Install Node.js first, and configure optional local or remote inference separately using [Local interpretation](#local-interpretation).

## Verify the installation

From the project folder, run:

```powershell
npm run typecheck
npm test
npm run build
```

All three commands should complete without errors. `npm test` runs the automated tests; `npm run build` creates production browser files in `dist-ui`.

## Everyday use

1. Start the app with `npm run dev`.
2. Open the local URL in your browser.
3. Choose Run, Ride, or Swim.
4. Enter a workout request and click **Interpret workout**.
5. Review and edit the blocks, title, zones, duration, date, and athlete baseline.
6. Click **Save locally** if you want to save the reviewed workout in this browser.
7. Download FIT or Garmin Connect JSON when satisfied.

Running threshold pace, cycling FTP, and swimming CSS are automatically retained in browser storage when changed. Clearing browser site data removes the locally stored profile and workout.

## What you can do in the app

```powershell
npm run dev
```

Open the local URL printed by Vite. The UI supports Run, Ride, and Swim modes with threshold pace, FTP, and CSS baseline editing, deterministic target recalculation, date selection, browser-local saving, and optional structured interpretation through the configured model endpoint. The athlete profile is automatically loaded from and saved to browser local storage, so running threshold, cycling FTP, and swimming CSS values persist across reloads and future workouts. Switching sport preserves the block structure while replacing incompatible targets with sport-specific relative prescriptions. Workout blocks can be added, reordered by dragging or arrow controls, nested inside repeat groups, moved back out, and deleted. New warm-ups go to the top, work blocks are inserted before cool-down, and cool-down stays at the bottom. Select adjacent blocks before adding a repeat to wrap them in place; without a selection, a new repeat is added at the bottom. The theme control remembers light or dark mode in the browser.

In Review, use a block's type menu to reclassify warm-up, work, or cool-down without changing its position, duration, notes, or target. This also works inside repeats. The editor labels an active recovery block **Rest** and an untargeted break **Rest**; they remain distinct internal step types and retain their existing FIT intensities. Each active block also has a sport-specific zone menu. Choosing a zone deliberately replaces that block's previous target with a profile-derived zone and recalculates its displayed pace or watts immediately; other blocks are unchanged. The zone menu does not redefine the underlying Friel, Coggan, or swimming zone boundaries.

The Review summary shows planned time and distance. Nested repeats are counted at their full repetition counts. Run/swim time or distance is estimated from resolved target pace where needed; if pace or cycling speed is unknown, the UI shows a known minimum or an unavailable value rather than inventing a number. Rest and active-recovery blocks remain visible within the workout, but there is no recovery total at the top.

After reviewing a workout, select **Download workout FIT**. The export validates the canonical workout, writes a FIT *workout* (not an activity), and checks its CRC and step count by decoding the result. It preserves sport, order, time/distance, repeats, and resolved run-speed/bike-power targets. Profile-derived targets require their baselines before export. Swim stroke/equipment notes are preserved, but when a stroke is the FIT target, CSS-derived pace is written as a cue in notes rather than a second enforced target. The selected date appears in the download filename; a FIT workout file alone does not schedule that day on a Garmin calendar. The official FIT SDK is loaded only when exporting.

**Download Garmin Connect JSON** converts the same reviewed workout into Garmin's workout JSON shape with nested repeat groups. It includes resolved running pace as speed, cycling zones/custom watts, and swim stroke plus secondary pace. This JSON is intended for import through a compatible third-party browser extension such as [Garmin Workout Importer](https://github.com/estruyf/garmin-workout-browser-extension); the app does not log in to Garmin or upload it. The adapter flags custom bike watts, time-based swim steps, and swim pace for visual verification after import. Garmin Connect may interpret these differently, and this project has not yet performed a live account/device compatibility test. The selected date is only in the filename; schedule the imported workout explicitly in Connect, then sync your device. Do not use Connect's activity-file importer for either workout file.

Garmin Connect currently has a documented wireless path for workouts **already in Connect**: add the workout to its calendar in the phone app, then sync the paired device. This app does not yet create the workout in Connect, and Garmin's course/activity import instructions should not be treated as workout import instructions. USB-free one-click delivery requires a later, separately authorized integration and read-back verification. FIT download remains a local fallback.

## GB10 access and SSH key setup (optional)

**Request a GB10 account and Tailscale access through Ray (the project owner) before attempting to connect.** Installing this app or generating an SSH key does not grant access. Ray must approve access, confirm your assigned username, and arrange public-key installation. Do not assume you can use Ray's `rchia` account.

These instructions are for Windows PowerShell. Never share your private key, passphrase, or account password, and never put them in the repository or app settings.

1. Install/sign in to Tailscale with the access approved by Ray. Confirm that Windows OpenSSH is available:

```powershell
ssh -V
```

If it is missing, install **OpenSSH Client** through Windows Optional Features, then reopen PowerShell.

2. Create a dedicated key on your own computer:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ssh" | Out-Null
ssh-keygen -t ed25519 -a 64 -f "$env:USERPROFILE\.ssh\llm_garmin_gb10"
```

Choose a strong passphrase. If that key already exists, reuse it rather than accepting an overwrite. The file ending in `.pub` is the public key; the file without `.pub` is the private key and stays on this computer.

3. Send **only the public key** to Ray through the agreed channel:

```powershell
Get-Content "$env:USERPROFILE\.ssh\llm_garmin_gb10.pub"
ssh-keygen -lf "$env:USERPROFILE\.ssh\llm_garmin_gb10.pub"
```

Ray installs the complete `ssh-ed25519 ...` line in your assigned Linux account's `~/.ssh/authorized_keys`, without overwriting other users' keys. The line must have no UTF-8 BOM, wrapping, or leading characters. On GB10, the account must own these files, with permissions `700` for `~/.ssh` and `600` for `authorized_keys`. A stray BOM was a previous cause of password prompts even after the key had been copied.

4. Unlock the key using Windows `ssh-agent`. Once, in **PowerShell opened as Administrator**, run:

```powershell
Set-Service -Name ssh-agent -StartupType Automatic
Start-Service ssh-agent
```

Then return to your **normal PowerShell under the Windows account that runs the app**:

```powershell
ssh-add "$env:USERPROFILE\.ssh\llm_garmin_gb10"
ssh-add -l
```

Enter the key passphrase when asked. The app uses the agent instead of storing a password or passphrase. For background on this setup, see [Microsoft's OpenSSH key-management guide](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement).

5. Verify the server identity and test your account. Replace the placeholder with the username Ray assigned:

```powershell
$gb10User = "YOUR_ASSIGNED_USERNAME"
ssh -i "$env:USERPROFILE\.ssh\llm_garmin_gb10" -o IdentitiesOnly=yes "$gb10User@100.76.243.123" "whoami"
```

On the first connection, compare the displayed **server host-key fingerprint** with the fingerprint Ray supplies separately. Accept it only after it matches; this stores it in `known_hosts`. The server fingerprint is different from your public-key fingerprint above. Do not disable host-key checking. If a previously trusted host key changes, ask Ray to verify the change before modifying `known_hosts`.

Next, test the non-interactive mode used by the app:

```powershell
ssh -T -i "$env:USERPROFILE\.ssh\llm_garmin_gb10" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes "$gb10User@100.76.243.123" "whoami"
```

It should print your assigned username without a password/passphrase prompt. If it fails, check Tailscale access, the installed public key, agent status, and the verified host key with Ray. Do not repeatedly append the same key to `authorized_keys`.

6. Use the approved GB10 model endpoint in the app. **The current Start default GB10 server button is owner-specific:** it connects to `rchia@100.76.243.123` using `~/.ssh/llm_garmin_gb10`. A separate account does not automatically enable that button; ask Ray to arrange service access/startup. Do not install your key into Ray's account without explicit approval. Remote inference and SSH service control are separate permissions: an authorized model endpoint can be used while its server is already running, without SSH access from the app.

## Local interpretation (optional)

Start `llama-server.exe` separately. Keep the model path and model selection outside this repository, for example in your own PowerShell command:

```powershell
llama-server.exe -hf "mistralai/Ministral-3-3B-Instruct-2512-GGUF:Q4_K_M" --host 127.0.0.1 --port 8080 --jinja --cors-origins localhost
```

`--jinja` enables the model chat-template features used by structured responses. If you move inference to a GB10 gateway or another loader, only the provider adapter or endpoint configuration should change; the parser contract remains model-agnostic.

Then run the UI:

```powershell
npm run dev
```

The **GB10 / model endpoint** defaults to `https://promaxgb10-4e2b.tail06a565.ts.net:8443/v1` through Tailscale Serve and remains editable. Leave **Model name** blank to use whichever model the server loaded. If your server or GB10 gateway requires a model name, enter it there. Enter an API key only if the endpoint requires one; it is held in memory for the current browser session and is not saved to disk. A remote deployment only changes the endpoint field; the parser does not know or care where the model is loaded.

The **Start default GB10 server** button works when the UI is served by the local Vite development or preview server (`npm run dev` or `npm run preview`, bound to `127.0.0.1`). The app checks the default GB10 llama-server `/health` endpoint on load and periodically thereafter; the button is offered only when that endpoint is unreachable or its gateway reports an unavailable upstream. A responding server hides the button, including while the model is still loading. If status cannot be verified, the button stays hidden rather than claiming the server is disconnected. This status check does not change the editable model endpoint field. The health codes follow [llama.cpp's server health contract](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#api-endpoints).

When clicked, the button uses non-interactive OpenSSH with `~/.ssh/llm_garmin_gb10`, strict host-key checking, and the fixed target `rchia@100.76.243.123`. On GB10 it runs `systemctl --user daemon-reload`, `systemctl --user enable --now llm-garmin.service`, then `tailscale serve --bg --https=8443 localhost:8081`. The button selects the default model endpoint after SSH succeeds. It does not create or edit the remote service or its Apptainer launch script; those must already be installed with the desired `Qwen/Qwen3-4B-GGUF:Q4_K_M` configuration. SSH success means startup was requested, not that the model has finished loading. Use `ssh -i "$env:USERPROFILE\.ssh\llm_garmin_gb10" rchia@100.76.243.123 "journalctl --user -u llm-garmin.service -n 50 --no-pager"` to diagnose remote startup. A passphrase-protected key must be unlocked in `ssh-agent` first; the app never prompts for or stores SSH passwords. Static hosting without the local Vite server does not provide this control endpoint.

The model returns semantic JSON such as repeats, durations, threshold, FTP, CSS offsets, named zones, and explicit targets. Zod validates that response, then the existing deterministic engine resolves numeric pace, power, and swim targets. The model never performs those calculations.

With **Run** selected, clock durations and explicit pace ranges also work without a model:

```text
1:45:00 @ 06:00-06:40 min/km
Zone 1-Zone 2
```

This creates one 105-minute work block at **6:00–6:40/km**. `H:MM:SS` means hours/minutes/seconds; `M:SS` means minutes/seconds. Pace units may be `min/km` or `/km`, and a single pace is also accepted. A zone label on the same or next line is retained in notes; it does not override the explicit pace. These steps also work inside recognized section headings and repeats. Both pace endpoints remain editable in Review, survive profile changes unchanged, and are retained in FIT and Garmin Connect JSON exports. Reversed ranges or unsupported extra instructions fall back to model interpretation rather than being silently discarded.

Parser requests disable Qwen reasoning through the llama.cpp chat template and cap output at 3,072 tokens. If JSON is incomplete, the UI reports whether the token limit was reached and shows a short response excerpt. Invalid model output receives one controlled retry. Recognized sectioned workouts are parsed directly without inference: Swim supports `N x (distance stroke in ZN + rest)` and explicit `TEST:` days with distance-based time trials, active recovery, rest, and effort notes; Run and Ride support time-and-zone steps, plus-separated components, and `N x (...)` repeats. Line breaks inside parentheses are accepted. Unrecognized wording still uses the model. Swim test instructions such as `RECORD TIME` are retained as notes; no measured result, zone, or CSS update is invented from them.

For model fallback, the instruction includes a short input-to-JSON example for the selected sport only. Swim fallback also includes a compact `TEST:` day example: 400 m and 200 m time trials with `RECORD TIME`, timed active recovery, a CSS + 5 sec/100m main set, repeats, rest, and cool-down. This teaches the model that `CSS + 5` is one relative target, not a separator between blocks. The example does not invent test results or change the athlete's CSS. Recognized structured swim requests still use the deterministic parser and make no model call.

### Named workout templates

Run mode recognises `Mona Fartlek`, `Moneghetti Fartlek`, and `Steve Moneghetti's Fartlek` without a model call. The classic main set contains four editable repeat groups: **2 × 90/90 seconds, 4 × 60/60, 4 × 30/30, and 4 × 15/15**, effort followed by active float recovery on every repetition. It totals 20 minutes. Template v3 uses the requested reviewable progression: 90/60-second efforts in Z5a, 30-second efforts in Z5b, 15-second sprint efforts in Z5c, and floats in Z2, resolved from running threshold. Z5c retains its open-ended faster-than-90%-of-threshold-pace boundary rather than inventing an exact sprint pace. The 90/60-second groups share the same Z5a range. These zone choices are app defaults rather than a universal Mona prescription; edit the zone menus to match your session. The registry records its source and version. [Sydney Marathon's example](https://sydneymarathon.com/wp-content/uploads/2024/07/2369-D-SM-Intermediate-Training-Guide-updated.pdf) starts around 10 km effort and increases speed as repetitions shorten.

Try `Tomorrow run Mona Fartlek with a 15-minute warm-up in Z2 and 10-minute cooldown.` Explicit time/distance warm-up and cool-down additions are supported, as are today, tomorrow, and an ISO date. Warm-up/cool-down are not added when omitted. Other wording, date phrases, pace prescriptions, or modifications such as `Mona Fartlek without the last group` use model fallback so requested changes are not silently lost.

The shared registry also supplies relevant run/swim pattern guidance to fallback: cruise/VO2max intervals, strides, pyramids, ladders, progression runs, fartlek, Yasso 800s, Norwegian 4 × 4, CSS repeats, endurance/pace/descending/build sets, broken swims, pull/kick/drill, IM and open-water intervals. These categories require explicit parameters and do not generate a complete workout from a name alone. Model instructions list required parameters and preserve missing durations as open steps with explanatory notes rather than guessing repetitions, rest, pace or drills. Review those unresolved details before using the workout. Only definitions matching the selected sport and request are sent to the model.

The Review editor displays whole-minute block durations in minutes and shorter or non-whole-minute durations in seconds; the stored duration remains seconds. Model output with valid JSON but differing repeat counts, timed rests, swim notes, or requested warm-up/cool-down is shown for review with explicit warnings instead of being discarded. Invalid schema, wrong sport, and collapsed multi-component blocks still receive one retry and can fail.

For sectioned Ride workouts, bare `20 in Z2` means 20 minutes only when the same prompt explicitly uses minutes and contains no distance units. `low Z2` and `upper Z2` retain their wording in step notes while the target resolves to the full Coggan Z2 range; the app does not invent lower/upper subzone boundaries. A cross-zone `Z1-2` recovery retains that note without a fabricated numeric target.

Coggan recovery (Z1) resolves to a 0–55% FTP range; its displayed watt target is the upper bound, since zero is a valid range boundary but not a useful single power target. Changing FTP recalculates these zone ranges while leaving explicit watt targets fixed.

Swimming zones use the named `joe_friel_trainingpeaks` seven-zone pace convention. They are resolved deterministically from CSS/T-pace: Z1 is slower than 129% of threshold pace, Z2 is 114–129%, Z3 is 106–113%, Z4 is 101–105%, Z5a is 97–100%, Z5b is 90–96%, and Z5c is faster than 90%. A plain `Z5` prompt is retained as the aggregate Z5a–Z5c family rather than being confused with a repeat count. Stroke and equipment instructions such as `FS`, `pull`, `drill`, fins, or paddles remain step notes.

For swim instructions without an explicit zone or CSS target, the interpreter applies a reviewable app convention to qualitative effort words: Very Easy/Easy/active recovery → Z1, Steady → Z2, Moderately Hard → Z3, Hard → Z5a at 100 m or shorter and Z4 over 100 m, Very Hard → Z5b at 50 m or shorter and Z5a otherwise, and Sprint/All-out → Z5c only at 50 m or shorter. Moderate, progressive builds, and maximal-effort tests stay untargeted; test results are never invented. Explicit targets take precedence over ordinary effort-word defaults, but progressive builds and maximal-effort tests remain open even if the model supplied a zone. These word mappings are app heuristics, **not** a published TrainingPeaks word-to-zone standard; numerical zone boundaries remain the named TrainingPeaks convention. [TrainingPeaks describes swimming-zone effort](https://www.trainingpeaks.com/blog/a-beginners-guide-to-swim-training/) and [its Joe Friel swim-zone calculator](https://help.trainingpeaks.com/hc/en-us/articles/360017420092-Zones-Calculator-Overview). Changing CSS recalculates mapped, profile-derived targets but not explicit or untargeted blocks.

### Seven-zone running pace

Running uses the published `friel_trainingpeaks` seven-zone **pace** convention, independently of heart rate and swim CSS. Percentages below multiply seconds/km of running threshold pace; lower percentages are faster. Code converts these pace ratios to inverse speed fractions for scaling. [Joe Friel's published running pace boundaries](https://www.trainingpeaks.com/learn/articles/joe-friel-s-quick-guide-to-setting-zones/):

| Zone | Threshold pace multiplier |
| --- | --- |
| Z1 Recovery | Slower than 129% |
| Z2 Aerobic | 114–129% |
| Z3 Tempo | 106–113% |
| Z4 Threshold | 99–105% |
| Z5a Super-threshold | 97–100% |
| Z5b Aerobic capacity | 90–96% |
| Z5c Anaerobic capacity | Faster than 90% |

Plain `Z5` remains the aggregate Z5a–Z5c family (at threshold pace or faster), with no invented subzone. Old persisted `z5_anaerobic` prescriptions load as that family; recalculate or reinterpret an older workout to refresh its resolved pace values. Sectioned inputs, model aliases and the editor accept Z5a/b/c. Review shows the finite pace range or a one-sided boundary. An open-ended target is not used to invent time/distance estimates. FIT and Garmin Connect JSON preserve unbounded pace targets as notes with an export warning, rather than narrowing them to a fabricated finite range; finite zones export as numerical speed ranges.

Qualitative running defaults are app heuristics, **not published Friel word-to-zone rules**:

| Wording | Default zone |
| --- | --- |
| Very Easy / Easy / active recovery | Z1 |
| Steady / float recovery | Z2 |
| Moderately Hard / tempo | Z3 |
| Threshold | Z4 |
| Hard | Z5a at ≤2 min or ≤400 m; Z4 otherwise |
| Very Hard | Z5b at ≤1 min or ≤200 m; Z5a otherwise |
| Sprint / All-out | Z5c at ≤30 sec or ≤100 m; open otherwise |

Moderate, builds, progressive efforts, relaxed strides, maximal-effort/time trials and explicitly unspecified targets remain open unless the user supplies a target. Explicit pace/zone/threshold prescriptions take precedence. Both fallback notes and sectioned time/distance inputs such as `2 mins Hard` use this code, preserving nested repeats. Changing running threshold recalculates relative targets while explicit paces remain fixed.

When a running step has neither a pace target nor recognised effort wording, the application retains its existing defaults: work uses threshold speed, while warmup, recovery, and cooldown use `friel_trainingpeaks` Z1. Rest remains untargeted. The profile threshold is required to resolve these defaults; no value is guessed.

## Run the demo

```powershell
npm run demo
```

The demo uses the deterministic engine to resolve a threshold workout, changes the running baseline, proves that derived targets change while explicit targets remain fixed, and round-trips the workout through `data/workout.db`.

## Architecture

```text
Prompt -> deterministic/model interpretation -> canonical workout -> deterministic targets -> Review -> FIT adapter
```

The source is intentionally a single package:

```text
src/domain/    schemas and canonical types
src/engine/    sport calculations and target resolution
src/dates/     deterministic calendar helpers
src/storage/   SQLite persistence
src/demo.ts    command-line proof of the core flow
src/ui/        browser review interface
src/llm/       provider interface, llama-server adapter, and interpretation compiler
src/fit/       Garmin FIT workout encoding and local round-trip check
tests/         fixtures and behavior tests
data/          local database files
```

Future phases can attach an LLM before the canonical model and UI/export/integration adapters after the engine without changing the domain calculations.
