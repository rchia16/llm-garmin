import { parsedWorkoutSchema, type ParsedStep, type ParsedWorkout } from "./schema.js";

type Section = "warmup" | "work" | "cooldown";

const headingSection: Record<string, Section> = {
  "warm up": "warmup",
  warmup: "warmup",
  test: "work",
  "main set": "work",
  "cool down": "cooldown",
  cooldown: "cooldown",
  "warm down": "cooldown",
};

function splitOutsideParens(text: string, separator: string): string[] | undefined {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0) return undefined;
    if (character === separator && depth === 0) {
      pieces.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) return undefined;
  pieces.push(text.slice(start).trim());
  return pieces.every((piece) => piece.length > 0) ? pieces : undefined;
}

export function parseStructuredSwim(sourcePrompt: string): ParsedWorkout | undefined {
  const lines: string[] = [];
  let pendingLine = "";
  let groupDepth = 0;
  for (const line of sourcePrompt.split(/\r?\n/).map((part) => part.trim()).filter((part) => part.length > 0 && !/^-{3,}$/.test(part))) {
    pendingLine = pendingLine.length === 0 ? line : `${pendingLine} ${line}`;
    for (const character of line) {
      if (character === "(") groupDepth += 1;
      if (character === ")") groupDepth -= 1;
      if (groupDepth < 0) return undefined;
    }
    if (groupDepth === 0) {
      lines.push(pendingLine);
      pendingLine = "";
    }
  }
  if (groupDepth !== 0) return undefined;
  let section: Section | undefined;
  let sawHeading = false;
  let sawTest = false;
  let usedUnwrappedStep = false;
  let id = 0;
  const steps: ParsedStep[] = [];
  let repeatedSet: { repetitions: number; expectedMetres: number; steps: ParsedStep[] } | undefined;

  const distanceMetres = (items: ParsedStep[]): number => items.reduce((sum, step) => {
    if (step.type === "repeat") return sum + step.repetitions * distanceMetres(step.steps);
    return sum + (step.duration.kind === "distance" ? step.duration.metres : 0);
  }, 0);

  const finishRepeatedSet = (): boolean => {
    if (repeatedSet === undefined) return true;
    if (distanceMetres(repeatedSet.steps) !== repeatedSet.expectedMetres) return false;
    id += 1;
    steps.push({ id: `swim-${id}`, type: "repeat", repetitions: repeatedSet.repetitions, steps: repeatedSet.steps });
    repeatedSet = undefined;
    return true;
  };

  const parseMovement = (text: string): ParsedStep | undefined => {
    const rest = /^(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|min)\s+rests?$/i.exec(text);
    if (rest !== null) {
      const value = Number(rest[1]);
      if (value <= 0) return undefined;
      id += 1;
      return { id: `swim-${id}`, type: "rest", duration: { kind: "time", seconds: value * (/^min/i.test(rest[2] ?? "") ? 60 : 1) } };
    }

    const recovery = /^(\d+(?:\.\d+)?)\s*(minutes?|mins?|min|seconds?|secs?|s)\s+Easy\s+for\s+active\s+recovery$/i.exec(text);
    if (recovery !== null) {
      const value = Number(recovery[1]);
      if (value <= 0) return undefined;
      id += 1;
      return { id: `swim-${id}`, type: "recovery", duration: { kind: "time", seconds: value * (/^min/i.test(recovery[2] ?? "") ? 60 : 1) }, notes: "Easy active recovery" };
    }

    if (section === undefined) return undefined;
    const movement = /^(\d+(?:\.\d+)?)\s*(?:m\b\s*)?(?:(FS|freestyle|free|pull|drill|kick|choice|back|backstroke|breast|breaststroke)\b\s*)?(.*)$/i.exec(text);
    if (movement === null) return undefined;
    const metres = Number(movement[1]);
    if (metres <= 0) return undefined;
    const stroke = movement[2];
    const instruction = movement[3]?.trim() ?? "";
    const zone = /^in\s+Z(1|2|3|4|5|5a|5b|5c)$/i.exec(instruction);
    if (zone !== null && stroke !== undefined) {
      id += 1;
      return {
        id: `swim-${id}`,
        type: section,
        duration: { kind: "distance", metres },
        target: { kind: "swimming_zone", zone: `z${zone[1]?.toLowerCase()}` },
        notes: stroke,
      } as ParsedStep;
    }
    if (!/^(?:Very Easy|Easy|Steady|Moderate|Moderately Hard|Very Hard|Hard|Sprint|All[- ]out|Build Easy to Hard|max(?:imal)? effort(?:\s+time trial)?(?:\s+RECORD TIME)?)$/i.test(instruction)) return undefined;
    id += 1;
    return {
      id: `swim-${id}`,
      type: section,
      duration: { kind: "distance", metres },
      notes: [stroke, instruction].filter(Boolean).join(" "),
    };
  };

  const parseComponents = (content: string): ParsedStep[] | undefined => {
    const commaParts = splitOutsideParens(content, ",");
    if (commaParts === undefined) return undefined;
    const children: ParsedStep[] = [];
    for (const commaPart of commaParts) {
      const plusParts = splitOutsideParens(commaPart, "+");
      if (plusParts === undefined) return undefined;
      for (const part of plusParts) {
        const step = parseMovement(part);
        if (step === undefined) return undefined;
        children.push(step);
      }
    }
    return children;
  };

  for (const line of lines) {
    let contentLine = line;
    const heading = /^([^:]+):(?:\s*(.*))?$/.exec(line);
    const headingKey = heading?.[1]?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
    if (heading !== null && Object.hasOwn(headingSection, headingKey)) {
      if (!finishRepeatedSet()) return undefined;
      section = headingSection[headingKey];
      sawHeading = true;
      if (headingKey === "test") sawTest = true;
      contentLine = heading[2]?.trim() ?? "";
      if (contentLine.length === 0) continue;
    }
    if (section === undefined) return undefined;

    const setRepeat = /^Repeat\s+(\d+)\s+sets?\s+of\s+(\d+(?:\.\d+)?)\s*(?:m(?:et(?:er|re)s?)?\s*)?as\s+below:?$/i.exec(contentLine);
    if (setRepeat !== null) {
      if (repeatedSet !== undefined || section !== "work") return undefined;
      const repetitions = Number(setRepeat[1]);
      const expectedMetres = Number(setRepeat[2]);
      if (!Number.isSafeInteger(repetitions) || repetitions < 2 || !Number.isFinite(expectedMetres) || expectedMetres <= 0) return undefined;
      repeatedSet = { repetitions, expectedMetres, steps: [] };
      continue;
    }

    // These two comma clauses annotate a movement; other commas separate steps.
    const content = contentLine.replace(/[.,;]\s*$/, "")
      .replace(/,\s*RECORD TIME\b/gi, " RECORD TIME")
      .replace(/\b(Choice),\s*(Steady)\b/gi, "$1 $2");
    const groups = splitOutsideParens(content, ",");
    if (groups === undefined) return undefined;
    for (const group of groups) {
      const parenthesized = /^(\d+)\s*[x\u00d7]\s*\((.*)\)$/i.exec(group);
      const simple = /^(\d+)\s*[x\u00d7]\s+(.+)$/i.exec(group);
      if (parenthesized === null) usedUnwrappedStep = true;
      const repetitions = parenthesized === null && simple === null ? 1 : Number((parenthesized ?? simple)?.[1]);
      if (!Number.isSafeInteger(repetitions) || repetitions < 1) return undefined;
      const children = parseComponents(parenthesized?.[2] ?? simple?.[2] ?? group);
      if (children === undefined) return undefined;
      let parsedSteps: ParsedStep[];
      if (repetitions === 1) {
        parsedSteps = children;
      } else {
        id += 1;
        parsedSteps = [{ id: `swim-${id}`, type: "repeat", repetitions, steps: children }];
      }
      (repeatedSet?.steps ?? steps).push(...parsedSteps);
    }
  }
  if (!finishRepeatedSet()) return undefined;

  // Keep the original strict route for ordinary sectioned swims; the wider
  // unwrapped-step grammar is only enabled by an explicit TEST section.
  if (!sawHeading || steps.length === 0 || (usedUnwrappedStep && !sawTest)) return undefined;
  const result = parsedWorkoutSchema.safeParse({ name: sawTest ? "Swim test workout" : "Swim workout", sport: "swimming", scheduledDate: null, steps, profileUpdates: [] });
  return result.success ? result.data : undefined;
}
