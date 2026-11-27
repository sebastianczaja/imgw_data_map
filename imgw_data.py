import asyncio
from collections import defaultdict
import aiohttp
import json
import pandas as pd
import math
from tqdm.asyncio import tqdm_asyncio
from datetime import datetime, timedelta, timezone
from dateutil import parser
import requests
import ast
import zoneinfo
import os
from hourly_utc import build_repeated_hour_utc_readings, merge_utc_readings

MAX_CONCURRENT_REQUESTS = 20
REQUEST_TIMEOUT_SECONDS = 15
MAX_FETCH_ATTEMPTS = 3
request_semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

# 🕒 Automatyczne pobieranie aktualnej daty w Polsce
local_tz = zoneinfo.ZoneInfo("Europe/Warsaw")
now_local = datetime.now(local_tz)

year = now_local.year
month = now_local.month
day = now_local.day

url = "https://danepubliczne.imgw.pl/api/data/meteo"
temperature_url_base = "https://hydro-back.imgw.pl/station/meteo/data?id="
station_metadata_url = "https://hydro-back.imgw.pl/list/meteo"
station_locations_url = "https://hydro-back.imgw.pl/map/stations/meteorologic?onlyMainStations=false"
przymrozki_url_base =  "https://agrometeo.imgw.pl/przymrozki/api?d="

def addZero(dataNumber):
    if dataNumber >= 10:
        return str(dataNumber)
    else:
        return "0" + str(dataNumber)
przymrozki_url = f"{przymrozki_url_base}{year}-{addZero(month)}-{addZero(day)}"

def parse_imgw_datetime(value):
    parsed_datetime = parser.isoparse(value)
    if parsed_datetime.tzinfo is None:
        return parsed_datetime.replace(tzinfo=local_tz)
    return parsed_datetime.astimezone(local_tz)

def extract_ground_temperature(data):
    value = data.get("temperatura_gruntu")
    timestamp = data.get("temperatura_gruntu_data")
    if value is None or timestamp is None:
        return None, None

    try:
        temperature = float(value)
        measured_at = parse_imgw_datetime(timestamp)
    except (TypeError, ValueError, OverflowError):
        return None, None

    age = datetime.now(local_tz) - measured_at
    if not math.isfinite(temperature) or age > timedelta(hours=24) or age < -timedelta(minutes=5):
        return None, None

    return temperature, timestamp


stations_df = pd.read_excel(
    "all_stations.xlsx",
    dtype={"Station_id": str}
)

def parse_coordinates(val):
    if pd.isna(val):
        return None
    if isinstance(val, (list, tuple)):
        return list(val)
    try:
        return list(ast.literal_eval(val))
    except Exception:
        try:
            lon, lat = val.split(",")
            return [float(lon), float(lat)]
        except Exception:
            return None

stations_df["Coordinates_parsed"] = stations_df["Coordinates"].apply(parse_coordinates)

stations_map = {
    row["Station_id"]: {
        "Station_id": row["Station_id"],
        "Station_name": None if pd.isna(row["Station_name"]) else row["Station_name"],
        "coordinates": row["Coordinates_parsed"],
        "Elevation": None if pd.isna(row["Elevation"]) else row["Elevation"],
        "Status": row["Status"]
    }
    for _, row in stations_df.iterrows()
}

# Ostatnia zakończona doba hydrologiczna może zaczynać się niemal 48 godzin temu.
hours_interval = 48

async def fetch_przymrozki_json(url):
    try:
        response = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=5)
        return json.loads(response.content.decode('ISO-8859-1')) if response.status_code == 200 else None
    except Exception:
        return None

class ExtractedTemps:
    def __init__(self, temp_current=None, temp_current_time=None, temp_min_h=None, temp_min_h_time=None, temp_max_h=None, temp_max_h_time=None, temp_min=None, temp_min_time=None, temp_max=None, temp_max_time=None, all_temps_amount=None, all_temps=None):
        self.temp_current = temp_current
        self.temp_current_time = temp_current_time
        self.temp_min_h = temp_min_h
        self.temp_min_h_time = temp_min_h_time
        self.temp_max_h = temp_max_h
        self.temp_max_h_time = temp_max_h_time
        self.temp_min = temp_min
        self.temp_min_time = temp_min_time
        self.temp_max = temp_max
        self.temp_max_time = temp_max_time
        self.all_temps_amount = all_temps_amount
        self.all_temps = all_temps

class ExtractedPrecip:
    def __init__(self, precip_sum=None, all_precip_amount=None, all_precips=None):
        self.precip_sum = precip_sum
        self.all_precip_amount = all_precip_amount
        self.all_precips = all_precips

