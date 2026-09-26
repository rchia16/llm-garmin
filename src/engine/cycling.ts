import type { CyclingTarget } from "../domain/index.js";

// Cycling targets are represented as watts or a fraction of the athlete's FTP.

export const cogganPowerZones = {
  recovery: [0.00, 0.55],
  endurance: [0.56, 0.75],
  tempo: [0.76, 0.90],
  threshold: [0.91, 1.05],
  vo2max: [1.06, 1.20],
  anaerobic: [1.21, 1.50],
} as const;

// These are the named Coggan-style FTP ranges used by the Phase 1 engine.

export type CyclingZone = keyof typeof cogganPowerZones;

export function resolveFtpFraction(ftpWatts: number, fraction: number): number {
  if (!Number.isFinite(ftpWatts) || ftpWatts <= 0 || !Number.isFinite(fraction) || fraction <= 0) {
    throw new Error("FTP and its fraction must be positive finite numbers.");
  }
  return ftpWatts * fraction;
}

export function resolveFtpRange(
  ftpWatts: number,
  fractions: readonly [number, number],
): [number, number] {
  const [lowerFraction, upperFraction] = fractions;
  if (lowerFraction <= 0 || upperFraction <= 0 || lowerFraction > upperFraction) {
    throw new Error("FTP fractions must be positive and ordered.");
  }
  return [resolveFtpFraction(ftpWatts, lowerFraction), resolveFtpFraction(ftpWatts, upperFraction)];
}

export function resolveCyclingZone(
  ftpWatts: number,
  zone: CyclingZone,
): { watts: number; rangeWatts: [number, number] } {
  const rangeWatts = resolveFtpRange(ftpWatts, cogganPowerZones[zone]);
  return { watts: rangeWatts[0], rangeWatts };
}

export function resolveCyclingTarget(target: CyclingTarget, ftpWatts: number): CyclingTarget {
  if (target.source === "explicit") return target;
  const resolved = target.prescriptionKind === "ftp_fraction"
    ? { kind: "cycling_power" as const, watts: resolveFtpFraction(ftpWatts, target.fraction) }
    : { kind: "cycling_power" as const, ...resolveCyclingZone(ftpWatts, target.zone as CyclingZone) };
  return { ...target, resolved };
}
