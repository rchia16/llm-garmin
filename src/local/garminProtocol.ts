import { z } from "zod";

export const garminMessages = {
  READY: "Garmin session ready (experimental).",
  SCHEDULED: "Scheduled in Garmin Connect—sync your device. Watch delivery is not verified.",
  LOGGED_OUT: "Local Garmin session removed.",
  SETUP_REQUIRED: "Install the optional Python Garmin bridge using the README setup instructions.",
  PYTHON_VERSION: "The Garmin bridge requires Python 3.12 or newer.",
  AUTH_REQUIRED: "Connect Garmin to sign in, or use terminal login as a fallback.",
  MFA_REQUIRED: "Enter the verification code Garmin sent you.",
  SESSION_NOT_SAVED: "Login succeeded but its session was not saved. Check private-directory access.",
  CONFIG_INVALID: "GARMIN_SESSION_DIR must be a dedicated absolute directory outside the repository, without symlinks.",
  STORAGE_UNSAFE: "Could not secure Garmin storage for your local user. Check directory permissions.",
  BUSY: "Another Garmin operation is running. Wait before trying again.",
  INVALID_REQUEST: "Invalid workout or scheduling request. Check the reviewed workout and date.",
  OPERATION_CONFLICT: "This operation belongs to different workout data. Review the workout before sending.",
  RATE_LIMITED: "Garmin rate limited this request. Wait before trying again.",
  GARMIN_REJECTED: "Garmin rejected the request. Review its supported steps and targets before retrying.",
  NETWORK_FAILED: "Could not contact Garmin. Your local workout was left unchanged.",
  UPLOAD_UNCERTAIN: "Upload outcome is uncertain. Check Garmin Connect before sending again; automatic re-upload is blocked.",
  WORKOUT_MISMATCH: "The uploaded workout differs from the reviewed structure or targets. Scheduling was stopped; inspect it in Garmin Connect.",
  SCHEDULE_UNCERTAIN: "Scheduling outcome is uncertain. Check Garmin Connect; retry only rechecks the calendar and will not reschedule blindly.",
  CALENDAR_UNVERIFIED: "Workout exists, but its calendar entry could not be verified. Retry to check again without uploading another copy.",
  CANCELLED: "Garmin operation cancelled.",
  BRIDGE_TIMEOUT: "Garmin bridge timed out. Check Connect; retry uses its durable receipt instead of blindly repeating an upload.",
  BRIDGE_FAILED: "Garmin bridge failed. Check setup; local saving and downloads remain available.",
  UNAVAILABLE: "Garmin sending requires the local Vite development or preview server. Downloads still work.",
} as const;

export const garminResultSchema = z.object({
  ok: z.boolean(),
  code: z.enum(Object.keys(garminMessages) as [keyof typeof garminMessages, ...(keyof typeof garminMessages)[]]),
  workoutId: z.number().int().positive().optional(),
  date: z.string().optional(),
}).refine((result) => result.ok === ["READY", "SCHEDULED", "LOGGED_OUT"].includes(result.code), "Inconsistent Garmin result.");
export type GarminResult = z.infer<typeof garminResultSchema>;
export function garminResultMessage(result: GarminResult): string {
  return `${garminMessages[result.code]}${result.workoutId === undefined ? "" : ` Garmin workout ID: ${result.workoutId}.`}`;
}
