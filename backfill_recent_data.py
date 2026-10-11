import concurrent.futures
from datetime import date, datetime, timedelta
import json
import math
import os
from pathlib import Path
import time
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


LOCAL_TZ = ZoneInfo("Europe/Warsaw")
HOURS_INTERVAL = 1008
MAX_WORKERS = 10
TEMPERATURE_URL_BASE = "https://hydro-back.imgw.pl/station/meteo/data?id="


def fetch_station_history(station_id, target_dates):
    url = (
        f"{TEMPERATURE_URL_BASE}{quote(station_id, safe='')}"
        f"&hoursInterval={HOURS_INTERVAL}"
    )
    last_error = None

    for attempt in range(3):
        try:
            request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(request, timeout=45) as response:
                payload = json.load(response)

            if not isinstance(payload, dict):
                raise ValueError("API response is not a JSON object")

            readings = {}
            for source_key, parameter_key in (
                ("temperature", "Ta"),
                ("precip", "Precip"),
            ):
                rows = payload.get(source_key)
                if rows is None:
                    continue
                if not isinstance(rows, list):
                    raise ValueError(f"API field {source_key} is not a list")

                for row in rows:
                    if not isinstance(row, dict) or row.get("date") is None:
                        continue
                    if row.get("value") is None:
                        continue

                    timestamp = datetime.fromisoformat(
                        row["date"].replace("Z", "+00:00")
                    )
                    if timestamp.tzinfo is None:
                        raise ValueError("API returned a timezone-naive timestamp")

                    local_timestamp = timestamp.astimezone(LOCAL_TZ)
                    date_key = local_timestamp.date().isoformat()
                    if date_key not in target_dates:
                        continue

                    value = float(row["value"])
                    if not math.isfinite(value):
                        continue

                    hour_key = f"{local_timestamp.hour:02d}"
                    readings.setdefault(date_key, {}).setdefault(hour_key, {})[
                        parameter_key
                    ] = value

            wind = payload.get("wind")
            if isinstance(wind, dict):
                wind_points = {}
                for source_key in ("velocityObs", "velocityTel", "maxVelocity"):
                    points = []
                    for row in wind.get(source_key) or []:
                        if not isinstance(row, dict) or row.get("date") is None:
                            continue
                        if row.get("value") is None:
                            continue

                        timestamp = datetime.fromisoformat(
                            row["date"].replace("Z", "+00:00")
                        )
                        if timestamp.tzinfo is None:
                            raise ValueError("API returned a timezone-naive timestamp")
                        local_timestamp = timestamp.astimezone(LOCAL_TZ)
                        date_key = local_timestamp.date().isoformat()
                        if date_key not in target_dates:
                            continue

                        value = float(row["value"])
                        if math.isfinite(value):
                            points.append((local_timestamp, value))
                    wind_points[source_key] = points

                hourly_wind = {}
                for timestamp, value in wind_points["velocityObs"]:
                    if timestamp.minute == 0:
                        key = (timestamp.date().isoformat(), timestamp.hour)
                        hourly_wind.setdefault(key, {})["Wind_avg"] = value

                telemetry_by_hour = {}
                for timestamp, value in wind_points["velocityTel"]:
                    key = (timestamp.date().isoformat(), timestamp.hour)
                    telemetry_by_hour.setdefault(key, []).append(value)

                for key, values in telemetry_by_hour.items():
                    hourly_wind.setdefault(key, {}).setdefault(
                        "Wind_avg", round(sum(values) / len(values), 1)
                    )

                gusts_by_hour = {}
                for timestamp, value in wind_points["maxVelocity"]:
                    hour = timestamp.hour + (1 if timestamp.minute else 0)
                    date_key = timestamp.date().isoformat()
                    if hour == 24:
                        next_date = timestamp.date() + timedelta(days=1)
                        date_key = next_date.isoformat()
                        hour = 0
                    if date_key in target_dates:
                        key = (date_key, hour)
                        gusts_by_hour.setdefault(key, []).append(value)

                for key, values in gusts_by_hour.items():
                    hourly_wind.setdefault(key, {})["Wind_max"] = max(values)

                for (date_key, hour), parameters in hourly_wind.items():
                    readings.setdefault(date_key, {}).setdefault(
                        f"{hour:02d}", {}
                    ).update(parameters)

            return station_id, readings, None
        except (OSError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
            last_error = error
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))

    return station_id, {}, f"{type(last_error).__name__}: {last_error}"


def add_missing_readings(document, station_readings, counts):
    for feature in document.get("features", []):
        properties = feature.get("properties", {})
        if properties.get("Status") != "ACTIVE":
            continue

        hourly = properties.get("Hourly")
        hourly_readings = station_readings.get(str(properties.get("Station_id")), {})
        if not isinstance(hourly, dict):
            continue

        for hour_key, parameters in hourly_readings.items():
            hour = hourly.get(hour_key)
            if not isinstance(hour, dict):
                continue

            for parameter_key, value in parameters.items():
                if hour.get(parameter_key) is None or hour.get(parameter_key) == "":
                    hour[parameter_key] = value
                    counts.setdefault(hour_key, {}).setdefault(parameter_key, 0)
                    counts[hour_key][parameter_key] += 1


