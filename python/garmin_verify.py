"""Compare semantic fields, ignoring server-assigned IDs and display metadata."""
from __future__ import annotations

import math


ENUM_IDS = {"sportType": "sportTypeId", "stepType": "stepTypeId", "endCondition": "conditionTypeId",
            "targetType": "workoutTargetTypeId", "secondaryTargetType": "workoutTargetTypeId",
            "strokeType": "strokeTypeId", "poolLengthUnit": "unitKey"}
STEP_FIELDS = ("type", "stepOrder", "stepType", "endCondition", "endConditionValue", "targetType",
               "targetValueOne", "targetValueTwo", "zoneNumber", "secondaryTargetType",
               "secondaryTargetValueOne", "secondaryTargetValueTwo", "strokeType", "numberOfIterations", "description")


def field_matches(key, expected, actual):
    if key in ENUM_IDS:
        id_key = ENUM_IDS[key]
        return isinstance(actual, dict) and expected.get(id_key) == actual.get(id_key)
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        return isinstance(actual, (int, float)) and not isinstance(actual, bool) and math.isclose(expected, actual, rel_tol=1e-6, abs_tol=0.001)
    return expected == actual


def steps_match(expected, actual):
    if not isinstance(actual, list) or len(expected) != len(actual):
        return False
    for first, second in zip(expected, actual):
        if not isinstance(second, dict):
            return False
        for key in STEP_FIELDS:
            if key in first and not field_matches(key, first[key], second.get(key)):
                return False
        if "workoutSteps" in first and not steps_match(first["workoutSteps"], second.get("workoutSteps")):
            return False
    return True


def workout_matches(expected, actual):
    if not isinstance(actual, dict):
        return False
    for key in ("workoutName", "sportType", "description", "poolLength", "poolLengthUnit"):
        if key in expected and not field_matches(key, expected[key], actual.get(key)):
            return False
    segments = actual.get("workoutSegments")
    if not isinstance(segments, list) or len(segments) != len(expected["workoutSegments"]):
        return False
    for first, second in zip(expected["workoutSegments"], segments):
        if not isinstance(second, dict) or not field_matches("sportType", first["sportType"], second.get("sportType")):
            return False
        if not steps_match(first["workoutSteps"], second.get("workoutSteps")):
            return False
    return True


def calendar_contains(data, workout_id: int, scheduled_date: str):
    if isinstance(data, list):
        return any(calendar_contains(item, workout_id, scheduled_date) for item in data)
    if not isinstance(data, dict):
        return False
    candidate = data.get("workoutId")
    if candidate is None and isinstance(data.get("workout"), dict):
        candidate = data["workout"].get("workoutId")
    if str(candidate) == str(workout_id) and data.get("date") == scheduled_date:
        return True
    return any(calendar_contains(value, workout_id, scheduled_date) for value in data.values() if isinstance(value, (dict, list)))
