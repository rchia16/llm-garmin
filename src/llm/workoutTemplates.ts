import type { Sport } from "../domain/index.js";
import { validateIsoDate } from "../dates/index.js";
import { runningZoneLabels } from "../engine/running.js";
import type { ParsedDuration, ParsedStep, ParsedWorkout } from "./schema.js";

type TemplateDefinition = {
  name: string;
  aliases: readonly string[];
  sport: Sport;
  version: number;
  requiredParameters: readonly string[];
  instruction: string;
  sourceUrl?: string;
  groups?: readonly { repetitions: number; effortSeconds: number; floatSeconds: number; effort: "Hard" | "Very Hard" | "Sprint" }[];
};

export const monaFartlekTemplate: TemplateDefinition = {
  name: "Mona Fartlek",
  aliases: ["Mona Fartlek", "Moneghetti Fartlek", "Steve Moneghetti's Fartlek"],
  sport: "running",
  version: 3,
  sourceUrl: "https://grcc.net.au/documents/Interviews/Steve_Moneghetti.pdf",
  requiredParameters: [],
  instruction: "Classic 20-minute continuous set. Preserve four repeat groups: 2 x (90 seconds hard + 90 seconds float), 4 x (60 + 60), 4 x (30 + 30), 4 x (15 + 15). Each float occurs after every effort, including the last. Float is active running recovery, never passive rest. Warm-up/cool-down are included only when requested. Preserve Hard effort notes for 90/60 seconds, Very Hard effort notes for 30 seconds, Sprint effort notes for 15 seconds and float recovery notes for each recovery. Omit targets unless supplied by the user. Code applies reviewable seven-zone app defaults: Z5a for 90/60 seconds, Z5b for 30 seconds, Z5c for 15 seconds, and Z2 floats. These are editable app defaults, not a universal historical prescription. Z5c is faster than 90% of running threshold pace; preserve its open-ended boundary rather than assigning an exact sprint pace. Do not use heart-rate percentages to calculate pace.",
  groups: [
    { repetitions: 2, effortSeconds: 90, floatSeconds: 90, effort: "Hard" },
    { repetitions: 4, effortSeconds: 60, floatSeconds: 60, effort: "Hard" },
    { repetitions: 4, effortSeconds: 30, floatSeconds: 30, effort: "Very Hard" },
    { repetitions: 4, effortSeconds: 15, floatSeconds: 15, effort: "Sprint" },
  ],
};

function pattern(name: string, sport: Sport, aliases: string[], instruction: string, requiredParameters: string[]): TemplateDefinition {
  return { name, sport, aliases: [name, ...aliases], instruction, requiredParameters, version: 1 };
}