def find_przymrozek(przymrozek_list, lon, lat):
    matches = []
    for item in przymrozek_list:
        try:
            item_lon = float(item.get("lon"))
            item_lat = float(item.get("lat"))
            station_lon = float(lon)
            station_lat = float(lat)
        except (TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in (item_lon, item_lat, station_lon, station_lat)):
            continue
        if math.isclose(item_lon, station_lon, rel_tol=0, abs_tol=0.00001) and math.isclose(
            item_lat, station_lat, rel_tol=0, abs_tol=0.00001
        ):
            matches.append(item)
    if len(matches) > 1:
        print(f"Niejednoznaczne dane przymrozków dla współrzędnych {lon}, {lat}.")
    return matches[0] if len(matches) == 1 else None

def get_synoptic_day_window():
    # Doba synoptyczna: 19:00-19:00 (zima) / 20:00-20:00 (lato) czasu lokalnego.
    now_utc = datetime.now(timezone.utc)
    end = now_utc.replace(hour=18, minute=0, second=0, microsecond=0)
    if end > now_utc:
        end -= timedelta(days=1)
    return end - timedelta(days=1), end

def get_precipitation_day_window():
    # Doba opadowa: 07:00-07:00 (zima) / 08:00-08:00 (lato) czasu lokalnego.
    now_utc = datetime.now(timezone.utc)
    end = now_utc.replace(hour=6, minute=0, second=0, microsecond=0)
    if end > now_utc:
        end -= timedelta(days=1)
    return end - timedelta(days=1), end

def get_synoptic_day_window_for_date(meteo_date):
    # Dane synoptyczne dla daty pliku koncza sie o 18:00 UTC tego dnia.
    end = datetime(
        meteo_date.year,
        meteo_date.month,
        meteo_date.day,
        18,
        tzinfo=timezone.utc,
    )
    return end - timedelta(days=1), end

def extract_wind_data(temperature_data):
    """Zwraca (max_porywu, srednia_predkosc) z bieżącej doby meteorologicznej."""
    wind = temperature_data.get("wind") if temperature_data else None
    if not isinstance(wind, dict):
        return None, None
    start, end = get_synoptic_day_window()

    def values_in_window(key):
        values = []
        for t in wind.get(key) or []:
            if t.get("value") is None or t.get("date") is None:
                continue
            try:
                dt_utc = parse_imgw_datetime(t["date"]).astimezone(timezone.utc)
            except Exception:
                continue
            if start <= dt_utc <= end:
                values.append(t["value"])
        return values

    gusts = values_in_window("maxVelocity")
    # Telemetria (10 min) i obserwacje (godzinowe) się dublują, więc używamy jednego źródła
    speeds = values_in_window("velocityTel") or values_in_window("velocityObs")
    return (max(gusts) if gusts else None,
            round(sum(speeds) / len(speeds), 1) if speeds else None)

def extract_precip_data(temperature_data, precipitation_window=None):
    precip_sum = None
    valid_precips = {}
    if temperature_data and isinstance(temperature_data.get("precip"), list):
        met_start, met_end = precipitation_window or get_precipitation_day_window()

        # Suma opadu: przedział (start, koniec], by pomiar graniczny nie liczył się podwójnie
        for t in temperature_data.get("precip", []):
            if not isinstance(t, dict) or t.get("value") is None or t.get("date") is None:
                continue
            try:
                dt_utc = parse_imgw_datetime(t["date"]).astimezone(timezone.utc)
                value = float(t["value"])
            except (TypeError, ValueError, OverflowError):
                continue
            if (met_start < dt_utc <= met_end and dt_utc.minute == 0
                    and dt_utc.second == 0 and dt_utc.microsecond == 0 and math.isfinite(value)):
                valid_precips[dt_utc] = (t, value)
        if len(valid_precips) == 24:
            precip_sum = sum(value for _, value in valid_precips.values())

    return ExtractedPrecip(
        precip_sum=precip_sum,
        all_precips=[row for row, _ in valid_precips.values()],
        all_precip_amount=len(valid_precips)
    )