def main():
    root = Path(__file__).resolve().parent
    data_dir = root / "imgw_data"
    dates_path = data_dir / "dates.json"
    with dates_path.open(encoding="utf-8") as dates_file:
        available_dates = json.load(dates_file)
    if not isinstance(available_dates, list):
        raise ValueError(f"{dates_path} must contain a JSON array")

    today = datetime.now(LOCAL_TZ).date()
    cutoff = today - timedelta(days=HOURS_INTERVAL // 24 - 1)
    target_dates = set()
    documents = {}
    missing_files = []

    for date_value in available_dates:
        if not isinstance(date_value, str):
            continue
        try:
            file_date = date.fromisoformat(date_value)
        except ValueError:
            continue
        if not cutoff <= file_date <= today:
            continue

        file_path = data_dir / f"{date_value}.geojson"
        if not file_path.is_file():
            missing_files.append(date_value)
            continue
        with file_path.open(encoding="utf-8") as data_file:
            documents[date_value] = json.load(data_file)
        target_dates.add(date_value)

    if not target_dates:
        raise RuntimeError("No dated GeoJSON files found in the six-week window")

    station_ids = sorted(
        {
            str(feature["properties"]["Station_id"])
            for document in documents.values()
            for feature in document.get("features", [])
            if feature.get("properties", {}).get("Status") == "ACTIVE"
            and feature.get("properties", {}).get("Station_id") is not None
        }
    )
    if not station_ids:
        raise RuntimeError("No active station IDs found in recent GeoJSON files")

    readings_by_station = {}
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {
            executor.submit(fetch_station_history, station_id, target_dates): station_id
            for station_id in station_ids
        }
        for future in concurrent.futures.as_completed(futures):
            station_id, readings, error = future.result()
            if error:
                failures.append((station_id, error))
            else:
                readings_by_station[station_id] = readings

    if not readings_by_station:
        raise RuntimeError(
            f"No station history could be fetched; first errors: {failures[:10]}"
        )

    latest_document = None
    latest_path = root / "imgw_data.geojson"
    today_key = today.isoformat()
    if today_key in documents and latest_path.is_file():
        with latest_path.open(encoding="utf-8") as latest_file:
            latest_document = json.load(latest_file)

    additions_by_date = {date_key: {} for date_key in target_dates}
    documents_to_write = dict(documents)
    for date_key, document in documents.items():
        date_readings = {
            station_id: readings.get(date_key, {})
            for station_id, readings in readings_by_station.items()
            if date_key in readings
        }
        add_missing_readings(
            document,
            date_readings,
            additions_by_date[date_key],
        )

    if latest_document is not None:
        add_missing_readings(
            latest_document,
            {
                station_id: readings.get(today_key, {})
                for station_id, readings in readings_by_station.items()
                if today_key in readings
            },
            additions_by_date[today_key],
        )

    changed_dates = [
        date_key
        for date_key, counts in additions_by_date.items()
        if any(counts_by_parameter for counts_by_parameter in counts.values())
    ]
    if not changed_dates:
        print("Recent GeoJSON files already contain all available IMGW readings.")
    else:
        temporary_files = []
        try:
            for date_key in changed_dates:
                file_path = data_dir / f"{date_key}.geojson"
                temporary_path = file_path.with_name(file_path.name + ".backfill-tmp")
                temporary_path.write_text(
                    json.dumps(documents_to_write[date_key], ensure_ascii=False, indent=4),
                    encoding="utf-8",
                )
                with temporary_path.open(encoding="utf-8") as temporary_file:
                    json.load(temporary_file)
                temporary_files.append((temporary_path, file_path))

            if latest_document is not None and today_key in changed_dates:
                temporary_path = latest_path.with_name(latest_path.name + ".backfill-tmp")
                temporary_path.write_text(
                    json.dumps(latest_document, ensure_ascii=False, indent=4),
                    encoding="utf-8",
                )
                with temporary_path.open(encoding="utf-8") as temporary_file:
                    json.load(temporary_file)
                temporary_files.append((temporary_path, latest_path))

            for temporary_path, file_path in temporary_files:
                os.replace(temporary_path, file_path)
        finally:
            for temporary_path, _ in temporary_files:
                if temporary_path.exists():
                    temporary_path.unlink()

        for date_key in changed_dates:
            print(f"{date_key}: {json.dumps(additions_by_date[date_key], sort_keys=True)}")

    print(
        f"IMGW history checked: {len(station_ids)} stations, "
        f"{len(readings_by_station)} successful responses, "
        f"{len(target_dates)} daily files."
    )
    if missing_files:
        print(f"Missing dated files skipped: {', '.join(missing_files)}")
    if failures:
        print(
            f"History unavailable for {len(failures)} stations; "
            f"first failures: {failures[:20]}"
        )


if __name__ == "__main__":
    main()