// These categories have no single complete recipe. They guide interpretation of
// supplied parameters and must never expand from a name alone into guessed values.
export const workoutTemplates: readonly TemplateDefinition[] = [
  monaFartlekTemplate,
  pattern("Cruise intervals", "running", [], "Threshold efforts with short active recoveries.", ["repetitions", "effort duration or distance", "recovery duration"]),
  pattern("VO2max intervals", "running", ["VO₂max intervals"], "Repeated hard efforts with active recoveries; preserve supplied targets.", ["repetitions", "effort duration or distance", "recovery duration", "target"]),
  pattern("Strides", "running", [], "Fast relaxed efforts with recovery between them. Preserve 'Stride: fast relaxed' in notes and omit target unless explicitly supplied; code leaves these open instead of prescribing Z5c automatically.", ["repetitions", "effort duration or distance", "recovery"]),
  pattern("Pyramid intervals", "running", ["pyramid"], "Increasing then decreasing effort lengths. Retain the exact supplied sequence.", ["effort sequence", "recovery", "target"]),
  pattern("Ladder intervals", "running", ["ladder"], "Increasing or decreasing effort lengths. Do not add a descending half unless requested.", ["effort sequence", "recovery", "target"]),
  pattern("Progression run", "running", ["cut-down", "progression"], "Continuous segments getting faster; keep each prescribed segment separate.", ["segment durations or distances", "segment targets"]),
  pattern("Fartlek", "running", [], "Alternating faster and easier running. Use the provided sequence; generic fartlek has no fixed repetitions. A named recipe such as Mona takes precedence.", ["effort sequence", "recovery sequence"]),
  pattern("Yasso 800s", "running", ["Yasso"], "800 m repeats with equal-time recovery. Require effort time to determine timed recovery. Do not infer a marathon prediction or silently choose the repetition count.", ["repetitions", "800 m effort time"]),
  pattern("Norwegian 4 x 4", "running", ["Norwegian 4×4", "Norwegian 4x4"], "Four 4-minute hard efforts; preserve explicitly requested recovery and intensity.", ["recovery duration", "target"]),
  pattern("CSS repeats", "swimming", ["CSS set", "threshold repeats", "critical-speed set"], "Repeated swimming at CSS or a supplied CSS offset. CSS alone means an offset of zero. Emit a relative swimming_threshold_offset target; code resolves the pace.", ["repetitions", "distance or duration", "rest", "CSS prescription"]),
  pattern("Aerobic endurance", "swimming", ["endurance set"], "Longer steady swimming repetitions with specified rest.", ["repetitions", "distance or duration", "rest", "target"]),
  pattern("Pace 100s", "swimming", ["pace 200s"], "Distance repeats at the prescribed pace; preserve the requested distance and exact pace.", ["repetitions", "pace", "rest"]),
  pattern("Descending set", "swimming", ["descending", "descend"], "Each repeat or round gets faster. Preserve the descend range and supplied targets in step notes.", ["repetitions", "distance or duration", "rest", "descend range"]),
  pattern("Build", "swimming", ["build set"], "Increase effort within each repeat. Keep build instructions in notes and leave the pace target open unless explicitly prescribed.", ["repetitions", "distance or duration", "rest", "effort range"]),
  pattern("Broken swim", "swimming", ["broken time trial", "time trial"], "Separate timed effort segments and specified rests. Preserve RECORD TIME; never invent measured times or update CSS from a prescription.", ["distances", "rest", "effort"]),
  pattern("Pull set", "swimming", [], "Retain pull and specified equipment in notes. Do not assume a stroke or pace.", ["repetitions", "distance or duration", "rest", "target"]),
  pattern("Kick set", "swimming", [], "Retain kick and specified equipment in notes.", ["repetitions", "distance or duration", "rest", "target"]),
  pattern("Drill set", "swimming", [], "Retain the named drill in notes; never invent a drill.", ["repetitions", "distance or duration", "rest", "drill"]),
  pattern("IM set", "swimming", ["mixed-stroke", "individual medley"], "Preserve the specified fly/back/breast/free stroke sequence in separate steps.", ["repetitions", "distances", "stroke sequence", "rest"]),
  pattern("Open-water intervals", "swimming", ["open water intervals"], "Time or distance intervals with supplied recovery, sighting and buoy instructions in notes.", ["repetitions", "distance or duration", "recovery", "target"]),
];

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasPattern(template: TemplateDefinition): RegExp {
  return new RegExp(`\\b(?:${template.aliases.map(escaped).join("|")})\\b`, "i");
}

export function templateInstructions(sourcePrompt: string, sport: Sport): string {
  const relevant = workoutTemplates.filter((template) => template.sport === sport && aliasPattern(template).test(sourcePrompt.replace(/[’]/g, "'")));
  if (relevant.length === 0) return "";
  return `Shared workout templates (apply only the requested template and explicit modifications):\n${relevant.map((template) => {
    const groups = template.groups === undefined ? "" : ` Repeat groups: ${JSON.stringify(template.groups)}.`;
    return `- ${template.name} v${template.version}: ${template.instruction}${groups} Required parameters: ${template.requiredParameters.join(", ") || "none for the main set"}.`;
  }).join("\n")}\nIf a required parameter is missing, do not invent it. Preserve the uncertainty in notes and use an open duration where the duration is unknown so the user can complete the workout in Review. If a required intensity is missing, omit target and include 'Target unspecified' in that step's notes. Keep an unspecified rest as its own open rest step; never put a rest instruction in a work step's notes.\n`;
}

export function namedTemplateRepeatCounts(sourcePrompt: string, sport: Sport): number[] | undefined {
  if (sport !== "running" || !aliasPattern(monaFartlekTemplate).test(sourcePrompt.replace(/[’]/g, "'"))) return undefined;
  return monaFartlekTemplate.groups?.map((group) => group.repetitions).sort((left, right) => left - right);
}