def extract_temperature_data(temperature_data, przymrozki_data, station_name, lon, lat, meteo_date):
    temp_current = None
    temp_current_time = None
    temp_min_h = None
    temp_min_h_time = None
    temp_max_h = None
    temp_max_h_time = None
    temp_min = None
    temp_min_time = None
    temp_max = None
    temp_max_time = None
    all_temps = None

    if temperature_data and isinstance(temperature_data.get("temperature"), list) and len(temperature_data.get("temperature")) > 0:
        valid_temps = []
        today_local = datetime.now(local_tz).date()

        for t in temperature_data.get("temperature", []):
            if t.get("value") is None or t.get("date") is None:
                continue
            try:
                dt_local = parse_imgw_datetime(t["date"])
                if dt_local.date() == today_local:
                    valid_temps.append(t)
            except Exception:
                continue
        if valid_temps:
            all_temps = valid_temps

        met_start, met_end = get_synoptic_day_window_for_date(meteo_date)
        met_temps = []
        for t in temperature_data.get("temperature", []):
            if t.get("value") is None or t.get("date") is None:
                continue
            try:
                dt_utc = parse_imgw_datetime(t["date"]).astimezone(timezone.utc)
            except Exception:
                continue
            if met_start <= dt_utc <= met_end:
                met_temps.append(t)
        if met_temps:
            min_temp_entry = min(met_temps, key=lambda t: t["value"])
            max_temp_entry = max(met_temps, key=lambda t: t["value"])
            temp_min_h = min_temp_entry["value"]
            temp_min_h_time = min_temp_entry["date"]
            temp_max_h = max_temp_entry["value"]
            temp_max_h_time = max_temp_entry["date"]

        if przymrozki_data and przymrozki_data.get(station_name):
            przymrozki_list = przymrozki_data[station_name]
            if przymrozki_list:
                przymrozek = find_przymrozek(przymrozki_list, lon, lat)
                if przymrozek:
                    if przymrozek.get("temp_min_2m") is not None: temp_min = float(przymrozek["temp_min_2m"])
                    if przymrozek.get("temp_max_2m") is not None: temp_max = float(przymrozek["temp_max_2m"])

        # Pobieranie temperatury aktualnej: usunięto zbyt restrykcyjne filtry czasu, bierzemy najnowszą z bazy
        try:
            t = temperature_data["temperature"][-1]
            temp_current = t.get("value")
            temp_current_time = t.get("date")
        except Exception:
            pass

    return ExtractedTemps(
        temp_current=temp_current,
        temp_current_time=temp_current_time,
        temp_min_h=temp_min_h,
        temp_min_h_time=temp_min_h_time,
        temp_max_h=temp_max_h,
        temp_max_h_time=temp_max_h_time,
        temp_min=temp_min,
        temp_min_time=temp_min_time,
        temp_max=temp_max,
        temp_max_time=temp_max_time,
        all_temps=all_temps,
        all_temps_amount=len(all_temps) if all_temps and isinstance(all_temps, list) else 0
    )

async def fetch_json(session, url, headers=None):
    last_error = None
    for attempt in range(1, MAX_FETCH_ATTEMPTS + 1):
        try:
            async with request_semaphore:
                async with session.get(
                    url,
                    headers={"User-Agent": "Mozilla/5.0", **(headers or {})},
                    timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS),
                ) as response:
                    if response.status == 200:
                        return await response.json()

                    last_error = RuntimeError(f"HTTP {response.status}")
                    if response.status != 429 and response.status < 500:
                        break
        except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError) as error:
            last_error = error

        if attempt < MAX_FETCH_ATTEMPTS:
            await asyncio.sleep(attempt)

    raise RuntimeError(
        f"Nie udało się pobrać danych IMGW po {attempt} próbach: {url} "
        f"({type(last_error).__name__}: {last_error})"
    ) from last_error

def apply_station_elevations(stations, metadata):
    if not isinstance(metadata, list) or not metadata:
        raise ValueError("IMGW zwróciło nieprawidłową lub pustą listę metadanych stacji.")

    elevations = {}
    for record in metadata:
        if not isinstance(record, dict) or not record.get("code") or "altitude" not in record:
            raise ValueError("IMGW zwróciło nieprawidłowe metadane stacji.")
        station_id = str(record["code"])
        altitude = record["altitude"]
        if altitude is None:
            continue
        if isinstance(altitude, bool):
            raise ValueError(f"Nieprawidłowa wysokość stacji {station_id}: {altitude!r}")
        try:
            elevation = float(altitude)
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError(f"Nieprawidłowa wysokość stacji {station_id}: {altitude!r}") from error
        if not math.isfinite(elevation):
            raise ValueError(f"Nieprawidłowa wysokość stacji {station_id}: {altitude!r}")
        if station_id in elevations and elevations[station_id] != elevation:
            raise ValueError(f"Sprzeczne wysokości stacji {station_id} w danych IMGW.")
        elevations[station_id] = elevation

    matched = 0
    for station_id, station in stations.items():
        if station_id in elevations:
            station["Elevation"] = elevations[station_id]
            matched += 1
    return matched


