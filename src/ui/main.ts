import "./styles.css";
import { garminConfirmation, garminOperationId, requestGarmin } from "./garminClient.js";
import { garminResultMessage } from "../local/garminProtocol.js";
import { showGarminLogin } from "./garminLogin.js";
import {
  demoProfile,
  demoRunningThresholdWorkout,
} from "../fixtures.js";
import {
  explicitRunningPace,
  explicitRunningPaceRange,
  parseRunningPaceText,
  explicitSwimmingPace,
  recalculateWorkout,
  secondsPer100mToPaceString,
  secondsPerKmToPaceString,
  runningPaceLabel,
  updateCyclingFTP,
  updateRunningThreshold,
  updateSwimmingThreshold,
} from "../engine/index.js";
import { LlamaServerProvider, parseWorkout } from "../llm/index.js";
import { summarizeWorkout } from "../engine/workoutSummary.js";
import {
  addWorkoutStep,
  createWorkoutStep,
  defaultDurationForKind,
  editableTimeDuration,
  deleteWorkoutStep,
  findStepContext,
  moveWorkoutStep,
  preferredInsertionIndex,
  reclassifyWorkoutStep,
  retargetWorkoutStepsForSport,
  selectedZone,
  setWorkoutStepZone,
  stepTypeLabel,
  wrapWorkoutSteps,
  zoneChoices,
  type StepKind,
} from "./workoutEditor.js";
import type {
  AthleteProfile,
  Sport,
  Target,
  Workout,
  WorkoutStep,
} from "../domain/index.js";
import { athleteProfileSchema } from "../domain/index.js";

const app = document.querySelector<HTMLDivElement>("#app");
if (app === null) throw new Error("UI mount point was not found.");
const root = app;
const sharedMode = (window as Window & { __WORKOUT_BUILDER_SHARED__?: boolean }).__WORKOUT_BUILDER_SHARED__ === true
  || !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

const initialWorkout: Workout = {
  ...demoRunningThresholdWorkout,
  id: "ui-running-threshold",
  name: "Threshold Builder Example",
  steps: [
    ...demoRunningThresholdWorkout.steps,
    {
      id: "explicit-check",
      type: "work",
      duration: { kind: "distance", metres: 1000 },
      target: explicitRunningPace(270),
    },
  ],
};

const profileStorageKey = "local-workout-builder:athlete-profile";

function loadStoredProfile(): AthleteProfile {
  try {
    const stored = localStorage.getItem(profileStorageKey);
    if (stored !== null) return athleteProfileSchema.parse(JSON.parse(stored));

    // Older versions saved the athlete profile alongside the last reviewed workout.
    // Migrate it so updating the UI doesn't make an existing local profile disappear.
    const previousReview = localStorage.getItem("local-workout-builder:last-review");
    if (previousReview !== null) {
      const previousProfile = athleteProfileSchema.safeParse(JSON.parse(previousReview)?.profile);
      if (previousProfile.success) {
        localStorage.setItem(profileStorageKey, JSON.stringify(previousProfile.data));
        return previousProfile.data;
      }
    }
    return demoProfile;
  } catch {
    try {
      localStorage.removeItem(profileStorageKey);
    } catch {
      // Storage may be unavailable in a restricted browser context; use defaults.
    }
    return demoProfile;
  }
}

function persistProfile(next: AthleteProfile): void {
  profile = next;
  localStorage.setItem(profileStorageKey, JSON.stringify(next));
}

let profile: AthleteProfile = loadStoredProfile();
let workout: Workout = recalculateWorkout(initialWorkout, profile);
let selectedDate = new Date().toISOString().slice(0, 10);
let calendarOpen = false;
let calendarMonth = selectedDate.slice(0, 7);
let notice = "Ready for review";
let jsonExportWarnings: string[] = [];
let garminBusy = false;
let garminReady = false;
let garminStatus = "Optional experimental integration. Connect Garmin or check your saved session.";
let modelBusy = false;
let modelError: string | undefined;
let interpretationWarnings: string[] = [];
const defaultGb10Url = "https://promaxgb10-4e2b.tail06a565.ts.net:10000/v1";
let modelUrl = sharedMode ? `${window.location.origin}/api/inference/v1` : defaultGb10Url;
let gb10Busy = false;
let gb10Connection: "checking" | "ready" | "loading" | "offline" | "unknown" = "checking";
let gb10Status = "Checking default GB10 connection…";
let gb10Error = "";
let gb10CheckBusy = false;
let gb10StartupDeadline = 0;
let modelName = "";
let modelApiKey = "";
let draggedStepId: string | undefined;
let selectedStepIds = new Set<string>();
let stepIdSequence = 0;
let theme: "light" | "dark" = localStorage.getItem("local-workout-builder:theme") === "dark"
  || (localStorage.getItem("local-workout-builder:theme") === null && matchMedia("(prefers-color-scheme: dark)").matches)
  ? "dark"
  : "light";
localStorage.removeItem("local-workout-builder:swim-test-prompt");
let promptText = localStorage.getItem("local-workout-builder:last-prompt") ?? "Tomorrow do 5 x 1 km at threshold with 90 sec easy recovery, 10 min warm-up and cooldown.";

function nextStepId(): string {
  stepIdSequence += 1;
  return `manual-${Date.now()}-${stepIdSequence}`;
}

function commitSteps(steps: WorkoutStep[], message: string): void {
  workout = recalculateWorkout({ ...workout, steps, updatedAt: new Date().toISOString() }, profile);
  notice = message;
  render();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function utcDateFromIso(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(utcDateFromIso(value));
}

function renderCalendar(): string {
  const [year = 1970, month = 1] = calendarMonth.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const leadingBlanks = (first.getUTCDay() + 6) % 7;
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(first);
  const cells = [
    ...Array.from({ length: leadingBlanks }, () => `<span class="calendar-blank" aria-hidden="true"></span>`),
    ...Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const iso = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
      return `<button type="button" class="calendar-day ${iso === selectedDate ? "selected" : ""}" data-calendar-date="${iso}" aria-label="${displayDate(iso)}" aria-pressed="${iso === selectedDate}">${day}</button>`;
    }),
  ].join("");
  return `<div class="calendar-popover" role="dialog" aria-label="Choose workout day">
    <div class="calendar-header"><button type="button" data-calendar-move="-1" aria-label="Previous month">←</button><strong>${escapeHtml(monthLabel)}</strong><button type="button" data-calendar-move="1" aria-label="Next month">→</button></div>
    <div class="calendar-weekdays" aria-hidden="true">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="calendar-grid">${cells}</div>
  </div>`;
}

