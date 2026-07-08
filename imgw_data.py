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

# 🕒 Automatyczne pobieranie aktualnej daty w Polsce
local_tz = zoneinfo.ZoneInfo("Europe/Warsaw")
now_local = datetime.now(local_tz)

year = now_local.year
month = now_local.month
day = now_local.day

url = "https://danepubliczne.imgw.pl/api/data/meteo"
temperature_url_base = "https://hydro-back.imgw.pl/station/meteo/data?id="
przymrozki_url_base =  "https://agrometeo.imgw.pl/przymrozki/api?d="

def addZero(dataNumber):
    if dataNumber >= 10:
        return str(dataNumber)
    else:
        return "0" + str(dataNumber)
przymrozki_url = f"{przymrozki_url_base}{year}-{addZero(month)}-{addZero(day)}"

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

# Bezpieczny stały interwał (36 godzin) pozwalający pobrać pełny profil dobowy o każdej porze
hours_interval = 36

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
    if len(przymrozek_list) == 1:
        return przymrozek_list[0]
    for item in przymrozek_list:
        if item.get('lon') == lon and item.get('lat') == lat:
            return item
    return None

def extract_precip_data(temperature_data):
    precip_sum = None
    all_precips = None
    if temperature_data and isinstance(temperature_data.get("precip"), list) and len(temperature_data.get("precip")) > 0:
        valid_precips = []
        today_local = datetime.now(local_tz).date()

        for t in temperature_data.get("precip", []):
            if t["value"] is None or t["date"] is None:
                continue
            try:
                dt_utc = parser.isoparse(t["date"])
                dt_local = dt_utc.astimezone(local_tz)
                if dt_local.date() == today_local:
                    valid_precips.append(t)
            except Exception:
                continue
        if valid_precips:
            all_precips = valid_precips
            precip_sum = sum(t["value"] for t in valid_precips)
            
    return ExtractedPrecip(
        precip_sum=precip_sum,
        all_precips=all_precips,
        all_precip_amount=len(all_precips) if all_precips and isinstance(all_precips, list) else 0
    )

def extract_temperature_data(temperature_data, przymrozki_data, station_name, lon, lat):
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
                dt_utc = parser.isoparse(t["date"])
                dt_local = dt_utc.astimezone(local_tz)
                if dt_local.date() == today_local:
                    valid_temps.append(t)
            except Exception:
                continue
        if valid_temps:
            min_temp_entry = min(valid_temps, key=lambda t: t["value"])
            max_temp_entry = max(valid_temps, key=lambda t: t["value"])
            temp_min_h = min_temp_entry["value"]
            temp_min_h_time = min_temp_entry["date"]
            temp_max_h = max_temp_entry["value"]
            temp_max_h_time = max_temp_entry["date"]
            all_temps = valid_temps

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

async def fetch_json(session, url):
    try:
        async with session.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=5) as response:
            return await response.json() if response.status == 200 else None
    except Exception:
        return None

async def get_przymrozki_data_grouped_by_name(session):
    data = await fetch_przymrozki_json(przymrozki_url)
    if not data:
        return {}
    grouped_data = defaultdict(list)
    for item in data:
        name = item.get("name", "UNKNOWN")
        grouped_data[name].append(item)
    return grouped_data

async def process_station(session, data, przymrozki_data):
    temperature_url = f"{temperature_url_base}{data['kod_stacji']}&hoursInterval={hours_interval}"
    temperature_data = await fetch_json(session, temperature_url)

    extracted_temps = extract_temperature_data(temperature_data, przymrozki_data, data["nazwa_stacji"], data["lon"], data["lat"])
    extracted_precips = extract_precip_data(temperature_data)

    station_id = data["kod_stacji"]
    station_info = stations_map.get(station_id)

    if not station_info or not station_info["coordinates"]:
        return None

    coords = station_info["coordinates"]

    # Budowanie pełnej historii godzinowej dla dzisiejszego dnia (lokalny czas w Polsce)
    hourly_data = {f"{h:02d}": {} for h in range(24)}
    
    if temperature_data and isinstance(temperature_data.get("temperature"), list):
        for t in temperature_data["temperature"]:
            if t.get("value") is not None and t.get("date") is not None:
                try:
                    dt_utc = parser.isoparse(t["date"])
                    dt_local = dt_utc.astimezone(local_tz)
                    if dt_local.year == year and dt_local.month == month and dt_local.day == day:
                        hourly_data[f"{dt_local.hour:02d}"]["Ta"] = t["value"]
                except Exception:
                    continue

    if temperature_data and isinstance(temperature_data.get("precip"), list):
        for p in temperature_data["precip"]:
            if p.get("value") is not None and p.get("date") is not None:
                try:
                    dt_utc = parser.isoparse(p["date"])
                    dt_local = dt_utc.astimezone(local_tz)
                    if dt_local.year == year and dt_local.month == month and dt_local.day == day:
                        hourly_data[f"{dt_local.hour:02d}"]["Precip"] = p["value"]
                except Exception:
                    continue

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
        "Tg": float(data['temperatura_gruntu']) if data['temperatura_gruntu'] else None,
        "Tg_time": data['temperatura_gruntu_data'],
        "Wind_dir": float(data['wiatr_kierunek']) if data['wiatr_kierunek'] else None,
        "Wind_dir_time": data['wiatr_kierunek_data'],
        "Wind_avg": float(data['wiatr_srednia_predkosc']) if data['wiatr_srednia_predkosc'] else None,
        "Wind_avg_time": data['wiatr_srednia_predkosc_data'],
        "Wind_max": float(data['wiatr_predkosc_maksymalna']) if data['wiatr_predkosc_maksymalna'] else None,
        "Wind_max_time": data['wiatr_predkosc_maksymalna_data'],
        "RH": float(data['wilgotnosc_wzgledna']) if data['wilgotnosc_wzgledna'] else None,
        "RH_time": data['wilgotnosc_wzgledna_data'],
        "Wind_gust_10min": float(data['wiatr_poryw_10min']) if data['wiatr_poryw_10min'] else None,
        "Wind_gust_10min_time": data['wiatr_poryw_10min_data'],
        "Precip_10min": float(data['opad_10min']) if data['opad_10min'] else None,
        "Precip_10min_time": data['opad_10min_data'],
        "Precip_24h": getattr(extracted_precips, 'precip_sum', None) if extracted_precips else None,
        "Number_of_precip_measurements": getattr(extracted_precips, 'all_precip_amount', None) if extracted_precips else None,
        "Hourly": hourly_data
    }
    properties = {k: v for k, v in raw_properties.items() if v is not None}

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": coords},
        "properties": properties
    }