def apply_station_coordinates(stations, metadata):
    if not isinstance(metadata, dict) or not isinstance(metadata.get("stations"), list):
        raise ValueError("IMGW zwróciło nieprawidłową listę współrzędnych stacji.")
    matched = 0
    for record in metadata["stations"]:
        if not isinstance(record, dict) or record.get("id") is None:
            continue
        station = stations.get(str(record["id"]))
        if not station or station.get("coordinates"):
            continue
        try:
            lon, lat = float(record["lo"]), float(record["la"])
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if not math.isfinite(lon) or not math.isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
            continue
        station["coordinates"] = [lon, lat]
        matched += 1
    return matched


async def gather_station_features(tasks, description):
    async def capture_result(task):
        try:
            return await task, None
        except Exception as error:
            return None, error

    results = await tqdm_asyncio.gather(
        *(capture_result(task) for task in tasks),
        desc=description
    )
    failures = [error for _, error in results if error is not None]
    if failures:
        for error in failures:
            print(f"Błąd pobierania stacji: {error}")
        raise RuntimeError(
            f"Przerwano aktualizację: {len(failures)} pobrań stacji zakończyło się błędem."
        ) from failures[0]

    return [result for result, _ in results]

async def get_przymrozki_data_grouped_by_name(session):
    data = await fetch_przymrozki_json(przymrozki_url)
    if not data:
        return {}
    grouped_data = defaultdict(list)
    for item in data:
        name = item.get("name", "UNKNOWN")
        grouped_data[name].append(item)
    return grouped_data

def fill_hourly_wind(temperature_data, hourly_data, target_date):
    """Dopisuje do historii godzinowej wybranego dnia (czas lokalny):
    Wind_avg - prędkość średnia z pomiaru godzinowego (velocityObs, w razie braku średnia z velocityTel w godzinie),
    Wind_max - największy poryw (maxVelocity) z godziny poprzedzającej pełną godzinę (h-1:00, h:00]."""
    wind = temperature_data.get("wind") if temperature_data else None
    if not isinstance(wind, dict):
        return

    def points(key):
        out = []
        for t in wind.get(key) or []:
            if t.get("value") is None or t.get("date") is None:
                continue
            try:
                out.append((parse_imgw_datetime(t["date"]), t["value"]))
            except Exception:
                continue
        return out

    def hour_slot(dt_local):
        return dt_local.replace(minute=0, second=0, microsecond=0)

    obs = {
        hour_slot(dt): v
        for dt, v in points("velocityObs")
        if dt.minute == 0 and dt.date() == target_date
    }
    tel_by_hour = defaultdict(list)
    gust_by_hour = defaultdict(list)
    for dt, v in points("velocityTel"):
        tel_by_hour[hour_slot(dt)].append(v)
    for dt, v in points("maxVelocity"):
        # pomiar o pełnej godzinie należy do godziny kończącej się o tej godzinie
        slot = hour_slot(dt)
        if dt.minute:
            slot = slot + timedelta(hours=1)
        gust_by_hour[slot].append(v)

    for h in range(24):
        slot = datetime(
            target_date.year,
            target_date.month,
            target_date.day,
            hour=h,
            tzinfo=local_tz,
        )
        if slot in obs:
            hourly_data[f"{h:02d}"]["Wind_avg"] = obs[slot]
        elif tel_by_hour.get(slot):
            hourly_data[f"{h:02d}"]["Wind_avg"] = round(sum(tel_by_hour[slot]) / len(tel_by_hour[slot]), 1)
        if gust_by_hour.get(slot):
            hourly_data[f"{h:02d}"]["Wind_max"] = max(gust_by_hour[slot])

def build_hourly_data(temperature_data, target_date):
    hourly_data = {f"{hour:02d}": {} for hour in range(24)}
    for source_key, parameter_key in (("temperature", "Ta"), ("precip", "Precip")):
        readings = temperature_data.get(source_key)
        if not isinstance(readings, list):
            continue
        for reading in readings:
            if not isinstance(reading, dict):
                continue
            if reading.get("value") is None or reading.get("date") is None:
                continue
            try:
                measured_at = parse_imgw_datetime(reading["date"])
            except (TypeError, ValueError, OverflowError):
                continue
            if measured_at.date() == target_date:
                hourly_data[f"{measured_at.hour:02d}"][parameter_key] = reading["value"]

    fill_hourly_wind(temperature_data, hourly_data, target_date)
    for hour, readings in build_repeated_hour_utc_readings(temperature_data, target_date).items():
        hourly_data[hour]["UTC"] = readings
    return hourly_data