export function parseNamedWorkout(sourcePrompt: string, sport: Sport, referenceDate: string): ParsedWorkout | undefined {
  if (sport !== "running") return undefined;
  let remaining = sourcePrompt.replace(/[’]/g, "'").trim();
  const alias = aliasPattern(monaFartlekTemplate);
  if (!alias.test(remaining)) return undefined;
  remaining = remaining.replace(alias, " ");

  let scheduledDate: string | null = null;
  const date = /\b(today|tomorrow|\d{4}-\d{2}-\d{2})\b/i.exec(remaining);
  if (date !== null) {
    if (date[0].toLowerCase() === "today") scheduledDate = validateIsoDate(referenceDate);
    else if (date[0].toLowerCase() === "tomorrow") {
      const nextDay = new Date(`${validateIsoDate(referenceDate)}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      scheduledDate = nextDay.toISOString().slice(0, 10);
    } else scheduledDate = validateIsoDate(date[0]);
    remaining = remaining.replace(date[0], " ");
  }

  const additions: ParsedStep[] = [];
  const duration = "(\\d+(?:\\.\\d+)?)\\s*[- ]?\\s*(minutes?|mins?|seconds?|secs?|km|m)";
  const label = "(warm[\\s-]*up|cool[\\s-]*down|warm[\\s-]*down)";
  const clause = new RegExp(`(?:${duration}\\s+${label}|${label}\\s*(?:for\\s+)?${duration})(?:\\s+(?:in|at)\\s+Z([1-5](?:[abc])?))?`, "gi");
  remaining = remaining.replace(clause, (_text: string, ...captures: (string | undefined)[]) => {
    const value = Number(captures[0] ?? captures[4]);
    const unit = captures[1] ?? captures[5] ?? "";
    const kind = captures[2] ?? captures[3] ?? "";
    const type = /^warm[\s-]*up$/i.test(kind) ? "warmup" : "cooldown";
    const blockDuration: ParsedDuration = /^(?:km|m)$/i.test(unit)
      ? { kind: "distance", metres: value * (/^km$/i.test(unit) ? 1000 : 1) }
      : { kind: "time", seconds: value * (/^min/i.test(unit) ? 60 : 1) };
    const zone = captures[6] === undefined ? undefined : runningZoneLabels[captures[6].toLowerCase()];
    if (captures[6] !== undefined && zone === undefined) return _text;
    additions.push({ id: `mona-${type}`, type, duration: blockDuration, ...(zone === undefined ? {} : { target: { kind: "running_zone", zone } }) });
    return " ";
  });
  // Consume the entire request. Unrecognised modifications must go through the
  // model instead of being silently discarded just because a name matched.
  remaining = remaining.replace(/\b(?:please|do|a|an|the|classic|standard|run|running|session|set|workout|with|and|then|followed|by|on|for|me)\b/gi, "").replace(/[\s,.:;!]+/g, "");
  if (remaining !== "" || additions.some((step) => step.type !== "repeat" && ((step.duration.kind === "time" && step.duration.seconds <= 0) || (step.duration.kind === "distance" && step.duration.metres <= 0)))) return undefined;
  if (additions.filter((step) => step.type === "warmup").length > 1 || additions.filter((step) => step.type === "cooldown").length > 1) return undefined;
  const groups: ParsedStep[] = (monaFartlekTemplate.groups ?? []).map((group, index) => ({
    id: `mona-group-${index + 1}`, type: "repeat", repetitions: group.repetitions,
    steps: [
      { id: `mona-hard-${index + 1}`, type: "work", duration: { kind: "time", seconds: group.effortSeconds }, notes: `Mona Fartlek: ${group.effort} effort; controlled, faster as repetitions shorten` },
      { id: `mona-float-${index + 1}`, type: "recovery", duration: { kind: "time", seconds: group.floatSeconds }, notes: "Mona Fartlek: float recovery" },
    ],
  }));
  return {
    name: monaFartlekTemplate.name, sport, scheduledDate,
    description: `Classic 20-minute Mona Fartlek (template v${monaFartlekTemplate.version}). Reviewable app defaults: Z5a for 90/60-second efforts, Z5b for 30-second efforts, Z5c for 15-second efforts, Z2 floats; resolved from running threshold, not heart rate.`,
    steps: [...additions.filter((step) => step.type === "warmup"), ...groups, ...additions.filter((step) => step.type === "cooldown")],
    profileUpdates: [],
  };
}
