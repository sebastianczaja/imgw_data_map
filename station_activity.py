import hashlib
import argparse
import json
import math
import os
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from openpyxl import load_workbook


LOCAL_TZ = ZoneInfo("Europe/Warsaw")
INDEX_VERSION = 3
PARAMETER_BITS = {
    "Ta": 1, "Precip": 2, "Wind_avg": 4, "Wind_max": 8,
    "Tmin": 16, "Tmax": 32, "Tg": 64, "Precip_24h": 128,
}


def is_measurement(value):
    if value is None or value == "" or isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError, OverflowError):
        return False


def parse_measurement_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=LOCAL_TZ) if parsed.tzinfo is None else parsed


def summarize_document(document, day):
    stations = {}
    for feature in document.get("features", []):
        properties = feature.get("properties") or {}
        station_id = properties.get("Station_id")
        if station_id is None:
            continue
        station_id = str(station_id)
        observations = []
        hourly = properties.get("Hourly")
        if isinstance(hourly, dict):
            for hour_key, values in hourly.items():
                if not isinstance(values, dict):
                    continue
                try:
                    hour = int(hour_key)
                except (TypeError, ValueError):
                    continue
                if not 0 <= hour <= 23:
                    continue
                if any(key != "UTC" and is_measurement(value) for key, value in values.items()):
                    observations.append(datetime.combine(day, time(hour), LOCAL_TZ))
                utc_values = values.get("UTC")
                if isinstance(utc_values, dict):
                    for timestamp, readings in utc_values.items():
                        if not isinstance(readings, dict) or not any(is_measurement(value) for value in readings.values()):
                            continue
                        parsed = parse_measurement_time(timestamp)
                        if parsed is not None and parsed.astimezone(LOCAL_TZ).date() == day:
                            observations.append(parsed)
        for key, timestamp in properties.items():
            if not key.endswith("_time") or not is_measurement(properties.get(key[:-5])):
                continue
            parsed = parse_measurement_time(timestamp)
            if parsed is not None and parsed.astimezone(LOCAL_TZ).date() == day:
                observations.append(parsed)

        previous = stations.get(station_id)
        unchecked = properties.get("Activity_check_failed") or (
            properties.get("Status") == "CLOSED" and not properties.get("Activity_checked")
        )
        if unchecked and not observations:
            continue
        if previous is not None:
            observations.extend(datetime.fromtimestamp(value, timezone.utc) for value in previous[:2])
        stations[station_id] = (
            [int(min(observations).timestamp()), int(max(observations).timestamp())]
            if observations else None
        )
        if stations[station_id] is not None and (
            unchecked or (previous is not None and len(previous) > 2)
        ):
            stations[station_id].append(False)
    return stations


def summarize_parameters(document, day):
    observations = {}
    boundary = datetime.combine(day, time(6), timezone.utc)

    def record(station_id, parameter, measured_at):
        mask = PARAMETER_BITS.get(parameter)
        if mask is None:
            return
        # The upper byte distinguishes observations after this day's 06:00 UTC boundary.
        if measured_at.astimezone(timezone.utc) > boundary:
            mask <<= 8
        observations[station_id] = observations.get(station_id, 0) | mask

    for feature in document.get("features", []):
        properties = feature.get("properties") or {}
        if properties.get("Station_id") is None:
            continue
        station_id = str(properties["Station_id"])
        hourly = properties.get("Hourly")
        if isinstance(hourly, dict):
            for hour_key, values in hourly.items():
                if not isinstance(values, dict):
                    continue
                try:
                    hour = int(hour_key)
                    measured_at = datetime.combine(day, time(hour), LOCAL_TZ)
                except (TypeError, ValueError):
                    continue
                for parameter in ("Ta", "Precip", "Wind_avg", "Wind_max"):
                    if is_measurement(values.get(parameter)):
                        record(station_id, parameter, measured_at)
                utc_values = values.get("UTC")
                if isinstance(utc_values, dict):
                    for timestamp, readings in utc_values.items():
                        parsed = parse_measurement_time(timestamp)
                        if parsed is None or parsed.astimezone(LOCAL_TZ).date() != day or not isinstance(readings, dict):
                            continue
                        for parameter in ("Ta", "Precip", "Wind_avg", "Wind_max"):
                            if is_measurement(readings.get(parameter)):
                                record(station_id, parameter, parsed)
        for parameter in PARAMETER_BITS:
            if not is_measurement(properties.get(parameter)):
                continue
            timestamp = properties.get(parameter + "_time")
            parsed = parse_measurement_time(timestamp)
            if parsed is not None and parsed.astimezone(LOCAL_TZ).date() == day:
                record(station_id, parameter, parsed)
            elif timestamp is None and parameter in ("Tmin", "Tmax", "Precip_24h"):
                record(station_id, parameter, boundary)
    return observations