def has_hourly_readings(hourly_data):
    return any(values for values in hourly_data.values())

def add_missing_hourly_readings(document, readings_by_station):
    additions = 0
    for feature in document.get("features", []):
        properties = feature.get("properties", {})
        station_readings = readings_by_station.get(str(properties.get("Station_id")), {})
        hourly = properties.get("Hourly")
        if not station_readings:
            continue
        if not isinstance(hourly, dict):
            hourly = {}
            properties["Hourly"] = hourly

        for hour_key, parameters in station_readings.items():
            hour = hourly.setdefault(hour_key, {})
            for parameter_key, value in parameters.items():
                if parameter_key == "UTC":
                    additions += merge_utc_readings(hour, value)
                    continue
                if hour.get(parameter_key) is None or hour.get(parameter_key) == "":
                    hour[parameter_key] = value
                    additions += 1
    return additions

def update_daily_precipitation_readings(document, readings_by_station):
    updates = 0
    for feature in document.get("features", []):
        properties = feature.get("properties", {})
        station_values = readings_by_station.get(str(properties.get("Station_id")))
        if not station_values:
            continue
        if (station_values.get("Precip_24h") is None
                and properties.get("Number_of_precip_measurements") == 24
                and properties.get("Precip_24h") is not None):
            continue
        for parameter_key, value in station_values.items():
            if value is None:
                if parameter_key in properties:
                    del properties[parameter_key]
                    updates += 1
            elif properties.get(parameter_key) != value:
                properties[parameter_key] = value
                updates += 1
    return updates

def update_archive_file(file_path, features, hourly_readings, daily_readings):
    if not hourly_readings and not daily_readings:
        return 0
    if not os.path.isfile(file_path):
        if daily_readings:
            print(f"Nie przypisano opadu: brak pliku archiwum {file_path}.")
        return 0

    with open(file_path, "r", encoding="utf-8") as source:
        document = json.load(source)
    additions = add_missing_hourly_readings(document, hourly_readings)
    additions += update_daily_precipitation_readings(document, daily_readings)
    existing_ids = {
        str(feature.get("properties", {}).get("Station_id"))
        for feature in document.get("features", [])
    }
    for feature in features:
        properties = feature.get("properties", {})
        station_id = str(properties.get("Station_id"))
        station_hourly = hourly_readings.get(station_id)
        station_daily = daily_readings.get(station_id)
        has_daily_readings = station_daily and station_daily.get("Number_of_precip_measurements", 0) > 0
        if station_id in existing_ids or not (station_hourly or has_daily_readings):
            continue

        previous_properties = {
            key: properties[key]
            for key in ("Station_id", "Station_name", "Status", "Elevation")
            if key in properties
        }
        if station_hourly:
            previous_properties["Hourly"] = station_hourly
        if station_daily:
            previous_properties.update({key: value for key, value in station_daily.items() if value is not None})
        document.setdefault("features", []).append({
            "type": "Feature",
            "geometry": feature.get("geometry"),
            "properties": previous_properties,
        })
        existing_ids.add(station_id)
        additions += 1

    if additions:
        temporary_path = f"{file_path}.tmp"
        try:
            with open(temporary_path, "w", encoding="utf-8") as destination:
                json.dump(document, destination, ensure_ascii=False, indent=4)
            os.replace(temporary_path, file_path)
        finally:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)
    return additions