function updateSteps(steps: WorkoutStep[], stepId: string, update: (step: WorkoutStep) => WorkoutStep): WorkoutStep[] {
  return steps.map((step) => {
    if (step.id === stepId) return update(step);
    if (step.type === "repeat") return { ...step, steps: updateSteps(step.steps, stepId, update) };
    return step;
  });
}

function targetEditValue(target: Target): string {
  if (target.sport === "running" && target.prescriptionKind === "explicit_pace" && target.resolved?.rangePaceSecPerKm !== undefined) return runningPaceLabel(target.resolved).replace("/km", "");
  if (target.resolved?.kind === "running_pace") return secondsPerKmToPaceString(target.resolved.paceSecPerKm).replace("/km", "");
  if (target.resolved?.kind === "cycling_power") return String(Math.round(target.resolved.watts));
  if (target.resolved?.kind === "swimming_pace") return secondsPer100mToPaceString(target.resolved.paceSecPer100m).replace("/100m", "");
  return "";
}

function targetUnit(target: Target | undefined): string {
  if (target?.resolved?.kind === "running_pace") return "/km";
  if (target?.resolved?.kind === "cycling_power") return "W";
  if (target?.resolved?.kind === "swimming_pace") return "/100m";
  return "";
}

function editTarget(target: Target, value: number): Target {
  if (target.sport === "running") return explicitRunningPace(value);
  if (target.sport === "cycling") return { sport: "cycling", prescriptionKind: "explicit_watts", source: "explicit", watts: value, resolved: { kind: "cycling_power", watts: value } };
  return explicitSwimmingPace(value);
}

function targetLabel(target: Target | undefined): string {
  if (target === undefined) return "No target";
  if (target.resolved === undefined) return "Needs profile input";
  if (target.resolved.kind === "running_pace") return runningPaceLabel(target.resolved);
  if (target.resolved.kind === "cycling_power") return `${Math.round(target.resolved.watts)} W`;
  if (target.sport === "swimming" && target.prescriptionKind === "pace_zone") {
    const range = target.resolved.rangePaceSecPer100m;
    if (range !== undefined) {
      return `${secondsPer100mToPaceString(range[0]).replace("/100m", "")}–${secondsPer100mToPaceString(range[1])}`;
    }
    const boundary = secondsPer100mToPaceString(target.resolved.paceSecPer100m);
    return target.zone === "z1_recovery" ? boundary.replace("/100m", "+/100m") : `≤${boundary}`;
  }
  return secondsPer100mToPaceString(target.resolved.paceSecPer100m);
}

function targetPrescription(target: Target | undefined): string {
  if (target === undefined) return "No target";
  if (target.sport === "running" && target.prescriptionKind === "threshold_speed_fraction") {
    return target.fraction === 1 ? "Threshold pace" : `${Math.round(target.fraction * 100)}% threshold speed`;
  }
  if (target.sport === "running" && target.prescriptionKind === "explicit_pace") {
    return target.resolved === undefined ? secondsPerKmToPaceString(target.paceSecPerKm) : runningPaceLabel(target.resolved);
  }
  if (target.sport === "running" && target.prescriptionKind === "pace_zone") {
    return `Friel ${target.zone.replace(/^z/, "Z").replaceAll("_", " ")}`;
  }
  if (target.sport === "cycling" && target.prescriptionKind === "ftp_fraction") return `${Math.round(target.fraction * 100)}% FTP`;
  if (target.sport === "cycling" && target.prescriptionKind === "power_zone") return `Coggan ${target.zone}`;
  if (target.sport === "cycling" && target.prescriptionKind === "explicit_watts") return `${Math.round(target.watts)} W`;
  if (target.sport === "swimming" && target.prescriptionKind === "threshold_offset") {
    if (target.offsetSecPer100m === 0) return "CSS";
    return `CSS ${target.offsetSecPer100m > 0 ? "+" : ""}${target.offsetSecPer100m} sec/100m`;
  }
  if (target.sport === "swimming" && target.prescriptionKind === "pace_zone") {
    const label = target.zone.replace(/^z/, "Z").replaceAll("_", " ");
    return `TrainingPeaks ${label}`;
  }
  if (target.sport === "swimming" && target.prescriptionKind === "explicit_pace") return secondsPer100mToPaceString(target.paceSecPer100m);
  return "Training target";
}

