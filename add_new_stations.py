import requests
import pandas as pd
import shutil
from openpyxl import load_workbook

URL = "https://hydro-back.imgw.pl/map/stations/meteorologic?onlyMainStations=false"
EXCEL_FILE = "all_stations.xlsx"


def fetch_imgw_stations():
    response = requests.get(
        URL,
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=10
    )
    response.raise_for_status()

    data = response.json()
    stations = data.get("stations", [])

    return {
        str(station.get("id")): {
            "name": station.get("n"),
            "lon": station.get("lo"),
            "lat": station.get("la"),
        }
        for station in stations
        if station.get("id")
    }


def main():
    print("📄 Wczytywanie Excel...")
    df = pd.read_excel(EXCEL_FILE, dtype={"Station_id": str})
    existing_ids = set(df["Station_id"].dropna())

    print("🌐 Pobieranie stacji z IMGW...")
    imgw_stations = fetch_imgw_stations()

    missing_ids = set(imgw_stations.keys()) - existing_ids

    if not missing_ids:
        print("Brak nowych stacji.")
        return

    print(f"\n🚨 Nowe stacje do dodania: {len(missing_ids)}\n")

    # 🔒 Backup przed zmianą
    backup_file = EXCEL_FILE.replace(".xlsx", "_backup.xlsx")
    shutil.copy(EXCEL_FILE, backup_file)
    print(f"📦 Backup zapisany jako: {backup_file}")

    wb = load_workbook(EXCEL_FILE)
    ws = wb.active

    for sid in missing_ids:
        s = imgw_stations[sid]
        coords_str = f"[{s['lon']}, {s['lat']}]"

        print(f"{sid} | {s['name']} | {coords_str}")

        ws.append([
            sid,
            s["name"],
            coords_str,
            None,
            "ACTIVE"
        ])

    wb.save(EXCEL_FILE)

    print(f"\n✅ Dodano {len(missing_ids)} nowych stacji do {EXCEL_FILE}")
    print("📐 Szerokość kolumn została zachowana.")


if __name__ == "__main__":
    main()