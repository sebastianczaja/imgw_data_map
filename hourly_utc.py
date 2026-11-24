from collections import defaultdict
from datetime import datetime, timedelta, timezone
import math
from zoneinfo import ZoneInfo


LOCAL_TZ = ZoneInfo("Europe/Warsaw")


def repeated_hour_slots(target_date):
    for hour in range(24):
        first = datetime(target_date.year, target_date.month, target_date.day, hour, tzinfo=LOCAL_TZ, fold=0)
        second = first.replace(fold=1)
        if first.utcoffset() == second.utcoffset():
            continue
        instants = [value.astimezone(timezone.utc) for value in (first, second)]
        if all(value.astimezone(LOCAL_TZ).replace(tzinfo=None) == first.replace(tzinfo=None) for value in instants):
            return f"{hour:02d}", sorted(instants)
    return None


def build_repeated_hour_utc_readings(payload, target_date):
    repeated = repeated_hour_slots(target_date)
    if repeated is None:
        return {}
    hour, instants = repeated
    result = {instant.strftime("%Y-%m-%dT%H:%M:%SZ"): {} for instant in instants}

    def points(rows):
        for row in rows or []:
            if not isinstance(row, dict) or not isinstance(row.get("date"), str) or row.get("value") is None:
                continue
            try:
                timestamp = datetime.fromisoformat(row["date"].replace("Z", "+00:00"))
                value = float(row["value"])
            except (TypeError, ValueError, OverflowError):
                continue
            if timestamp.tzinfo is None or not math.isfinite(value):
                continue
            yield timestamp.astimezone(timezone.utc), value

    def key(timestamp):
        return timestamp.strftime("%Y-%m-%dT%H:%M:%SZ")

    for source, parameter in (("temperature", "Ta"), ("precip", "Precip")):
        for timestamp, value in points(payload.get(source)):
            if timestamp.minute == 0 and timestamp.second == 0 and timestamp.microsecond == 0:
                slot = key(timestamp)
                if slot in result:
                    result[slot][parameter] = value

    wind = payload.get("wind") or {}
    if isinstance(wind, dict):
        for timestamp, value in points(wind.get("velocityObs")):
            if timestamp.minute == 0 and timestamp.second == 0 and timestamp.microsecond == 0:
                slot = key(timestamp)
                if slot in result:
                    result[slot]["Wind_avg"] = value

        telemetry = defaultdict(list)
        gusts = defaultdict(list)
        for timestamp, value in points(wind.get("velocityTel")):
            slot = key(timestamp.replace(minute=0, second=0, microsecond=0))
            if slot in result:
                telemetry[slot].append(value)
        for timestamp, value in points(wind.get("maxVelocity")):
            rounded = timestamp.replace(minute=0, second=0, microsecond=0)
            if timestamp != rounded:
                rounded += timedelta(hours=1)
            slot = key(rounded)
            if slot in result:
                gusts[slot].append(value)
        for slot, values in telemetry.items():
            result[slot].setdefault("Wind_avg", round(sum(values) / len(values), 1))
        for slot, values in gusts.items():
            result[slot]["Wind_max"] = max(values)

    return {hour: result}


def merge_utc_readings(hour, readings):
    additions = 0
    if "UTC" not in hour:
        hour["UTC"] = {}
        additions += 1
    utc = hour["UTC"]
    if not isinstance(utc, dict):
        raise ValueError("Hourly UTC readings must be an object")
    for timestamp, parameters in readings.items():
        if timestamp not in utc:
            utc[timestamp] = {}
            additions += 1
        values = utc[timestamp]
        if not isinstance(values, dict):
            raise ValueError("Hourly UTC slot must be an object")
        for parameter, value in parameters.items():
            if values.get(parameter) is None or values.get(parameter) == "":
                values[parameter] = value
                additions += 1
    return additions