async def process_station(
    session, data, przymrozki_data, previous_date, previous_day_readings,
    previous_day_precipitation, precipitation_window=None
):
    temperature_url = f"{temperature_url_base}{data['kod_stacji']}&hoursInterval={hours_interval}"
    temperature_data = await fetch_json(session, temperature_url)
    if not isinstance(temperature_data, dict) or not any(
        key in temperature_data for key in ("temperature", "precip", "wind")
    ):
        raise ValueError(
            f"IMGW zwróciło nieprawidłowy profil stacji {data['kod_stacji']}."
        )

    extracted_temps = extract_temperature_data(
        temperature_data,
        przymrozki_data,
        data["nazwa_stacji"],
        data["lon"],
        data["lat"],
        now_local.date(),
    )
    extracted_precips = extract_precip_data(temperature_data, precipitation_window)
    if isinstance(temperature_data.get("precip"), list):
        previous_day_precipitation[str(data["kod_stacji"])] = {
            "Precip_24h": extracted_precips.precip_sum,
            "Number_of_precip_measurements": extracted_precips.all_precip_amount,
        }
    wind_max_day, wind_avg_day = extract_wind_data(temperature_data)
    ground_temp, ground_temp_time = extract_ground_temperature(data)

    station_id = data["kod_stacji"]
    station_info = stations_map.get(station_id)

    if not station_info:
        return None

    coords = station_info["coordinates"]

    # Budowanie pełnej historii godzinowej dla dzisiejszego dnia (lokalny czas w Polsce)
    hourly_data = build_hourly_data(temperature_data, now_local.date())
    previous_hourly_data = build_hourly_data(temperature_data, previous_date)
    if has_hourly_readings(previous_hourly_data):
        previous_day_readings[str(station_info["Station_id"])] = previous_hourly_data

    raw_properties = {
        "Station_id": station_id,
        "Station_name": station_info["Station_name"],
        "Status": station_info["Status"],
        "Elevation": station_info["Elevation"],
        "Ta": getattr(extracted_temps, 'temp_current', None) if extracted_temps else None,
        "Ta_time": getattr(extracted_temps, 'temp_current_time', None) if extracted_temps else None,
        "Tmin_hour": getattr(extracted_temps, 'temp_min_h', None) if extracted_temps else None,
        "Tmin_hour_time": getattr(extracted_temps, 'temp_min_h_time', None) if extracted_temps else None,
        "Tmax_hour": getattr(extracted_temps, 'temp_max_h', None) if extracted_temps else None,
        "Tmax_hour_time": getattr(extracted_temps, 'temp_max_h_time', None) if extracted_temps else None,
        "Tmin": getattr(extracted_temps, 'temp_min', None) if extracted_temps else None,
        "Tmin_time": getattr(extracted_temps, 'temp_min_time', None) if extracted_temps else None,
        "Tmax": getattr(extracted_temps, 'temp_max', None) if extracted_temps else None,
        "Tmax_time": getattr(extracted_temps, 'temp_max_time', None) if extracted_temps else None,
        "Number_of_measurements": getattr(extracted_temps, 'all_temps_amount', None) if extracted_temps else None,
        "Tg": ground_temp,
        "Tg_time": ground_temp_time,
        "Wind_dir": float(data['wiatr_kierunek']) if data['wiatr_kierunek'] else None,
        "Wind_dir_time": data['wiatr_kierunek_data'],
        "Wind_avg": wind_avg_day if wind_avg_day is not None else (float(data['wiatr_srednia_predkosc']) if data['wiatr_srednia_predkosc'] else None),
        "Wind_avg_time": data['wiatr_srednia_predkosc_data'],
        "Wind_max": wind_max_day if wind_max_day is not None else (float(data['wiatr_predkosc_maksymalna']) if data['wiatr_predkosc_maksymalna'] else None),
        "Wind_max_time": data['wiatr_predkosc_maksymalna_data'],
        "RH": float(data['wilgotnosc_wzgledna']) if data['wilgotnosc_wzgledna'] else None,
        "RH_time": data['wilgotnosc_wzgledna_data'],
        "Wind_gust_10min": float(data['wiatr_poryw_10min']) if data['wiatr_poryw_10min'] else None,
        "Wind_gust_10min_time": data['wiatr_poryw_10min_data'],
        "Precip_10min": float(data['opad_10min']) if data['opad_10min'] else None,
        "Precip_10min_time": data['opad_10min_data'],
        "Hourly": hourly_data
    }
    properties = {k: v for k, v in raw_properties.items() if v is not None}
    if station_info["Status"] == "CLOSED":
        properties["Activity_checked"] = True

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": coords} if coords else None,
        "properties": properties
    }

