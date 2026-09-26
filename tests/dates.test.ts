import { describe, expect, it } from "vitest";
import { nextOccurrenceOfWeekday, todayInTimeZone, tomorrowInTimeZone, validateIsoDate } from "../src/dates/index.js";

// A fixed instant makes calendar behavior reproducible across timezones and test runs.

describe("deterministic date utilities", () => {
  const referenceDate = new Date("2026-09-26T23:30:00.000Z");

  it("resolves dates in the injected timezone", () => {
    expect(todayInTimeZone(referenceDate, "America/New_York")).toBe("2026-09-26");
    expect(tomorrowInTimeZone(referenceDate, "America/New_York")).toBe("2026-09-27");
    expect(nextOccurrenceOfWeekday(referenceDate, "America/New_York", 2)).toBe("2026-09-29");
  });

  it("validates real calendar dates", () => {
    expect(validateIsoDate("2026-02-28")).toBe("2026-02-28");
    expect(() => validateIsoDate("2026-02-30")).toThrow();
    expect(() => validateIsoDate("tomorrow")).toThrow();
  });
});