function durationLabel(step: WorkoutStep): string {
  if (step.type === "repeat") return `${step.repetitions} rounds`;
  if (step.duration.kind === "time") {
    const minutes = Math.floor(step.duration.seconds / 60);
    const seconds = step.duration.seconds % 60;
    return minutes === 0 ? `${seconds} sec` : seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} sec`;
  }
  if (step.duration.kind === "distance") return `${step.duration.metres >= 1000 ? `${step.duration.metres / 1000} km` : `${step.duration.metres} m`}`;
  return "Open";
}

function summaryTimeLabel(seconds: number, complete: boolean, estimated: boolean): string {
  if (!complete && seconds === 0) return "—";
  const roundedMinutes = Math.round(seconds / 60);
  const value = roundedMinutes < 1 ? `${Math.round(seconds)} sec` : roundedMinutes >= 60
    ? `${Math.floor(roundedMinutes / 60)} h ${String(roundedMinutes % 60).padStart(2, "0")} min`
    : `${roundedMinutes} min`;
  return `${complete ? estimated ? "≈" : "" : "≥"}${value}`;
}

function summaryDistanceLabel(metres: number, complete: boolean, estimated: boolean): string {
  if (!complete && metres === 0) return "—";
  const value = metres >= 1000 ? `${(metres / 1000).toFixed(metres % 1000 === 0 ? 0 : 1)} km` : `${Math.round(metres)} m`;
  return `${complete ? estimated ? "≈" : "" : "≥"}${value}`;
}

function sourceLabel(target: Target | undefined): string {
  if (target?.source === "explicit") return "EXPLICIT";
  if (target?.source === "profile_derived") return "PROFILE";
  return "OPEN";
}

function renderAddControls(parentId: string | null, compact = false): string {
  const selectedCount = selectedStepIds.size;
  const choices: Array<[StepKind, string]> = [
    ["warmup", "Warm-up"],
    ["work", "Work"],
    ["recovery", "Rest"],
    ["cooldown", "Cool-down"],
    ["repeat", selectedCount > 0 ? `Wrap ${selectedCount} in repeat` : "Repeat"],
  ];
  return `<div class="add-controls ${compact ? "compact" : ""}" aria-label="Add workout block">
    <span>${compact ? "Add inside" : "Add block"}</span>
    ${choices.map(([kind, label]) => `<button type="button" data-action="add" data-kind="${kind}" data-parent-id="${escapeHtml(parentId ?? "")}">+ ${label}</button>`).join("")}
  </div>`;
}

function renderMoveActions(step: WorkoutStep, parentId: string | null, index: number, siblingCount: number, previousIsRepeat: boolean): string {
  const selected = selectedStepIds.has(step.id);
  return `<div class="step-actions" aria-label="Move ${escapeHtml(stepTypeLabel(step.type))} block">
    <button class="select-action ${selected ? "active" : ""}" type="button" data-action="select" data-step-id="${escapeHtml(step.id)}" aria-pressed="${selected}" title="${selected ? "Deselect" : "Select"} block" aria-label="${selected ? "Deselect" : "Select"} block">${selected ? "✓" : "□"}</button>
    <span class="drag-handle" title="Drag block" aria-hidden="true">⠿</span>
    <button type="button" data-action="up" data-step-id="${escapeHtml(step.id)}" ${index === 0 ? "disabled" : ""} title="Move up" aria-label="Move block up">↑</button>
    <button type="button" data-action="down" data-step-id="${escapeHtml(step.id)}" ${index === siblingCount - 1 ? "disabled" : ""} title="Move down" aria-label="Move block down">↓</button>
    ${previousIsRepeat ? `<button type="button" data-action="nest" data-step-id="${escapeHtml(step.id)}" title="Move into previous repeat" aria-label="Move block into previous repeat">→</button>` : ""}
    ${parentId !== null ? `<button type="button" data-action="outdent" data-step-id="${escapeHtml(step.id)}" title="Move out of repeat" aria-label="Move block out of repeat">←</button>` : ""}
    <button class="danger-action" type="button" data-action="delete" data-step-id="${escapeHtml(step.id)}" title="Delete block" aria-label="Delete block">×</button>
  </div>`;
}

function renderNotesEditor(step: WorkoutStep): string {
  return `<input class="notes-input" data-edit="notes" data-step-id="${escapeHtml(step.id)}" value="${escapeHtml(step.notes ?? "")}" placeholder="Add note, e.g. pull or drill" aria-label="${escapeHtml(stepTypeLabel(step.type))} notes" />`;
}

function renderDurationEditor(step: Exclude<WorkoutStep, { type: "repeat" }>): string {
  const kind = step.duration.kind;
  const time = kind === "time" ? editableTimeDuration(step.duration.seconds) : undefined;
  const value = time?.value ?? (kind === "distance" ? step.duration.metres : undefined);
  const unit = time?.unit ?? (kind === "distance" ? "m" : "");
  return `<span class="duration-editor">
    <select class="duration-kind" data-edit="duration-kind" data-step-id="${escapeHtml(step.id)}" aria-label="${escapeHtml(stepTypeLabel(step.type))} duration type">
      <option value="time" ${kind === "time" ? "selected" : ""}>Time</option>
      <option value="distance" ${kind === "distance" ? "selected" : ""}>Distance</option>
      <option value="lap" ${kind === "lap" ? "selected" : ""}>Lap button</option>
      <option value="open" ${kind === "open" ? "selected" : ""}>Open</option>
    </select>
    ${value === undefined ? "" : `<input class="inline-number duration-input" data-edit="duration" data-unit="${unit}" data-step-id="${escapeHtml(step.id)}" type="number" min="1" step="1" value="${value}" aria-label="${escapeHtml(stepTypeLabel(step.type))} duration in ${unit === "min" ? "minutes" : unit === "sec" ? "seconds" : "metres"}" /><small>${unit}</small>`}
  </span>`;
}

function renderZoneEditor(step: Exclude<WorkoutStep, { type: "repeat" }>): string {
  if (step.type === "rest") return "";
  const currentZone = selectedZone(step.target);
  const choices = zoneChoices(workout.sport);
  return `<select class="zone-select" data-edit="zone" data-step-id="${escapeHtml(step.id)}" aria-label="${escapeHtml(stepTypeLabel(step.type))} intensity zone" title="Change zone; recalculates from athlete profile">
    <option value="" disabled ${currentZone === undefined ? "selected" : ""}>Choose zone</option>
    ${choices.map((choice) => `<option value="${choice.value}" ${currentZone === choice.value ? "selected" : ""}>${choice.label}</option>`).join("")}
  </select>`;
}

function renderStep(step: WorkoutStep, parentId: string | null, index: number, siblings: WorkoutStep[], depth = 0): string {
  const nested = depth > 0;
  const actions = renderMoveActions(step, parentId, index, siblings.length, siblings[index - 1]?.type === "repeat");
  if (step.type === "repeat") {
    return `<div class="step-card repeat-step ${nested ? "nested" : ""} ${selectedStepIds.has(step.id) ? "selected" : ""}" draggable="true" data-drag-id="${escapeHtml(step.id)}">
      <div class="repeat-heading"><span aria-hidden="true"></span><div><strong><input class="inline-number" data-edit="repetitions" data-step-id="${escapeHtml(step.id)}" type="number" min="1" step="1" value="${step.repetitions}" aria-label="Repeat count" /> repeats</strong><span>Repeat group · ${step.steps.length} blocks</span>${renderNotesEditor(step)}</div><span class="duration">${durationLabel(step)}</span>${actions}</div>
      <div class="repeat-children">${renderStepList(step.steps, step.id, depth + 1)}${renderAddControls(step.id, true)}</div>
    </div>`;
  }
  const target = step.target;
  const typeControl = step.type === "warmup" || step.type === "work" || step.type === "cooldown"
    ? `<select class="step-type" data-edit="step-type" data-step-id="${escapeHtml(step.id)}" aria-label="Block type" title="Reclassify block">
        <option value="warmup" ${step.type === "warmup" ? "selected" : ""}>Warm-up</option>
        <option value="work" ${step.type === "work" ? "selected" : ""}>Work</option>
        <option value="cooldown" ${step.type === "cooldown" ? "selected" : ""}>Cool-down</option>
      </select>`
    : `<strong>${escapeHtml(stepTypeLabel(step.type))}</strong>`;
  return `<div class="step-card step ${nested ? "nested" : ""} ${selectedStepIds.has(step.id) ? "selected" : ""}" draggable="true" data-drag-id="${escapeHtml(step.id)}">
    <span class="step-marker ${step.type}"></span>
    <div class="step-main">${typeControl}<span>${renderDurationEditor(step)}${target ? ` · ${targetPrescription(target)}` : ""}</span>${renderZoneEditor(step)}${renderNotesEditor(step)}</div>
    <div class="step-target">${target?.resolved === undefined ? `<strong>${targetLabel(target)}</strong>` : `<span class="target-value"><input class="target-input" data-edit="target" data-step-id="${escapeHtml(step.id)}" data-target-kind="${target.resolved.kind}" value="${targetEditValue(target)}" aria-label="${escapeHtml(stepTypeLabel(step.type))} target" /><small>${targetUnit(target)}</small></span>`}${target?.resolved?.kind === "running_pace" && target.prescriptionKind === "pace_zone" ? `<small>${escapeHtml(targetLabel(target))}</small>` : ""}<span class="source ${target?.source ?? "open"}">${sourceLabel(target)}</span></div>
    ${actions}
  </div>`;
}

function renderStepList(steps: WorkoutStep[], parentId: string | null, depth = 0): string {
  return steps.map((step, index) => `<div class="drop-zone" data-drop-parent="${escapeHtml(parentId ?? "")}" data-drop-index="${index}" aria-hidden="true"></div>${renderStep(step, parentId, index, steps, depth)}`).join("")
    + `<div class="drop-zone" data-drop-parent="${escapeHtml(parentId ?? "")}" data-drop-index="${steps.length}" aria-hidden="true"></div>`;
}

function baselineView(sport: Sport): { label: string; value: string; unit: string; current: string; inputMode: "numeric" | "decimal" } {
  if (sport === "running") {
    const value = profile.running.thresholdPaceSecPerKm?.value;
    return {
      label: "Running threshold pace",
      value: value === undefined ? "" : secondsPerKmToPaceString(value).replace("/km", ""),
      unit: "/ km",
      current: value === undefined ? "Needs input" : secondsPerKmToPaceString(value),
      inputMode: "numeric",
    };
  }
  if (sport === "cycling") {
    const value = profile.cycling.ftpWatts?.value;
    return {
      label: "Cycling FTP",
      value: value === undefined ? "" : String(Math.round(value)),
      unit: "watts",
      current: value === undefined ? "Needs input" : `${Math.round(value)} W`,
      inputMode: "decimal",
    };
  }
  const value = profile.swimming.thresholdPaceSecPer100m?.value;
  return {
    label: "Swimming CSS",
    value: value === undefined ? "" : secondsPer100mToPaceString(value).replace("/100m", ""),
    unit: "/ 100m",
    current: value === undefined ? "Needs input" : secondsPer100mToPaceString(value),
    inputMode: "numeric",
  };
}

function parsePace(raw: string): number | undefined {
  const match = /^(\d+):([0-5]\d)$/.exec(raw.trim());
  return match === null ? undefined : Number(match[1]) * 60 + Number(match[2]);
}

async function refreshGb10Status(): Promise<void> {
  if (gb10CheckBusy || gb10Busy) return;
  gb10CheckBusy = true;
  let state: typeof gb10Connection = "unknown";
  try {
    const response = await fetch(sharedMode ? "/api/shared/health" : "/api/local/gb10/status", {
      method: sharedMode ? "GET" : "POST",
      headers: sharedMode ? {} : { "X-LLM-Garmin-Control": "status" },
    });
    if (response.ok) {
      const result = await response.json() as { state?: string };
      if (result.state === "ready" || result.state === "loading" || result.state === "offline" || result.state === "unknown") state = result.state;
    }
  } catch {
    // Static hosting or an unavailable local control endpoint cannot establish GB10 status.
  } finally {
    gb10CheckBusy = false;
  }
  if (gb10Busy) return;
  if (state === "offline" && Date.now() < gb10StartupDeadline) state = "loading";
  if (state === "ready") gb10StartupDeadline = 0;
  const message = {
    checking: "Checking default GB10 connection…",
    ready: "Default GB10 server connected.",
    loading: "GB10 is starting or loading its model…",
    offline: "Default GB10 server is not connected.",
    unknown: "Could not verify GB10 status from this local app.",
  }[state];
  if (state !== gb10Connection || message !== gb10Status) {
    gb10Connection = state;
    gb10Status = message;
    render();
  }
}

function render(): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const baseline = baselineView(workout.sport);
  const summary = summarizeWorkout(workout.steps, workout.sport);
  root.innerHTML = `<div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Local Workout Builder home"><span class="brand-mark">LW</span><span>Local Workout Builder</span></a>
      <div class="topbar-right"><span class="phase-tag">PHASE 3 · REVIEW UI</span><span class="connection"><i></i> Configurable</span><button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch to ${theme === "dark" ? "light" : "dark"} mode" title="Switch theme">${theme === "dark" ? "☀" : "◐"}</button></div>
    </header>

    <main>
      <section class="intro">
        <div><p class="kicker">Workout studio / review desk</p><h1>Make the session<br /><em>worth showing up for.</em></h1></div>
        <p class="intro-copy">A quiet place to shape a workout, inspect every target, and make the numbers yours before you head out.</p>
      </section>

      <div class="workspace">
        <section class="panel composer-panel">
          <div class="panel-heading"><div><span class="panel-index">01</span><h2>Describe</h2></div><span class="panel-state">STRUCTURED EXAMPLE</span></div>
          <div class="sport-strip"><span>SPORT</span><button class="sport ${workout.sport === "running" ? "active" : ""}" data-sport="running" type="button">Run</button><button class="sport ${workout.sport === "cycling" ? "active" : ""}" data-sport="cycling" type="button">Ride</button><button class="sport ${workout.sport === "swimming" ? "active" : ""}" data-sport="swimming" type="button">Swim</button></div>
          <label class="field-label" for="prompt">Workout request</label>
          <textarea id="prompt" rows="5">${escapeHtml(promptText)}</textarea>
          <p class="field-hint">Recognized sectioned workouts are parsed locally; other requests use the model. Target math stays deterministic.</p>
          <div class="control-row"><label class="field-label" for="date-picker-toggle">Workout day</label><div class="date-picker"><button class="date-picker-toggle" id="date-picker-toggle" type="button" aria-haspopup="dialog" aria-expanded="${calendarOpen}"><span>${escapeHtml(displayDate(selectedDate))}</span><span class="calendar-icon" aria-hidden="true">□</span></button>${calendarOpen ? renderCalendar() : ""}</div></div>
          ${sharedMode ? `<div class="model-settings"><strong>GB10 workout interpretation</strong><p class="field-hint">Natural-language requests are processed on GB10. Your saved profile and workouts stay in this browser. Do not include passwords or account details in workout requests.</p><p class="gb10-status" role="status">${escapeHtml(gb10Status)}</p></div>` : `<div class="model-settings"><div class="backend-label"><span class="pulse"></span><strong>REMOTE INFERENCE BACKEND</strong></div><label class="field-label" for="model-url">GB10 / model endpoint</label><input id="model-url" value="${escapeHtml(modelUrl)}" placeholder="http://gb10-host:8080/v1" /><label class="field-label" for="model-name">Model name <span>(optional)</span></label><input id="model-name" placeholder="Leave blank for server default" value="${escapeHtml(modelName)}" /><label class="field-label" for="model-api-key">API key <span>(optional, session only)</span></label><input id="model-api-key" type="password" autocomplete="off" placeholder="Not saved to disk" value="${escapeHtml(modelApiKey)}" />${gb10Connection === "offline" && !gb10Busy ? `<button class="gb10-start" id="gb10-start" type="button">Start default GB10 server</button><p class="field-hint">Uses your local SSH key to start the existing GB10 user service and Tailscale Serve.</p>` : ""}<p class="gb10-status" role="status">${escapeHtml(gb10Status)}</p>${gb10Error.length > 0 ? `<p class="gb10-status" role="alert">${escapeHtml(gb10Error)}</p>` : ""}</div>`}
          <button class="primary-button" id="review-button" type="button" ${modelBusy ? "disabled" : ""}><span>${modelBusy ? "Interpreting…" : "Interpret workout"}</span><b>↗</b></button>
          ${modelError === undefined ? "" : `<div class="model-error" role="alert"><strong>Interpretation failed</strong><span>${escapeHtml(modelError)}</span><small>The existing Review workout was left unchanged.</small></div>`}
        </section>

        <section class="panel review-panel">
          <div class="panel-heading"><div><span class="panel-index">02</span><h2>Review</h2></div><span class="review-status">${escapeHtml(notice)}</span></div>
          <div class="workout-heading"><div><span class="sport-label">${escapeHtml(workout.sport.toUpperCase())} / REVIEW</span><input class="title-input" data-edit="workout-name" value="${escapeHtml(workout.name)}" aria-label="Workout title" /></div><div class="date-chip">${selectedDate}</div></div>
          <div class="workout-metrics" aria-label="Planned workout totals">
            <div class="workout-metric"><span>Time</span><strong>${summaryTimeLabel(summary.knownTimeSeconds, summary.timeComplete, summary.timeEstimated)}</strong><small>${summary.timeComplete ? summary.timeEstimated ? "at target pace" : "planned" : "known minimum"}</small></div>
            <div class="workout-metric"><span>Distance</span><strong>${summaryDistanceLabel(summary.knownDistanceMetres, summary.distanceComplete, summary.distanceEstimated)}</strong><small>${summary.distanceComplete ? summary.distanceEstimated ? "at target pace" : "planned" : "known minimum"}</small></div>
          </div>
          ${interpretationWarnings.length === 0 ? "" : `<div class="model-error" role="status"><strong>Check model interpretation before saving</strong><ul>${interpretationWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>`}
          <div class="summary-line"><span>Drag or use arrows to reorder</span><span class="summary-dot"></span><span>${selectedStepIds.size > 0 ? `${selectedStepIds.size} selected` : `${workout.steps.length} top-level blocks`}</span><span class="summary-dot"></span><span>${selectedStepIds.size > 0 ? "Add Repeat to wrap selection" : "Drop inside repeats to nest"}</span></div>
          <div class="steps">${renderStepList(workout.steps, null)}</div>
          ${renderAddControls(null)}
          <div class="legend"><span><i class="legend-dot profile-dot"></i>Profile-derived values update with your baseline</span><span><i class="legend-dot explicit-dot"></i>Explicit values stay fixed</span></div>
        </section>

        <aside class="profile-rail">
          <div class="rail-top"><span class="panel-index">03</span><span>ATHLETE PROFILE</span></div>
          <h2>Your baseline</h2>
          <p class="rail-copy">Derived targets use this value. Change it and the workout recalculates instantly.</p>
          <label class="field-label" for="baseline">${baseline.label}</label>
          <div class="unit-input"><input id="baseline" inputmode="${baseline.inputMode}" value="${escapeHtml(baseline.value)}" placeholder="${workout.sport === "cycling" ? "250" : "4:30"}" /><span>${baseline.unit}</span></div>
          <div class="baseline-note"><span class="pulse"></span><span>Current profile value<br /><strong>${baseline.current}</strong></span></div>
          <button class="save-button" id="save-button" type="button"><span>Save locally</span><b>↓</b></button>
          <button class="save-button" id="fit-export-button" type="button"><span>Download workout FIT</span><b>↓</b></button>
          <button class="save-button" id="garmin-json-export-button" type="button"><span>Download Garmin Connect JSON</span><b>↓</b></button>
          ${sharedMode ? `<p class="save-note">Shared mode: download your workout to use with your own Garmin account. Account connections are available in the local app.</p>` : `<button class="save-button" id="garmin-check-button" type="button" ${garminBusy ? "disabled" : ""}><span>Check Garmin connection</span></button>
          <button class="save-button" id="garmin-login-button" type="button" ${garminBusy ? "disabled" : ""}><span>${garminReady ? "Disconnect Garmin" : "Connect Garmin"}</span></button>
          <button class="save-button" id="garmin-send-button" type="button" ${garminBusy || !garminReady ? "disabled" : ""}><span>${garminBusy ? "Contacting Garmin…" : "Send to Garmin & schedule"}</span></button>
          <p class="save-note" role="status"><strong>Experimental Garmin integration</strong><br />${escapeHtml(garminStatus)}</p>`}
          <p class="save-note">Neither download schedules or syncs to Garmin. Import JSON with a compatible third-party Garmin Connect browser extension, then inspect the steps before scheduling. Saved workouts stay in this browser; SQLite remains available to the local Node engine.</p>
          ${jsonExportWarnings.length === 0 ? "" : `<div class="model-error" role="status"><strong>Check after JSON import</strong><ul>${jsonExportWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>`}
        </aside>
      </div>
    </main>
    <footer><span>LOCAL WORKOUT BUILDER <b>v0.1</b></span><span>Truth lives in the engine.</span></footer>
  </div>`;

  document.querySelector<HTMLButtonElement>("#date-picker-toggle")?.addEventListener("click", () => {
    calendarOpen = !calendarOpen;
    calendarMonth = selectedDate.slice(0, 7);
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-calendar-move]").forEach((button) => {
    button.addEventListener("click", () => {
      const [year = 1970, month = 1] = calendarMonth.split("-").map(Number);
      const next = new Date(Date.UTC(year, month - 1 + Number(button.dataset.calendarMove), 1));
      calendarMonth = `${next.getUTCFullYear().toString().padStart(4, "0")}-${(next.getUTCMonth() + 1).toString().padStart(2, "0")}`;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-calendar-date]").forEach((button) => {
    button.addEventListener("click", () => {
      const date = button.dataset.calendarDate;
      if (date === undefined) return;
      selectedDate = date;
      workout = { ...workout, scheduledDate: selectedDate, updatedAt: new Date().toISOString() };
      calendarOpen = false;
      notice = "Date updated";
      render();
    });
  });
  document.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("input", (event) => {
    promptText = (event.target as HTMLTextAreaElement).value;
    localStorage.setItem("local-workout-builder:last-prompt", promptText);
  });
  document.querySelector<HTMLInputElement>("#model-url")?.addEventListener("change", (event) => {
    modelUrl = (event.target as HTMLInputElement).value.trim();
  });
  document.querySelector<HTMLInputElement>("#model-name")?.addEventListener("change", (event) => {
    modelName = (event.target as HTMLInputElement).value.trim();
  });
  document.querySelector<HTMLInputElement>("#model-api-key")?.addEventListener("input", (event) => {
    modelApiKey = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLButtonElement>("#gb10-start")?.addEventListener("click", async () => {
    if (gb10Busy || gb10Connection !== "offline") return;
    gb10Busy = true;
    gb10Error = "";
    gb10Status = "Connecting to GB10…";
    render();
    try {
      const response = await fetch("/api/local/gb10/start", {
        method: "POST",
        headers: { "X-LLM-Garmin-Control": "start" },
      });
      const result = await response.json() as { ok?: boolean; message?: string };
      if (!response.ok || result.ok !== true) throw new Error(result.message ?? "GB10 startup failed.");
      modelUrl = defaultGb10Url;
      gb10StartupDeadline = Date.now() + 60_000;
      gb10Connection = "loading";
      gb10Status = result.message ?? "GB10 startup requested. The model may need time to load.";
    } catch (error) {
      gb10Error = error instanceof Error ? error.message : "GB10 startup failed.";
    } finally {
      gb10Busy = false;
      render();
      void refreshGb10Status();
    }
  });
  document.querySelector<HTMLButtonElement>("#theme-toggle")?.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem("local-workout-builder:theme", theme);
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("button[data-sport]").forEach((button) => {
    button.addEventListener("click", () => {
      const sport = button.dataset.sport as Sport | undefined;
      if (sport === undefined || sport === workout.sport) return;
      workout = recalculateWorkout({
        ...workout,
        sport,
        steps: retargetWorkoutStepsForSport(workout.steps, sport),
        updatedAt: new Date().toISOString(),
      }, profile);
      selectedStepIds = new Set();
      notice = `${sport === "cycling" ? "Ride" : sport === "swimming" ? "Swim" : "Run"} targets applied`;
      render();
    });
  });

  root.onclick = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
    if (button === null) return;
    const action = button.dataset.action;
    const stepId = button.dataset.stepId;

    if (action === "add") {
      const kind = button.dataset.kind as StepKind | undefined;
      if (kind === undefined) return;
      const parentId = button.dataset.parentId === "" ? null : button.dataset.parentId ?? null;
      const result = kind === "repeat" && selectedStepIds.size > 0
        ? wrapWorkoutSteps(workout.steps, [...selectedStepIds], nextStepId())
        : addWorkoutStep(
          workout.steps,
          parentId,
          createWorkoutStep(kind, workout.sport, nextStepId),
          preferredInsertionIndex(workout.steps, parentId, kind),
        );
      if (result.changed) {
        const wrapped = kind === "repeat" && selectedStepIds.size > 0;
        selectedStepIds = new Set();
        commitSteps(result.steps, wrapped ? "Selected blocks wrapped in repeat" : `${kind === "repeat" ? "Repeat group" : "Block"} added`);
      }
      else { notice = result.reason ?? "Block could not be added"; render(); }
      return;
    }

    if (stepId === undefined) return;
    if (action === "select") {
      if (selectedStepIds.has(stepId)) selectedStepIds.delete(stepId);
      else selectedStepIds.add(stepId);
      notice = selectedStepIds.size === 0 ? "Selection cleared" : `${selectedStepIds.size} block${selectedStepIds.size === 1 ? "" : "s"} selected`;
      render();
      return;
    }
    const context = findStepContext(workout.steps, stepId);
    if (context === undefined) return;
    let result;
    if (action === "up") {
      result = moveWorkoutStep(workout.steps, stepId, context.parentId, context.index - 1);
    } else if (action === "down") {
      result = moveWorkoutStep(workout.steps, stepId, context.parentId, context.index + 2);
    } else if (action === "nest") {
      const previous = context.siblings[context.index - 1];
      if (previous?.type !== "repeat") return;
      result = moveWorkoutStep(workout.steps, stepId, previous.id, previous.steps.length);
    } else if (action === "outdent") {
      if (context.parentId === null) return;
      const parent = findStepContext(workout.steps, context.parentId);
      if (parent === undefined) return;
      result = moveWorkoutStep(workout.steps, stepId, parent.parentId, parent.index + 1);
    } else if (action === "delete") {
      result = deleteWorkoutStep(workout.steps, stepId);
    } else {
      return;
    }

    if (result.changed) {
      if (action === "delete") selectedStepIds.delete(stepId);
      commitSteps(result.steps, action === "delete" ? "Block deleted" : "Block moved");
    }
    else { notice = result.reason ?? "Block could not be changed"; render(); }
  };

  document.querySelectorAll<HTMLElement>("[data-drag-id]").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      const origin = event.target as HTMLElement;
      if (origin.matches("input, button")) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      draggedStepId = card.dataset.dragId;
      card.classList.add("dragging");
      document.querySelector(".review-panel")?.classList.add("is-dragging");
      if (event.dataTransfer !== null && draggedStepId !== undefined) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedStepId);
      }
    });
    card.addEventListener("dragend", () => {
      draggedStepId = undefined;
      document.querySelector(".review-panel")?.classList.remove("is-dragging");
      document.querySelectorAll(".dragging, .drop-zone.active").forEach((element) => element.classList.remove("dragging", "active"));
    });
  });

  document.querySelectorAll<HTMLElement>(".drop-zone").forEach((zone) => {
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.stopPropagation();
      document.querySelectorAll(".drop-zone.active").forEach((element) => {
        if (element !== zone) element.classList.remove("active");
      });
      zone.classList.add("active");
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("active"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.remove("active");
      const stepId = draggedStepId ?? event.dataTransfer?.getData("text/plain");
      if (stepId === undefined || stepId.length === 0) return;
      const parentId = zone.dataset.dropParent === "" ? null : zone.dataset.dropParent ?? null;
      const index = Number(zone.dataset.dropIndex);
      const result = moveWorkoutStep(workout.steps, stepId, parentId, index);
      draggedStepId = undefined;
      document.querySelector(".review-panel")?.classList.remove("is-dragging");
      if (result.changed) commitSteps(result.steps, parentId === null ? "Block moved" : "Block nested in repeat");
      else { notice = result.reason ?? "Block could not be moved"; render(); }
    });
  });

  document.querySelector<HTMLButtonElement>("#review-button")?.addEventListener("click", () => {
    const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")?.value.trim() ?? "";
    if (prompt.length === 0) {
      notice = "Enter a workout request";
      render();
      return;
    }
    modelBusy = true;
    modelError = undefined;
    notice = "Interpreting workout";
    render();
    void parseWorkout({
      provider: new LlamaServerProvider({
        baseUrl: modelUrl,
        ...(modelName.length === 0 ? {} : { model: modelName }),
        ...(modelApiKey.length === 0 ? {} : { apiKey: modelApiKey }),
      }),
      profile,
      selectedSport: workout.sport,
      sourcePrompt: prompt,
      referenceDate: selectedDate,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).then((result) => {
      workout = result.workout;
      persistProfile(result.profile);
      selectedStepIds = new Set();
      selectedDate = result.workout.scheduledDate ?? selectedDate;
      modelBusy = false;
      modelError = undefined;
      interpretationWarnings = result.interpretationWarnings;
      notice = interpretationWarnings.length > 0 ? "Review interpretation" : result.warnings.length === 0 ? "Interpretation ready" : `${result.warnings.length} baseline needed`;
      render();
    }).catch((error: unknown) => {
      modelBusy = false;
      modelError = error instanceof Error ? error.message : "Model request failed";
      notice = "Interpretation failed";
      render();
    });
  });
  root.onchange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const edit = input.dataset.edit;
    const stepId = input.dataset.stepId;
    if (edit === "workout-name") {
      const name = input.value.trim();
      if (name.length === 0) {
        notice = "Workout title cannot be empty";
        render();
        return;
      }
      workout = { ...workout, name, updatedAt: new Date().toISOString() };
      notice = "Workout title updated";
      render();
      return;
    }
    if (edit === undefined || stepId === undefined) return;
    if (edit === "notes") {
      const notes = input.value.trim();
      workout = { ...workout, steps: updateSteps(workout.steps, stepId, (step) => {
        if (notes.length > 0) return { ...step, notes };
        const { notes: _notes, ...withoutNotes } = step;
        return withoutNotes;
      }), updatedAt: new Date().toISOString() };
      notice = notes.length > 0 ? "Block note saved" : "Block note cleared";
      render();
      return;
    }
    if (edit === "step-type") {
      if (input.value !== "warmup" && input.value !== "work" && input.value !== "cooldown") return;
      const result = reclassifyWorkoutStep(workout.steps, stepId, input.value);
      if (result.changed) {
        workout = { ...workout, steps: result.steps, updatedAt: new Date().toISOString() };
        notice = `Block changed to ${input.value === "warmup" ? "warm-up" : input.value === "cooldown" ? "cool-down" : "work"}`;
      } else if (result.reason !== undefined) {
        notice = result.reason;
      }
      render();
      return;
    }
    if (edit === "zone") {
      const previousStep = findStepContext(workout.steps, stepId)?.step;
      const result = setWorkoutStepZone(workout.steps, stepId, workout.sport, input.value);
      if (result.changed) {
        workout = recalculateWorkout({ ...workout, steps: result.steps, updatedAt: new Date().toISOString() }, profile);
        notice = previousStep?.notes !== undefined && /\bZ[1-6](?:[abc])?\b/i.test(previousStep.notes)
          ? "Zone updated; check notes for old zone wording"
          : "Zone updated from athlete profile";
      } else if (result.reason !== undefined) {
        notice = result.reason;
      }
      render();
      return;
    }
    if (edit === "duration-kind") {
      const durationKind = input.value;
      workout = { ...workout, steps: updateSteps(workout.steps, stepId, (step) => {
        if (step.type === "repeat") return step;
        if (durationKind === "time" || durationKind === "distance") {
          return { ...step, duration: defaultDurationForKind(durationKind, step.type, workout.sport) };
        }
        if (durationKind === "lap") return { ...step, duration: { kind: "lap" } };
        if (durationKind === "open") return { ...step, duration: { kind: "open" } };
        return step;
      }), updatedAt: new Date().toISOString() };
      notice = durationKind === "distance" ? "Distance-based block" : durationKind === "time" ? "Time-based block" : "Duration type updated";
      render();
      return;
    }
    const targetKind = input.dataset.targetKind;
    if (edit === "target" && targetKind === "running_pace") {
      const pace = parseRunningPaceText(input.value);
      if (pace !== undefined) {
        const target = pace.rangePaceSecPerKm === undefined ? explicitRunningPace(pace.paceSecPerKm) : explicitRunningPaceRange(...pace.rangePaceSecPerKm);
        workout = { ...workout, steps: updateSteps(workout.steps, stepId, (step) => step.type === "repeat" ? step : { ...step, target }), updatedAt: new Date().toISOString() };
        notice = "Manual target saved";
        render();
        return;
      }
    }
    const paceValue = edit === "target" && (targetKind === "running_pace" || targetKind === "swimming_pace")
      ? parsePace(input.value)
      : undefined;
    const numericValue = paceValue ?? Number(input.value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      notice = targetKind === "running_pace"
        ? "Use M:SS or M:SS-M:SS per km (faster pace first)"
        : targetKind === "swimming_pace"
          ? "Use M:SS per 100m"
          : "Enter a positive number";
      render();
      return;
    }
    if (edit === "repetitions") {
      workout = { ...workout, steps: updateSteps(workout.steps, stepId, (step) => step.type === "repeat" ? { ...step, repetitions: Math.round(numericValue) } : step), updatedAt: new Date().toISOString() };
    } else if (edit === "duration") {
      workout = { ...workout, steps: updateSteps(workout.steps, stepId, (step) => {
        if (step.type === "repeat") return step;
        if (step.duration.kind === "time") return { ...step, duration: { kind: "time", seconds: input.dataset.unit === "min" ? numericValue * 60 : numericValue } };
        if (step.duration.kind === "distance") return { ...step, duration: { kind: "distance", metres: numericValue } };
        return step;
      }), updatedAt: new Date().toISOString() };
    } else if (edit === "target") {
      workout = { ...workout, steps: updateSteps(workout.steps, stepId, (step) => step.type === "repeat" || step.target === undefined ? step : { ...step, target: editTarget(step.target, numericValue) }), updatedAt: new Date().toISOString() };
      notice = "Manual target saved";
    }
    render();
  };
  document.querySelector<HTMLInputElement>("#baseline")?.addEventListener("change", (event) => {
    const raw = (event.target as HTMLInputElement).value.trim();
    const updatedAt = new Date().toISOString();
    if (workout.sport === "cycling") {
      const watts = Number(raw);
      if (!Number.isFinite(watts) || watts <= 0) {
        notice = "Enter a positive FTP in watts";
        render();
        return;
      }
      persistProfile(updateCyclingFTP(profile, watts, { source: "manual", updatedAt }));
    } else {
      const seconds = parsePace(raw);
      if (seconds === undefined) {
        notice = workout.sport === "running" ? "Use M:SS per km" : "Use M:SS per 100m";
        render();
        return;
      }
      persistProfile(workout.sport === "running"
        ? updateRunningThreshold(profile, seconds, { source: "manual", updatedAt })
        : updateSwimmingThreshold(profile, seconds, { source: "manual", updatedAt }));
    }
    workout = recalculateWorkout(workout, profile);
    notice = "Targets recalculated";
    render();
  });
  document.querySelector<HTMLButtonElement>("#save-button")?.addEventListener("click", () => {
    localStorage.setItem("local-workout-builder:last-review", JSON.stringify({ workout, profile }));
    notice = "Saved in browser";
    render();
  });
  document.querySelector<HTMLButtonElement>("#fit-export-button")?.addEventListener("click", async () => {
    try {
      const { exportFitWorkout } = await import("../fit/export.js");
      const exported = exportFitWorkout(workout);
      const bytes = new Uint8Array(exported.bytes);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selectedDate}-${workout.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workout"}.fit`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      notice = exported.warnings.length === 0 ? "FIT workout downloaded" : `FIT downloaded; ${exported.warnings.length} pace cue(s) are notes only`;
    } catch (error) {
      notice = `FIT export failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    render();
  });
  document.querySelector<HTMLButtonElement>("#garmin-json-export-button")?.addEventListener("click", async () => {
    try {
      const { exportGarminConnectJson } = await import("../garminConnectJson/export.js");
      const exported = exportGarminConnectJson(workout, profile);
      jsonExportWarnings = exported.warnings;
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported.workout, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selectedDate}-${workout.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workout"}-garmin-connect.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      notice = exported.warnings.length === 0 ? "Garmin Connect JSON downloaded; review after import" : `Garmin Connect JSON downloaded; ${exported.warnings.length} compatibility warning(s) to review`;
    } catch (error) {
      jsonExportWarnings = [];
      notice = `Garmin Connect JSON export failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    render();
  });
  document.querySelector<HTMLButtonElement>("#garmin-login-button")?.addEventListener("click", async () => {
    if (garminBusy) return;
    if (!garminReady) {
      showGarminLogin((result) => { garminReady = result.ok; garminStatus = garminResultMessage(result); render(); });
      return;
    }
    if (!window.confirm("Remove the local Garmin session? Existing workouts and scheduling receipts will be kept.")) return;
    garminBusy = true; render();
    try {
      const result = await requestGarmin("logout");
      if (result.ok) garminReady = false;
      garminStatus = garminResultMessage(result);
    } finally { garminBusy = false; render(); }
  });
  document.querySelector<HTMLButtonElement>("#garmin-check-button")?.addEventListener("click", async () => {
    if (garminBusy) return;
    garminBusy = true;
    garminStatus = "Checking local Garmin session…";
    render();
    try {
      const result = await requestGarmin("status");
      garminReady = result.ok && result.code === "READY";
      garminStatus = garminResultMessage(result);
    } finally { garminBusy = false; render(); }
  });
  document.querySelector<HTMLButtonElement>("#garmin-send-button")?.addEventListener("click", async () => {
    if (garminBusy || !garminReady) return;
    // Freeze exactly the reviewed data confirmed by the user, even if edits follow.
    const confirmedWorkout = structuredClone(workout);
    const confirmedProfile = structuredClone(profile);
    const confirmedDate = selectedDate;
    try {
      if (!window.confirm(garminConfirmation(confirmedWorkout, confirmedProfile, confirmedDate))) return;
      garminBusy = true;
      garminStatus = "Uploading, checking workout, and verifying calendar…";
      render();
      const operationId = await garminOperationId(confirmedWorkout, confirmedProfile, confirmedDate);
      const result = await requestGarmin("send", { workout: confirmedWorkout, profile: confirmedProfile, date: confirmedDate, operationId });
      garminStatus = `${garminResultMessage(result)} (${confirmedWorkout.name}, ${confirmedDate})`;
      if (["AUTH_REQUIRED", "SETUP_REQUIRED", "UNAVAILABLE"].includes(result.code)) garminReady = false;
    } catch {
      garminStatus = "Could not prepare the Garmin request. Check resolved targets and browser storage; local downloads remain available.";
    } finally { garminBusy = false; render(); }
  });
}

render();
if (!sharedMode) void requestGarmin("status").then((result) => {
  garminReady = result.ok && result.code === "READY";
  garminStatus = garminResultMessage(result);
  render();
});
void refreshGb10Status();
setInterval(() => { void refreshGb10Status(); }, 10_000);