async def process_missing_station(
    session, station_info, przymrozki_data, previous_date, previous_day_readings,
    previous_day_precipitation, precipitation_window=None
):
    temperature_url = f"{temperature_url_base}{station_info.get('Station_id')}&hoursInterval={hours_interval}"
    temperature_data = await fetch_json(session, temperature_url)
    if not isinstance(temperature_data, dict) or not any(
        key in temperature_data for key in ("temperature", "precip", "wind")
    ):
        raise ValueError(
            f"IMGW zwróciło nieprawidłowy profil stacji {station_info.get('Station_id')}."
        )

    coordinates = station_info.get("coordinates")
    extracted_temps = extract_temperature_data(
        temperature_data,
        przymrozki_data if coordinates else None,
        station_info.get("Station_name"),
        coordinates[0] if coordinates else None,
        coordinates[1] if coordinates else None,
        now_local.date(),
    )
    extracted_precips = extract_precip_data(temperature_data, precipitation_window)
    if isinstance(temperature_data.get("precip"), list):
        previous_day_precipitation[str(station_info.get("Station_id"))] = {
            "Precip_24h": extracted_precips.precip_sum,
            "Number_of_precip_measurements": extracted_precips.all_precip_amount,
        }
    wind_max_day, wind_avg_day = extract_wind_data(temperature_data)
    
    hourly_data = build_hourly_data(temperature_data, now_local.date())
    previous_hourly_data = build_hourly_data(temperature_data, previous_date)
    if has_hourly_readings(previous_hourly_data):
        previous_day_readings[str(station_info.get("Station_id"))] = previous_hourly_data

    raw_properties = {
        "Station_id": station_info.get("Station_id"),
        "Station_name": station_info.get("Station_name"),
        "Status": station_info["Status"],
        "Elevation": station_info["Elevation"],
        "Ta": getattr(extracted_temps, 'temp_current', None) if extracted_temps else None,
        "Ta_time": getattr(extracted_temps, 'temp_current_time', None) if extracted_temps else None,
        "Tmin_hour": getattr(extracted_temps, 'temp_min_h', None) if extracted_temps else None,
        "Tmin_hour_time": getattr(extracted_temps, 'temp_min_h_time', None) if extracted_temps else None,
        "Tmax_hour": getattr(extracted_temps, 'temp_max_h', None) if extracted_temps else None,
        "Tmax_hour_time": getattr(extracted_temps, 'temp_max_h_time', None) if extracted_temps else None,
        "Tmin": getattr(extracted_temps, 'temp_min', None) if extracted_temps else None,
        "Tmin_time": getattr(extracted_temps, 'temp_min_time', None) if extracted_temps else None,
        "Tmax": getattr(extracted_temps, 'temp_max', None) if extracted_temps else None,
        "Tmax_time": getattr(extracted_temps, 'temp_max_time', None) if extracted_temps else None,
        "Number_of_measurements": getattr(extracted_temps, 'all_temps_amount', None) if extracted_temps else None,
        "Wind_avg": wind_avg_day,
        "Wind_max": wind_max_day,
        "Hourly": hourly_data
    }
    properties = {k: v for k, v in raw_properties.items() if v is not None}
    if station_info["Status"] == "CLOSED":
        properties["Activity_checked"] = True

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": coordinates} if coordinates else None,
        "properties": properties
    }

def process_closed_station(station_info):
    raw_properties = {
        "Station_id": station_info.get("Station_id"),
        "Station_name": station_info.get("Station_name"),
        "Status": station_info["Status"],
        "Elevation": station_info["Elevation"],
    }
    properties = {k: v for k, v in raw_properties.items() if v is not None}

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": station_info["coordinates"]} if station_info.get("coordinates") else None,
        "properties": properties
    }


async def check_closed_station(
    session, station_info, przymrozki_data, previous_date, previous_day_readings,
    previous_feature=None, previous_day_precipitation=None, precipitation_window=None
):
    if previous_day_precipitation is None:
        previous_day_precipitation = {}
    try:
        return await process_missing_station(
            session, station_info, przymrozki_data, previous_date, previous_day_readings,
            previous_day_precipitation, precipitation_window
        )
    except (RuntimeError, ValueError) as error:
        print(f"Nie udało się sprawdzić zamkniętej stacji {station_info['Station_id']}: {error}")
        feature = previous_feature if previous_feature is not None else process_closed_station(station_info)
        feature["properties"]["Activity_check_failed"] = True
        return feature