async def process_missing_station(session, station_info, przymrozki_data):
    temperature_url = f"{temperature_url_base}{station_info.get('Station_id')}&hoursInterval={hours_interval}"
    temperature_data = await fetch_json(session, temperature_url)

    extracted_temps = extract_temperature_data(temperature_data, przymrozki_data, station_info.get("Station_name"), station_info.get("coordinates")[0], station_info.get("coordinates")[1])
    extracted_precips = extract_precip_data(temperature_data)
    
    hourly_data = {f"{h:02d}": {} for h in range(24)}
    if temperature_data and isinstance(temperature_data.get("temperature"), list):
        for t in temperature_data["temperature"]:
            if t.get("value") is not None and t.get("date") is not None:
                try:
                    dt_utc = parser.isoparse(t["date"])
                    dt_local = dt_utc.astimezone(local_tz)
                    if dt_local.year == year and dt_local.month == month and dt_local.day == day:
                        hourly_data[f"{dt_local.hour:02d}"]["Ta"] = t["value"]
                except Exception:
                    continue

    if temperature_data and isinstance(temperature_data.get("precip"), list):
        for p in temperature_data["precip"]:
            if p.get("value") is not None and p.get("date") is not None:
                try:
                    dt_utc = parser.isoparse(p["date"])
                    dt_local = dt_utc.astimezone(local_tz)
                    if dt_local.year == year and dt_local.month == month and dt_local.day == day:
                        hourly_data[f"{dt_local.hour:02d}"]["Precip"] = p["value"]
                except Exception:
                    continue
         
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
        "Precip_24h": getattr(extracted_precips, 'precip_sum', None) if extracted_precips else None,
        "Number_of_precip_measurements": getattr(extracted_precips, 'all_precip_amount', None) if extracted_precips else None,
        "Hourly": hourly_data
    }
    properties = {k: v for k, v in raw_properties.items() if v is not None}

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": station_info.get("coordinates")},
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
        "geometry": {"type": "Point", "coordinates": station_info.get("coordinates")},
        "properties": properties
    }

async def main():
    async with aiohttp.ClientSession() as session:
        imgw_data = await fetch_json(session, url=url)
        if not imgw_data:
            print("Błąd pobierania danych IMGW.")
            return

        przymrozki_data = await get_przymrozki_data_grouped_by_name(session)
        if not przymrozki_data:
            print("Błąd pobierania danych przymrozków lub brak danych na dzisiaj.")
            przymrozki_data = None

        tasks = [process_station(session, data, przymrozki_data) for data in imgw_data]
        features = await tqdm_asyncio.gather(*tasks, desc="Pobieranie danych stacji")
        features = [f for f in features if f is not None]

        active_station_ids = {sid for sid, info in stations_map.items() if info["Status"] == "ACTIVE"}
        imgw_station_ids = {obj["kod_stacji"] for obj in imgw_data}
        missing_station_ids = active_station_ids - imgw_station_ids

        missing_stations = [stations_map[sid] for sid in missing_station_ids if stations_map[sid]["coordinates"]]

        if missing_stations:
            missing_tasks = [process_missing_station(session, station, przymrozki_data) for station in missing_stations]
            missing_features = await tqdm_asyncio.gather(*missing_tasks, desc="Pobieranie brakujących stacji")
            features.extend(missing_features)

        closed_stations = [station_info for station_info in stations_map.values() if station_info["Status"] == "CLOSED" and station_info.get("coordinates")]

        if closed_stations:
            closed_features = [process_closed_station(station_info) for station_info in closed_stations]
            features.extend(closed_features)

        date_str = f"{year}-{addZero(month)}-{addZero(day)}"
        out_dir = "imgw_data"
        os.makedirs(out_dir, exist_ok=True)

        dated_path = os.path.join(out_dir, f"{date_str}.geojson")
        latest_path = "imgw_data.geojson"

        payload = {"type": "FeatureCollection", "features": features}

        try:
            with open(dated_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=4)
        except Exception as e:
            print(f"Błąd zapisu datowanego pliku {dated_path}: {e}")

        try:
            with open(latest_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=4)
        except Exception as e:
            print(f"Błąd zapisu pliku {latest_path}: {e}")

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
            try:
                with open(dates_file, "w", encoding="utf-8") as df:
                    json.dump(dates, df, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"Błąd zapisu indeksu dat {dates_file}: {e}")

        print(f"Pliki zaktualizowane: {dated_path} oraz {latest_path}")

asyncio.run(main())