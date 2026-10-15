import type { Duration, ExecutableStep, Sport, Target, WorkoutStep } from "../domain/index.js";
import { cyclingZoneTarget, runningZoneTarget, swimmingZoneTarget } from "../engine/index.js";

export type StepKind = ExecutableStep["type"] | "repeat";

export function stepTypeLabel(type: WorkoutStep["type"]): string {
  if (type === "recovery") return "Rest";
  if (type === "rest") return "Rest";
  return type;
}

export function editableTimeDuration(seconds: number): { value: number; unit: "min" | "sec" } {
  return seconds >= 60 && seconds % 60 === 0
    ? { value: seconds / 60, unit: "min" }
    : { value: seconds, unit: "sec" };
}

export type DistanceUnit = "m" | "km";

export function editableDistanceDuration(
  metres: number,
  sport: Sport,
  unit: DistanceUnit = sport === "swimming" ? "m" : "km",
): { value: number; unit: DistanceUnit } {
  return { value: unit === "km" ? metres / 1000 : metres, unit };
}

export function parseDistanceMetres(text: string, unit: DistanceUnit): number | undefined {
  const metres = Number(text) * (unit === "km" ? 1000 : 1);
  return Number.isFinite(metres) && metres > 0 ? metres : undefined;
}

export type StepContext = {
  parentId: string | null;
  index: number;
  siblings: WorkoutStep[];
  step: WorkoutStep;
};

export type StepMoveResult = {
  changed: boolean;
  steps: WorkoutStep[];
  reason?: string;
};

function defaultTargetForStep(kind: ExecutableStep["type"], sport: Sport): Target | undefined {
  if (kind === "rest") return undefined;
  if (sport === "running") {
    return kind === "work"
      ? { sport: "running", prescriptionKind: "threshold_speed_fraction", source: "profile_derived", fraction: 1 }
      : { sport: "running", prescriptionKind: "pace_zone", source: "profile_derived", zoneSystem: "friel_trainingpeaks", zone: "z1_recovery" };
  }
  if (sport === "cycling") {
    return kind === "work"
      ? { sport: "cycling", prescriptionKind: "ftp_fraction", source: "profile_derived", fraction: 1 }
      : { sport: "cycling", prescriptionKind: "power_zone", source: "profile_derived", zoneSystem: "coggan", zone: "recovery" };
  }
  return kind === "work"
    ? { sport: "swimming", prescriptionKind: "threshold_offset", source: "profile_derived", offsetSecPer100m: 0 }
    : undefined;
}

export function defaultDurationForKind(
  kind: "time" | "distance",
  stepType: ExecutableStep["type"],
  sport: Sport,
): Duration {
  if (kind === "time") {
    return { kind: "time", seconds: stepType === "warmup" || stepType === "cooldown" ? 600 : stepType === "work" && sport === "cycling" ? 600 : 60 };
  }
  return { kind: "distance", metres: sport === "swimming" ? 100 : 1000 };
}

export function retargetWorkoutStepsForSport(steps: WorkoutStep[], sport: Sport): WorkoutStep[] {
  return steps.map((step) => {
    if (step.type === "repeat") return { ...step, steps: retargetWorkoutStepsForSport(step.steps, sport) };
    const target = defaultTargetForStep(step.type, sport);
    if (target === undefined) {
      const { target: _target, ...withoutTarget } = step;
      return withoutTarget;
    }
    return { ...step, target };
  });
}

function containsStep(step: WorkoutStep, stepId: string): boolean {
  return step.id === stepId || (step.type === "repeat" && step.steps.some((child) => containsStep(child, stepId)));
}