async def main():
    previous_date = now_local.date() - timedelta(days=1)
    previous_date_str = previous_date.isoformat()
    precipitation_window = get_precipitation_day_window()
    precipitation_start, _ = precipitation_window
    precipitation_date_str = precipitation_start.date().isoformat()
    previous_date_path = os.path.join(
        "imgw_data", f"{previous_date_str}.geojson"
    )
    precipitation_date_path = os.path.join(
        "imgw_data", f"{precipitation_date_str}.geojson"
    )
    previous_day_readings = {}
    previous_day_precipitation = {}
    date_str = f"{year}-{addZero(month)}-{addZero(day)}"
    dated_path = os.path.join("imgw_data", f"{date_str}.geojson")
    previous_features = {}
    if os.path.isfile(dated_path):
        with open(dated_path, encoding="utf-8") as source:
            previous_payload = json.load(source)
        previous_features = {
            str(feature["properties"]["Station_id"]): feature
            for feature in previous_payload.get("features", [])
            if feature.get("properties", {}).get("Station_id") is not None
        }

    async with aiohttp.ClientSession() as session:
        station_metadata = await fetch_json(
            session,
            station_metadata_url,
            headers={"Origin": "https://hydro.imgw.pl", "Referer": "https://hydro.imgw.pl/"},
        )
        matched_elevations = apply_station_elevations(stations_map, station_metadata)
        unavailable_elevations = sum(
            info["Elevation"] is None for info in stations_map.values() if info["Status"] == "ACTIVE"
        )
        print(
            f"Pobrano wysokości IMGW dla {matched_elevations} stacji; "
            f"brak wysokości dla {unavailable_elevations} aktywnych stacji."
        )
        imgw_data = await fetch_json(session, url=url)
        if not imgw_data:
            raise RuntimeError("IMGW zwróciło pustą listę danych stacji.")
        try:
            locations = await fetch_json(session, station_locations_url)
            matched_coordinates = apply_station_coordinates(stations_map, locations)
            print(f"Uzupełniono współrzędne {matched_coordinates} stacji z IMGW.")
        except (RuntimeError, ValueError) as error:
            print(f"Nie udało się uzupełnić współrzędnych stacji: {error}")

        przymrozki_data = await get_przymrozki_data_grouped_by_name(session)
        if not przymrozki_data:
            print("Błąd pobierania danych przymrozków lub brak danych na dzisiaj.")
            przymrozki_data = None

        tasks = [
            process_station(
                session, data, przymrozki_data, previous_date, previous_day_readings,
                previous_day_precipitation, precipitation_window
            )
            for data in imgw_data
        ]
        features = await gather_station_features(tasks, "Pobieranie danych stacji")
        features = [f for f in features if f is not None]

        active_station_ids = {sid for sid, info in stations_map.items() if info["Status"] == "ACTIVE"}
        imgw_station_ids = {obj["kod_stacji"] for obj in imgw_data}
        missing_station_ids = active_station_ids - imgw_station_ids

        missing_stations = [stations_map[sid] for sid in missing_station_ids]

        if missing_stations:
            missing_tasks = [
                process_missing_station(
                    session,
                    station,
                    przymrozki_data,
                    previous_date,
                    previous_day_readings,
                    previous_day_precipitation,
                    precipitation_window,
                )
                for station in missing_stations
            ]
            missing_features = await gather_station_features(
                missing_tasks,
                "Pobieranie brakujących stacji"
            )
            features.extend(missing_features)

        closed_stations = [
            station_info for sid, station_info in stations_map.items()
            if station_info["Status"] == "CLOSED" and sid not in imgw_station_ids
        ]
        if closed_stations:
            closed_tasks = [
                check_closed_station(
                    session, station, przymrozki_data, previous_date, previous_day_readings,
                    previous_features.get(str(station["Station_id"])),
                    previous_day_precipitation, precipitation_window
                )
                for station in closed_stations
            ]
            features.extend(await gather_station_features(closed_tasks, "Sprawdzanie zamkniętych stacji"))

        out_dir = "imgw_data"
        os.makedirs(out_dir, exist_ok=True)

        latest_path = "imgw_data.geojson"

        payload = {"type": "FeatureCollection", "features": features}

        with open(dated_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=4)

        with open(latest_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=4)

        archive_updates = {}
        for archive_path, hourly, daily in (
            (previous_date_path, previous_day_readings, {}),
            (precipitation_date_path, {}, previous_day_precipitation),
        ):
            update = archive_updates.setdefault(archive_path, {"hourly": {}, "daily": {}})
            update["hourly"].update(hourly)
            update["daily"].update(daily)

        for archive_path, update in archive_updates.items():
            additions = update_archive_file(
                archive_path, features, update["hourly"], update["daily"]
            )
            if additions:
                print(f"Uzupełniono {additions} pomiarów w pliku {archive_path}.")

        dates_file = os.path.join(out_dir, "dates.json")
        dates = []
        try:
            if os.path.isfile(dates_file):
                with open(dates_file, "r", encoding="utf-8") as df:
                    data = json.load(df)
                    if isinstance(data, list):
                        dates = data
        except Exception:
            dates = []

        if date_str not in dates:
            dates.append(date_str)
            dates = sorted(dates, reverse=True)
            with open(dates_file, "w", encoding="utf-8") as df:
                json.dump(dates, df, ensure_ascii=False, indent=2)

        print(f"Pliki zaktualizowane: {dated_path} oraz {latest_path}")

if __name__ == "__main__":
    asyncio.run(main())