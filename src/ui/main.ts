import "./styles.css";
import {
  demoProfile,
  demoRunningThresholdWorkout,
} from "../fixtures.js";
import {
  explicitRunningPace,
  recalculateWorkout,
  secondsPerKmToPaceString,
  updateRunningThreshold,
} from "../engine/index.js";
import type {
  AthleteProfile,
  Target,
  Workout,
  WorkoutStep,
} from "../domain/index.js";

const app = document.querySelector<HTMLDivElement>("#app");
if (app === null) throw new Error("UI mount point was not found.");
const root = app;

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

let profile: AthleteProfile = demoProfile;
let workout: Workout = recalculateWorkout(initialWorkout, profile);
let selectedDate = new Date().toISOString().slice(0, 10);
let notice = "Ready for review";

function targetLabel(target: Target | undefined): string {
  if (target === undefined || target.resolved === undefined) return "Needs profile input";
  if (target.resolved.kind === "running_pace") return secondsPerKmToPaceString(target.resolved.paceSecPerKm);
  return "Resolved target";
}

function targetPrescription(target: Target | undefined): string {
  if (target === undefined) return "No target";
  if (target.sport === "running" && target.prescriptionKind === "threshold_speed_fraction") {
    return target.fraction === 1 ? "Threshold pace" : `${Math.round(target.fraction * 100)}% threshold speed`;
  }
  if (target.sport === "running" && target.prescriptionKind === "explicit_pace") {
    return secondsPerKmToPaceString(target.paceSecPerKm);
  }
  return "Training target";
}

function durationLabel(step: WorkoutStep): string {
  if (step.type === "repeat") return `${step.repetitions} rounds`;
  if (step.duration.kind === "time") return `${Math.round(step.duration.seconds / 60)} min`;
  if (step.duration.kind === "distance") return `${step.duration.metres >= 1000 ? `${step.duration.metres / 1000} km` : `${step.duration.metres} m`}`;
  return "Open";
}

function sourceLabel(target: Target | undefined): string {
  if (target?.source === "explicit") return "EXPLICIT";
  if (target?.source === "profile_derived") return "PROFILE";
  return "OPEN";
}

function renderStep(step: WorkoutStep, nested = false): string {
  if (step.type === "repeat") {
    return `<div class="step repeat-step ${nested ? "nested" : ""}">
      <div class="repeat-heading"><span class="step-marker">×</span><div><strong>${step.repetitions} repeats</strong><span>Repeat group</span></div><span class="duration">${durationLabel(step)}</span></div>
      <div class="repeat-children">${step.steps.map((child) => renderStep(child, true)).join("")}</div>
    </div>`;
  }
  const target = step.target;
  return `<div class="step ${nested ? "nested" : ""}">
    <span class="step-marker ${step.type}"></span>
    <div class="step-main"><strong>${step.type}</strong><span>${durationLabel(step)}${target ? ` · ${targetPrescription(target)}` : ""}</span></div>
    <div class="step-target"><strong>${targetLabel(target)}</strong><span class="source ${target?.source ?? "open"}">${sourceLabel(target)}</span></div>
  </div>`;
}