export function findStepContext(
  steps: WorkoutStep[],
  stepId: string,
  parentId: string | null = null,
): StepContext | undefined {
  for (const [index, step] of steps.entries()) {
    if (step.id === stepId) return { parentId, index, siblings: steps, step };
    if (step.type === "repeat") {
      const nested = findStepContext(step.steps, stepId, step.id);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function reclassifyWorkoutStep(
  steps: WorkoutStep[],
  stepId: string,
  type: "warmup" | "work" | "cooldown",
): StepMoveResult {
  const context = findStepContext(steps, stepId);
  if (context === undefined || !["warmup", "work", "cooldown"].includes(context.step.type)) {
    return { changed: false, steps, reason: "Only warm-up, work, and cool-down blocks can be reclassified." };
  }
  if (context.step.type === type) return { changed: false, steps };
  const replace = (group: WorkoutStep[]): WorkoutStep[] => group.map((step) => {
    if (step.id === stepId && step.type !== "repeat") return { ...step, type };
    return step.type === "repeat" ? { ...step, steps: replace(step.steps) } : step;
  });
  return { changed: true, steps: replace(steps) };
}

const zoneChoicesBySport = {
  running: [
    { value: "z1_recovery", label: "Z1 Recovery" },
    { value: "z2_aerobic", label: "Z2 Aerobic" },
    { value: "z3_tempo", label: "Z3 Tempo" },
    { value: "z4_threshold", label: "Z4 Threshold" },
    { value: "z5_aggregate", label: "Z5 Aggregate" },
    { value: "z5a_super_threshold", label: "Z5a Super-threshold" },
    { value: "z5b_aerobic_capacity", label: "Z5b Aerobic capacity" },
    { value: "z5c_anaerobic_capacity", label: "Z5c Anaerobic capacity" },
  ],
  cycling: [
    { value: "recovery", label: "Z1 Recovery" },
    { value: "endurance", label: "Z2 Endurance" },
    { value: "tempo", label: "Z3 Tempo" },
    { value: "threshold", label: "Z4 Threshold" },
    { value: "vo2max", label: "Z5 VO2 max" },
    { value: "anaerobic", label: "Z6 Anaerobic" },
  ],
  swimming: [
    { value: "z1_recovery", label: "Z1 Recovery" },
    { value: "z2_aerobic", label: "Z2 Aerobic" },
    { value: "z3_tempo", label: "Z3 Tempo" },
    { value: "z4_threshold", label: "Z4 Threshold" },
    { value: "z5_aggregate", label: "Z5 Aggregate" },
    { value: "z5a_super_threshold", label: "Z5a Super-threshold" },
    { value: "z5b_anaerobic_endurance", label: "Z5b Anaerobic" },
    { value: "z5c_power", label: "Z5c Power" },
  ],
} as const;

export function zoneChoices(sport: Sport): readonly { value: string; label: string }[] {
  return zoneChoicesBySport[sport];
}

export function selectedZone(target: Target | undefined): string | undefined {
  return target?.prescriptionKind === "pace_zone" || target?.prescriptionKind === "power_zone" ? target.zone : undefined;
}

export function setWorkoutStepZone(steps: WorkoutStep[], stepId: string, sport: Sport, zone: string): StepMoveResult {
  const context = findStepContext(steps, stepId);
  if (context === undefined || context.step.type === "repeat" || context.step.type === "rest") {
    return { changed: false, steps, reason: "Choose an active workout block to set its zone." };
  }
  if (!zoneChoicesBySport[sport].some((choice) => choice.value === zone)) {
    return { changed: false, steps, reason: "Choose a valid zone for this sport." };
  }
  if (selectedZone(context.step.target) === zone && context.step.target?.sport === sport) return { changed: false, steps };
  const target = sport === "running"
    ? runningZoneTarget(zone as Parameters<typeof runningZoneTarget>[0])
    : sport === "cycling"
      ? cyclingZoneTarget(zone as Parameters<typeof cyclingZoneTarget>[0])
      : swimmingZoneTarget(zone as Parameters<typeof swimmingZoneTarget>[0]);
  const replace = (group: WorkoutStep[]): WorkoutStep[] => group.map((step) => {
    if (step.id === stepId && step.type !== "repeat") return { ...step, target };
    return step.type === "repeat" ? { ...step, steps: replace(step.steps) } : step;
  });
  return { changed: true, steps: replace(steps) };
}

function removeStep(steps: WorkoutStep[], stepId: string): { steps: WorkoutStep[]; removed?: WorkoutStep } {
  const directIndex = steps.findIndex((step) => step.id === stepId);
  if (directIndex >= 0) {
    return {
      steps: steps.filter((_, index) => index !== directIndex),
      removed: steps[directIndex]!,
    };
  }

  for (const step of steps) {
    if (step.type !== "repeat") continue;
    const result = removeStep(step.steps, stepId);
    if (result.removed !== undefined) {
      return {
        steps: steps.map((candidate) => candidate.id === step.id ? { ...step, steps: result.steps } : candidate),
        removed: result.removed,
      };
    }
  }
  return { steps };
}

function insertStep(
  steps: WorkoutStep[],
  parentId: string | null,
  index: number,
  stepToInsert: WorkoutStep,
): WorkoutStep[] | undefined {
  if (parentId === null) {
    const insertionIndex = Math.max(0, Math.min(index, steps.length));
    return [...steps.slice(0, insertionIndex), stepToInsert, ...steps.slice(insertionIndex)];
  }

  for (const step of steps) {
    if (step.id === parentId) {
      if (step.type !== "repeat") return undefined;
      const insertionIndex = Math.max(0, Math.min(index, step.steps.length));
      const children = [...step.steps.slice(0, insertionIndex), stepToInsert, ...step.steps.slice(insertionIndex)];
      return steps.map((candidate) => candidate.id === parentId ? { ...step, steps: children } : candidate);
    }
    if (step.type === "repeat") {
      const nested = insertStep(step.steps, parentId, index, stepToInsert);
      if (nested !== undefined) {
        return steps.map((candidate) => candidate.id === step.id ? { ...step, steps: nested } : candidate);
      }
    }
  }
  return undefined;
}

function replaceContainerSteps(
  steps: WorkoutStep[],
  parentId: string | null,
  replacement: WorkoutStep[],
): WorkoutStep[] | undefined {
  if (parentId === null) return replacement;
  for (const step of steps) {
    if (step.id === parentId) {
      if (step.type !== "repeat") return undefined;
      return steps.map((candidate) => candidate.id === parentId ? { ...step, steps: replacement } : candidate);
    }
    if (step.type === "repeat") {
      const nested = replaceContainerSteps(step.steps, parentId, replacement);
      if (nested !== undefined) {
        return steps.map((candidate) => candidate.id === step.id ? { ...step, steps: nested } : candidate);
      }
    }
  }
  return undefined;
}

function containerSteps(steps: WorkoutStep[], parentId: string | null): WorkoutStep[] | undefined {
  if (parentId === null) return steps;
  const parent = findStepContext(steps, parentId)?.step;
  return parent?.type === "repeat" ? parent.steps : undefined;
}

export function preferredInsertionIndex(
  steps: WorkoutStep[],
  parentId: string | null,
  kind: StepKind,
): number {
  const siblings = containerSteps(steps, parentId) ?? [];
  if (kind === "warmup") return 0;
  if (kind === "cooldown" || kind === "repeat") return siblings.length;
  const cooldownIndex = siblings.findIndex((step) => step.type === "cooldown");
  return cooldownIndex < 0 ? siblings.length : cooldownIndex;
}

export function moveWorkoutStep(
  steps: WorkoutStep[],
  stepId: string,
  targetParentId: string | null,
  targetIndex: number,
): StepMoveResult {
  const source = findStepContext(steps, stepId);
  if (source === undefined) return { changed: false, steps, reason: "Block was not found." };

  if (targetParentId !== null) {
    const target = findStepContext(steps, targetParentId);
    if (target === undefined || target.step.type !== "repeat") {
      return { changed: false, steps, reason: "Blocks can only be nested inside a repeat group." };
    }
    if (containsStep(source.step, targetParentId)) {
      return { changed: false, steps, reason: "A repeat cannot be moved inside itself." };
    }
  }

  if (source.parentId !== targetParentId && source.parentId !== null && source.siblings.length === 1) {
    return { changed: false, steps, reason: "A repeat group must keep at least one block." };
  }

  const adjustedIndex = source.parentId === targetParentId && source.index < targetIndex
    ? targetIndex - 1
    : targetIndex;
  const removal = removeStep(steps, stepId);
  if (removal.removed === undefined) return { changed: false, steps, reason: "Block was not found." };
  const inserted = insertStep(removal.steps, targetParentId, adjustedIndex, removal.removed);
  if (inserted === undefined) return { changed: false, steps, reason: "Drop location is no longer available." };

  return { changed: true, steps: inserted };
}

export function addWorkoutStep(
  steps: WorkoutStep[],
  parentId: string | null,
  step: WorkoutStep,
  targetIndex?: number,
): StepMoveResult {
  if (findStepContext(steps, step.id) !== undefined) {
    return { changed: false, steps, reason: "Block IDs must be unique." };
  }
  const parent = parentId === null ? undefined : findStepContext(steps, parentId);
  const targetLength = targetIndex ?? (parentId === null
    ? steps.length
    : parent?.step.type === "repeat"
      ? parent.step.steps.length
      : 0);
  const inserted = insertStep(steps, parentId, targetLength, step);
  return inserted === undefined
    ? { changed: false, steps, reason: "Repeat group was not found." }
    : { changed: true, steps: inserted };
}

export function wrapWorkoutSteps(
  steps: WorkoutStep[],
  selectedStepIds: readonly string[],
  repeatId: string,
): StepMoveResult {
  const uniqueIds = [...new Set(selectedStepIds)];
  if (uniqueIds.length === 0) return { changed: false, steps, reason: "Select one or more blocks to wrap." };
  if (findStepContext(steps, repeatId) !== undefined) return { changed: false, steps, reason: "Block IDs must be unique." };

  const contexts = uniqueIds.map((stepId) => findStepContext(steps, stepId));
  if (contexts.some((context) => context === undefined)) {
    return { changed: false, steps, reason: "A selected block was not found." };
  }
  const selected = contexts as StepContext[];
  const parentId = selected[0]!.parentId;
  if (selected.some((context) => context.parentId !== parentId)) {
    return { changed: false, steps, reason: "Selected blocks must be at the same level." };
  }

  const ordered = [...selected].sort((left, right) => left.index - right.index);
  if (ordered.some((context, index) => index > 0 && context.index !== ordered[index - 1]!.index + 1)) {
    return { changed: false, steps, reason: "Select adjacent blocks to create a repeat." };
  }

  const siblings = ordered[0]!.siblings;
  const selectedIds = new Set(uniqueIds);
  const repeat: WorkoutStep = {
    id: repeatId,
    type: "repeat",
    repetitions: 2,
    steps: ordered.map((context) => context.step),
  };
  const firstIndex = ordered[0]!.index;
  const remaining = siblings.filter((step) => !selectedIds.has(step.id));
  const replacement = [...remaining.slice(0, firstIndex), repeat, ...remaining.slice(firstIndex)];
  const wrapped = replaceContainerSteps(steps, parentId, replacement);
  return wrapped === undefined
    ? { changed: false, steps, reason: "Selected blocks could not be wrapped." }
    : { changed: true, steps: wrapped };
}

export function deleteWorkoutStep(steps: WorkoutStep[], stepId: string): StepMoveResult {
  const context = findStepContext(steps, stepId);
  if (context === undefined) return { changed: false, steps, reason: "Block was not found." };
  if (context.siblings.length === 1) {
    return { changed: false, steps, reason: context.parentId === null
      ? "A workout must keep at least one block."
      : "A repeat group must keep at least one block." };
  }
  return { changed: true, steps: removeStep(steps, stepId).steps };
}

export function createWorkoutStep(
  kind: StepKind,
  sport: Sport,
  createId: () => string,
): WorkoutStep {
  if (kind === "repeat") {
    return {
      id: createId(),
      type: "repeat",
      repetitions: 2,
      steps: [
        createWorkoutStep("work", sport, createId),
        createWorkoutStep("recovery", sport, createId),
      ],
    };
  }

  const duration = kind === "work"
    ? defaultDurationForKind(sport === "cycling" ? "time" : "distance", kind, sport)
    : defaultDurationForKind("time", kind, sport);

  const target = defaultTargetForStep(kind, sport);

  return target === undefined
    ? { id: createId(), type: kind, duration }
    : { id: createId(), type: kind, duration, target };
}