def build_parameter_history(days):
    parameters = {}
    for day, entry in sorted(days.items()):
        boundary = int(datetime.combine(date.fromisoformat(day), time(6), timezone.utc).timestamp())
        for station_id, mask in entry.get("parameters", {}).items():
            station = parameters.setdefault(station_id, {})
            for parameter, bit in PARAMETER_BITS.items():
                if bit & mask:
                    timestamp = boundary
                elif (bit << 8) & mask:
                    timestamp = boundary + 1
                else:
                    continue
                station[parameter] = min(station.get(parameter, timestamp), timestamp)
    return parameters


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def update_history(data_dir):
    data_dir = Path(data_dir)
    index_path = data_dir / "station_activity.json"
    if index_path.exists():
        with index_path.open(encoding="utf-8") as source:
            index = json.load(source)
        if index.get("version") in (1, 2) and isinstance(index.get("days"), dict):
            index = {"version": INDEX_VERSION, "days": {}}
        elif index.get("version") != INDEX_VERSION or not isinstance(index.get("days"), dict):
            raise ValueError(f"Nieprawidłowy indeks aktywności stacji: {index_path}")
    else:
        index = {"version": INDEX_VERSION, "days": {}}
    days = index["days"]
    available = set()
    for path in sorted(data_dir.glob("????-??-??.geojson")):
        try:
            day = date.fromisoformat(path.stem)
        except ValueError:
            continue
        available.add(path.stem)
        digest = file_hash(path)
        if days.get(path.stem, {}).get("sha256") == digest:
            continue
        with path.open(encoding="utf-8") as source:
            document = json.load(source)
        if document.get("type") != "FeatureCollection" or not isinstance(document.get("features"), list):
            raise ValueError(f"Nieprawidłowy plik danych stacji: {path}")
        days[path.stem] = {
            "sha256": digest,
            "stations": summarize_document(document, day),
            "parameters": summarize_parameters(document, day),
        }
        print(f"Zaktualizowano indeks aktywności: {path.stem}")
    for missing in set(days) - available:
        del days[missing]
    index["parameters"] = build_parameter_history(days)
    temporary_path = index_path.with_suffix(".json.tmp")
    try:
        with temporary_path.open("w", encoding="utf-8") as output:
            json.dump(index, output, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary_path, index_path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    return index


def classify_activity(index, station_id, end):
    if end.tzinfo is None:
        raise ValueError("Koniec okresu musi zawierać strefę czasową.")
    start = end - timedelta(days=30)
    day = start.astimezone(LOCAL_TZ).date()
    last_day = end.astimezone(LOCAL_TZ).date()
    start_timestamp = start.timestamp()
    end_timestamp = end.timestamp()
    complete = True
    while day <= last_day:
        entry = index["days"].get(day.isoformat())
        stations = entry.get("stations") if isinstance(entry, dict) else None
        if not isinstance(stations, dict) or station_id not in stations:
            complete = False
        else:
            observed = stations[station_id]
            if observed is not None and observed[0] <= end_timestamp and observed[1] >= start_timestamp:
                return "active"
            if observed is not None and len(observed) > 2:
                complete = False
        day += timedelta(days=1)
    return "inactive" if complete else "unknown"


def update_catalog(index, catalog_path, snapshot_paths, now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("Bieżący czas musi zawierać strefę czasową.")
    paths = [Path(path) for path in snapshot_paths]
    documents = []
    for path in paths:
        with path.open(encoding="utf-8") as source:
            document = json.load(source)
        if document.get("type") != "FeatureCollection" or not isinstance(document.get("features"), list):
            raise ValueError(f"Nieprawidłowy plik danych stacji: {path}")
        documents.append(document)

    today = now.astimezone(LOCAL_TZ).date().isoformat()
    current = index["days"].get(today, {}).get("stations")
    if not isinstance(current, dict):
        raise ValueError(f"Brak aktualnych danych dla {today}; katalog nie został zmieniony.")
    latest = max(
        (value for observed in current.values() if observed is not None
         for value in observed[:2] if value <= now.timestamp()),
        default=None,
    )
    if latest is None:
        raise ValueError("Brak aktualnych pomiarów; katalog nie został zmieniony.")
    cutoff = datetime.fromtimestamp(latest, timezone.utc)
    current_hour = now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    can_close = cutoff >= current_hour - timedelta(hours=1)
    if not can_close:
        print("Pomiary są opóźnione; pominięto zamykanie stacji.")

    coordinates = {}
    for feature in documents[0]["features"]:
        properties = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        point = geometry.get("coordinates")
        if geometry.get("type") == "Point" and isinstance(point, list) and len(point) >= 2:
            coordinates[str(properties.get("Station_id"))] = point[:2]

    catalog_path = Path(catalog_path)
    workbook = load_workbook(catalog_path)
    sheet = workbook.active
    columns = {str(cell.value).strip(): cell.column for cell in sheet[1] if cell.value is not None}
    for name in ("Station_id", "Coordinates", "Status"):
        if name not in columns:
            raise ValueError(f"Brak kolumny {name} w katalogu stacji.")
    statuses = {}
    catalog_changed = False
    for row in sheet.iter_rows(min_row=2):
        station_value = row[columns["Station_id"] - 1].value
        if station_value is None:
            continue
        station_id = str(station_value).strip()
        status_cell = row[columns["Status"] - 1]
        old_status = str(status_cell.value or "").strip().upper()
        activity = classify_activity(index, station_id, cutoff)
        new_status = "ACTIVE" if activity == "active" else "CLOSED" if activity == "inactive" and can_close else old_status
        if new_status != old_status:
            status_cell.value = new_status
            catalog_changed = True
        statuses[station_id] = new_status
        coord_cell = row[columns["Coordinates"] - 1]
        if not coord_cell.value and station_id in coordinates:
            coord_cell.value = str(coordinates[station_id])
            catalog_changed = True

    changed_documents = []
    for path, document in zip(paths, documents):
        changed = False
        for feature in document["features"]:
            properties = feature.get("properties") or {}
            station_id = str(properties.get("Station_id"))
            if station_id in statuses and properties.get("Status") != statuses[station_id]:
                properties["Status"] = statuses[station_id]
                changed = True
        if changed:
            changed_documents.append((path, document))

    if catalog_changed:
        temporary = catalog_path.with_suffix(".tmp.xlsx")
        try:
            workbook.save(temporary)
            os.replace(temporary, catalog_path)
        finally:
            if temporary.exists():
                temporary.unlink()
    workbook.close()
    for path, document in changed_documents:
        temporary = path.with_suffix(path.suffix + ".tmp")
        try:
            with temporary.open("w", encoding="utf-8") as output:
                json.dump(document, output, ensure_ascii=False, indent=4)
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()
    print(f"Zaktualizowano katalog stacji i {len(changed_documents)} plików bieżących.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--update-catalog", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    data_dir = root / "imgw_data"
    index = update_history(data_dir)
    if args.update_catalog:
        today = datetime.now(LOCAL_TZ).date().isoformat()
        update_catalog(index, root / "all_stations.xlsx", [data_dir / f"{today}.geojson", root / "imgw_data.geojson"])
        update_history(data_dir)