function render(): void {
  const threshold = profile.running.thresholdPaceSecPerKm?.value ?? 0;
  root.innerHTML = `<div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Local Workout Builder home"><span class="brand-mark">LW</span><span>Local Workout Builder</span></a>
      <div class="topbar-right"><span class="phase-tag">PHASE 1 · DETERMINISTIC</span><span class="connection"><i></i> Local only</span></div>
    </header>

    <main>
      <section class="intro">
        <div><p class="kicker">Workout studio / review desk</p><h1>Make the session<br /><em>worth showing up for.</em></h1></div>
        <p class="intro-copy">A quiet place to shape a workout, inspect every target, and make the numbers yours before you head out.</p>
      </section>

      <div class="workspace">
        <section class="panel composer-panel">
          <div class="panel-heading"><div><span class="panel-index">01</span><h2>Describe</h2></div><span class="panel-state">STRUCTURED EXAMPLE</span></div>
          <label class="field-label" for="prompt">Workout request</label>
          <textarea id="prompt" rows="5">Tomorrow do 5 x 1 km at threshold with 90 sec easy recovery, 10 min warm-up and cooldown.</textarea>
          <p class="field-hint">The review below is powered by the deterministic Phase 1 fixture. Natural-language parsing arrives in the next phase.</p>
          <div class="control-row"><label class="field-label" for="date">Workout day</label><input id="date" type="date" value="${selectedDate}" /></div>
          <button class="primary-button" id="review-button" type="button"><span>Review workout</span><b>↗</b></button>
          <div class="sport-strip"><span>SPORT</span><button class="sport active" type="button">Run</button><button class="sport muted" type="button" disabled>Ride</button><button class="sport muted" type="button" disabled>Swim</button></div>
        </section>

        <section class="panel review-panel">
          <div class="panel-heading"><div><span class="panel-index">02</span><h2>Review</h2></div><span class="review-status">${notice}</span></div>
          <div class="workout-heading"><div><span class="sport-label">RUNNING / THRESHOLD</span><h3>${workout.name}</h3></div><div class="date-chip">${selectedDate}</div></div>
          <div class="summary-line"><span>Nested interval session</span><span class="summary-dot"></span><span>${workout.steps.length} blocks</span><span class="summary-dot"></span><span>Targets visible</span></div>
          <div class="steps">${workout.steps.map((step) => renderStep(step)).join("")}</div>
          <div class="legend"><span><i class="legend-dot profile-dot"></i>Profile-derived values update with your baseline</span><span><i class="legend-dot explicit-dot"></i>Explicit values stay fixed</span></div>
        </section>

        <aside class="profile-rail">
          <div class="rail-top"><span class="panel-index">03</span><span>ATHLETE PROFILE</span></div>
          <h2>Your baseline</h2>
          <p class="rail-copy">Derived targets use this value. Change it and the workout recalculates instantly.</p>
          <label class="field-label" for="threshold">Running threshold pace</label>
          <div class="unit-input"><input id="threshold" inputmode="numeric" value="${secondsPerKmToPaceString(threshold).replace("/km", "")}" /><span>/ km</span></div>
          <div class="baseline-note"><span class="pulse"></span><span>Current profile value<br /><strong>${secondsPerKmToPaceString(threshold)}</strong></span></div>
          <button class="save-button" id="save-button" type="button"><span>Save locally</span><b>↓</b></button>
          <p class="save-note">Saved in this browser for now. SQLite remains available to the local Node engine.</p>
        </aside>
      </div>
    </main>
    <footer><span>LOCAL WORKOUT BUILDER <b>v0.1</b></span><span>Truth lives in the engine.</span></footer>
  </div>`;

  document.querySelector<HTMLInputElement>("#date")?.addEventListener("change", (event) => {
    selectedDate = (event.target as HTMLInputElement).value;
    workout = { ...workout, scheduledDate: selectedDate, updatedAt: new Date().toISOString() };
    notice = "Date updated";
    render();
  });
  document.querySelector<HTMLButtonElement>("#review-button")?.addEventListener("click", () => {
    workout = recalculateWorkout(workout, profile);
    notice = "Review refreshed";
    render();
  });
  document.querySelector<HTMLInputElement>("#threshold")?.addEventListener("change", (event) => {
    const raw = (event.target as HTMLInputElement).value.trim();
    const match = /^(\d+):([0-5]\d)$/.exec(raw);
    if (match === null) {
      notice = "Use M:SS format";
      render();
      return;
    }
    const seconds = Number(match[1]) * 60 + Number(match[2]);
    profile = updateRunningThreshold(profile, seconds, { source: "manual", updatedAt: new Date().toISOString() });
    workout = recalculateWorkout(workout, profile);
    notice = "Targets recalculated";
    render();
  });
  document.querySelector<HTMLButtonElement>("#save-button")?.addEventListener("click", () => {
    localStorage.setItem("local-workout-builder:last-review", JSON.stringify({ workout, profile }));
    notice = "Saved in browser";
    render();
  });
}

render();
