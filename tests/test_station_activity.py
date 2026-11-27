import json
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch
import asyncio

from openpyxl import Workbook, load_workbook

import imgw_data
from station_activity import (
    LOCAL_TZ, build_parameter_history, classify_activity, summarize_document,
    summarize_parameters, update_catalog, update_history,
)


class StationActivityTests(unittest.TestCase):
    def test_summary_uses_real_measurements_and_merges_duplicate_stations(self):
        day = date(2026, 11, 24)
        document = {"features": [
            {"properties": {"Station_id": "1", "Hourly": {"00": {"Precip": 0}, "23": {}}}},
            {"properties": {"Station_id": "1", "Hourly": {"12": {"Ta": 2}}}},
            {"properties": {"Station_id": "2", "RH": 80, "RH_time": "2026-11-24 13:15:00"}},
            {"properties": {"Station_id": "3", "RH": 80, "RH_time": "2025-11-24 13:15:00"}},
            {"properties": {"Station_id": "4", "Hourly": {"03": {"UTC": {"x": {}}}}}},
            {"properties": {"Station_id": "5", "Activity_check_failed": True}},
            {"properties": {"Station_id": "6", "Status": "CLOSED"}},
            {"properties": {"Station_id": "7", "Status": "CLOSED", "Activity_checked": True}},
        ]}
        stations = summarize_document(document, day)
        self.assertEqual(stations["1"], [
            int(datetime(2026, 11, 24, 0, tzinfo=LOCAL_TZ).timestamp()),
            int(datetime(2026, 11, 24, 12, tzinfo=LOCAL_TZ).timestamp()),
        ])
        self.assertEqual(stations["2"][0], int(datetime(2026, 11, 24, 13, 15, tzinfo=LOCAL_TZ).timestamp()))
        self.assertIsNone(stations["3"])
        self.assertIsNone(stations["4"])
        self.assertNotIn("5", stations)
        self.assertNotIn("6", stations)
        self.assertIsNone(stations["7"])

    def test_thirty_day_window_and_missing_history(self):
        end = datetime(2026, 11, 24, 6, tzinfo=timezone.utc)
        start = end - timedelta(days=30)
        first = start.astimezone(LOCAL_TZ).date()
        last = end.astimezone(LOCAL_TZ).date()
        days = {}
        day = first
        while day <= last:
            days[day.isoformat()] = {"stations": {"1": None}}
            day += timedelta(days=1)
        index = {"days": days}
        self.assertEqual(classify_activity(index, "1", end), "inactive")
        days[first.isoformat()]["stations"]["1"] = [int(start.timestamp()) - 60] * 2
        self.assertEqual(classify_activity(index, "1", end), "inactive")
        days[first.isoformat()]["stations"]["1"] = [int(start.timestamp())] * 2
        self.assertEqual(classify_activity(index, "1", end), "active")
        days[first.isoformat()]["stations"]["1"] = None
        del days[(first + timedelta(days=1)).isoformat()]
        self.assertEqual(classify_activity(index, "1", end), "unknown")
        days[last.isoformat()]["stations"]["1"] = [int(end.timestamp())] * 2
        self.assertEqual(classify_activity(index, "1", end), "active")
        days[last.isoformat()]["stations"]["1"] = None
        days[(first + timedelta(days=1)).isoformat()] = {"stations": {"1": None}}
        days[first.isoformat()]["stations"]["1"] = [int(start.timestamp()) - 60] * 2 + [False]
        self.assertEqual(classify_activity(index, "1", end), "unknown")

    def test_index_refreshes_changed_files_and_removes_missing_days(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            path = folder / "2026-11-24.geojson"
            document = {"type": "FeatureCollection", "features": [
                {"properties": {"Station_id": "1", "Hourly": {"01": {}}}}
            ]}
            path.write_text(json.dumps(document), encoding="utf-8")
            first = update_history(folder)
            self.assertIsNone(first["days"]["2026-11-24"]["stations"]["1"])
            document["features"][0]["properties"]["Hourly"]["01"]["Ta"] = 0
            path.write_text(json.dumps(document), encoding="utf-8")
            second = update_history(folder)
            self.assertIsNotNone(second["days"]["2026-11-24"]["stations"]["1"])
            (folder / "station_activity.json").write_text(json.dumps({
                "version": 1, "days": {"2026-11-24": {"sha256": second["days"]["2026-11-24"]["sha256"], "stations": {}}}
            }), encoding="utf-8")
            upgraded = update_history(folder)
            self.assertEqual(upgraded["version"], 3)
            self.assertIn("1", upgraded["days"]["2026-11-24"]["stations"])
            self.assertIn("Ta", upgraded["parameters"]["1"])
            path.unlink()
            self.assertEqual(update_history(folder)["days"], {})

    def test_parameter_history_observes_boundaries_zero_and_stale_timestamps(self):
        day = date(2026, 11, 24)
        document = {"features": [
            {"properties": {"Station_id": "1", "Hourly": {
                "07": {"Precip": 0}, "08": {"Ta": 2}
            }, "Tg": 1, "Tg_time": "2026-11-23 12:00:00"}},
            {"properties": {"Station_id": "2", "Hourly": {
                "02": {"UTC": {"2026-11-24T01:00:00Z": {"Wind_max": 0}}}
            }}},
        ]}
        masks = summarize_parameters(document, day)
        history = build_parameter_history({day.isoformat(): {"parameters": masks}})
        boundary = int(datetime(2026, 11, 24, 6, tzinfo=timezone.utc).timestamp())
        self.assertEqual(history["1"]["Precip"], boundary)
        self.assertEqual(history["1"]["Ta"], boundary + 1)
        self.assertNotIn("Tg", history["1"])
        self.assertEqual(history["2"]["Wind_max"], boundary)

    def test_parameter_history_refreshes_after_backfill_and_day_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            earlier = folder / "2026-11-23.geojson"
            later = folder / "2026-11-24.geojson"
            for path in (earlier, later):
                path.write_text(json.dumps({"type": "FeatureCollection", "features": [
                    {"properties": {"Station_id": "1", "Hourly": {"07": {}}}}
                ]}), encoding="utf-8")
            later.write_text(json.dumps({"type": "FeatureCollection", "features": [
                {"properties": {"Station_id": "1", "Hourly": {"07": {"Ta": 2}}}}
            ]}), encoding="utf-8")
            later_time = int(datetime(2026, 11, 24, 6, tzinfo=timezone.utc).timestamp())
            self.assertEqual(update_history(folder)["parameters"]["1"]["Ta"], later_time)
            earlier.write_text(json.dumps({"type": "FeatureCollection", "features": [
                {"properties": {"Station_id": "1", "Hourly": {"07": {"Ta": 0}}}}
            ]}), encoding="utf-8")
            self.assertEqual(update_history(folder)["parameters"]["1"]["Ta"], later_time - 86400)
            earlier.unlink()
            self.assertEqual(update_history(folder)["parameters"]["1"]["Ta"], later_time)

    def test_correcting_frost_values_refreshes_history_only_for_affected_station(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            path = folder / "2026-10-13.geojson"
            document = {"type": "FeatureCollection", "features": [
                {"properties": {"Station_id": "1", "Tmin": 0.8, "Tmax": 10.7, "Hourly": {"07": {"Precip": 0}}}},
                {"properties": {"Station_id": "2", "Tmin": 0.8, "Tmax": 10.7}},
            ]}
            path.write_text(json.dumps(document), encoding="utf-8")
            first = update_history(folder)
            self.assertIn("Tmin", first["parameters"]["1"])
            del document["features"][0]["properties"]["Tmin"]
            del document["features"][0]["properties"]["Tmax"]
            path.write_text(json.dumps(document), encoding="utf-8")
            corrected = update_history(folder)
            self.assertNotIn("Tmin", corrected["parameters"]["1"])
            self.assertNotIn("Tmax", corrected["parameters"]["1"])
            self.assertIn("Precip", corrected["parameters"]["1"])
            self.assertIn("Tmin", corrected["parameters"]["2"])
            self.assertIn("Tmax", corrected["parameters"]["2"])

    def test_catalog_closes_only_verified_inactivity_and_reactivates_measurements(self):
        now = datetime(2026, 11, 24, 13, 15, tzinfo=timezone.utc)
        end = now.replace(minute=0)
        days = {}
        day = (end - timedelta(days=30)).astimezone(LOCAL_TZ).date()
        last = end.astimezone(LOCAL_TZ).date()
        while day <= last:
            days[day.isoformat()] = {"stations": {"1": None, "2": None, "3": None}}
            day += timedelta(days=1)
        days[last.isoformat()]["stations"]["2"] = [int(end.timestamp())] * 2
        del days[(last - timedelta(days=1)).isoformat()]["stations"]["3"]
        index = {"days": days}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            catalog = folder / "stations.xlsx"
            workbook = Workbook()
            workbook.active.append(["Station_id", "Coordinates", "Status"])
            workbook.active.append(["1", "[20, 52]", "ACTIVE"])
            workbook.active.append(["2", None, "CLOSED"])
            workbook.active.append(["3", None, "ACTIVE"])
            workbook.save(catalog)
            document = {"type": "FeatureCollection", "features": [
                {"geometry": {"type": "Point", "coordinates": [20, 52]}, "properties": {"Station_id": "1", "Status": "ACTIVE"}},
                {"geometry": {"type": "Point", "coordinates": [21, 53]}, "properties": {"Station_id": "2", "Status": "CLOSED"}},
                {"geometry": None, "properties": {"Station_id": "3", "Status": "ACTIVE"}},
            ]}
            paths = [folder / "today.geojson", folder / "latest.geojson"]
            for path in paths:
                path.write_text(json.dumps(document), encoding="utf-8")
            update_catalog(index, catalog, paths, now)
            sheet = load_workbook(catalog).active
            self.assertEqual([sheet.cell(row, 3).value for row in (2, 3, 4)], ["CLOSED", "ACTIVE", "ACTIVE"])
            self.assertEqual(sheet.cell(3, 2).value, "[21, 53]")
            for path in paths:
                updated = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual([f["properties"]["Status"] for f in updated["features"]], ["CLOSED", "ACTIVE", "ACTIVE"])

    def test_stale_global_data_does_not_close_a_station(self):
        now = datetime(2026, 11, 24, 13, 15, tzinfo=timezone.utc)
        old = now.replace(hour=9, minute=0)
        days = {}
        for offset in range(31):
            day = (old - timedelta(days=offset)).astimezone(LOCAL_TZ).date().isoformat()
            days[day] = {"stations": {"1": None, "2": None}}
        days[old.astimezone(LOCAL_TZ).date().isoformat()]["stations"]["2"] = [int(old.timestamp())] * 2
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            catalog = folder / "stations.xlsx"
            workbook = Workbook()
            workbook.active.append(["Station_id", "Coordinates", "Status"])
            workbook.active.append(["1", None, "ACTIVE"])
            workbook.active.append(["2", None, "CLOSED"])
            workbook.save(catalog)
            path = folder / "today.geojson"
            path.write_text(json.dumps({"type": "FeatureCollection", "features": []}), encoding="utf-8")
            update_catalog({"days": days}, catalog, [path], now)
            sheet = load_workbook(catalog).active
            self.assertEqual(sheet.cell(2, 3).value, "ACTIVE")
            self.assertEqual(sheet.cell(3, 3).value, "ACTIVE")

    def test_closed_station_without_coordinates_is_checked_and_keeps_measurements(self):
        station = {"Station_id": "123", "Station_name": "Test", "Status": "CLOSED",
                   "Elevation": None, "coordinates": None}
        timestamp = imgw_data.now_local.replace(hour=1, minute=0, second=0, microsecond=0).isoformat()
        profile = {"temperature": [{"date": timestamp, "value": 0}], "precip": [], "wind": {}}
        with patch.object(imgw_data, "fetch_json", AsyncMock(return_value=profile)):
            feature = asyncio.run(imgw_data.check_closed_station(
                None, station, None, imgw_data.now_local.date() - timedelta(days=1), {}
            ))
        self.assertIsNone(feature["geometry"])
        self.assertEqual(feature["properties"]["Hourly"]["01"]["Ta"], 0)
        self.assertIsNotNone(summarize_document({"features": [feature]}, imgw_data.now_local.date())["123"])

    def test_previous_day_can_gain_readings_for_previously_closed_station(self):
        document = {"features": [{"properties": {"Station_id": "123", "Status": "CLOSED"}}]}
        added = imgw_data.add_missing_hourly_readings(document, {"123": {"01": {"Ta": 0}}})
        self.assertEqual(added, 1)
        self.assertEqual(document["features"][0]["properties"]["Hourly"]["01"]["Ta"], 0)

    def test_completed_precipitation_is_written_to_its_archive_date(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "2026-11-24.geojson"
            previous = {"type": "FeatureCollection", "features": [
                {"properties": {"Station_id": "123", "Status": "ACTIVE"}}
            ]}
            path.write_text(json.dumps(previous), encoding="utf-8")
            current_features = [{
                "geometry": {"type": "Point", "coordinates": [20, 52]},
                "properties": {
                    "Station_id": "123", "Station_name": "Test",
                    "Status": "ACTIVE", "Elevation": 100,
                },
            }]
            additions = imgw_data.update_archive_file(
                str(path), current_features, {},
                {"123": {"Precip_24h": 2.4, "Number_of_precip_measurements": 24}},
            )
            updated = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(additions, 2)
        properties = updated["features"][0]["properties"]
        self.assertEqual(properties["Precip_24h"], 2.4)
        self.assertEqual(properties["Number_of_precip_measurements"], 24)

    def test_empty_precipitation_does_not_add_a_station_to_an_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "2026-11-24.geojson"
            path.write_text(json.dumps({"type": "FeatureCollection", "features": []}), encoding="utf-8")
            current = [{"properties": {"Station_id": "123", "Status": "ACTIVE"}}]
            updates = imgw_data.update_archive_file(
                str(path), current, {},
                {"123": {"Precip_24h": None, "Number_of_precip_measurements": 0}},
            )
            updated = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(updates, 0)
        self.assertEqual(updated["features"], [])

    def test_failed_closed_station_check_preserves_existing_data_but_not_coverage(self):
        station = {"Station_id": "123", "Station_name": "Test", "Status": "CLOSED",
                   "Elevation": None, "coordinates": None}
        existing = {"geometry": None, "properties": {
            "Station_id": "123", "Hourly": {"01": {"Ta": 2}}, "Status": "CLOSED"
        }}
        with patch.object(imgw_data, "fetch_json", AsyncMock(side_effect=RuntimeError("test"))):
            feature = asyncio.run(imgw_data.check_closed_station(
                None, station, None, imgw_data.now_local.date() - timedelta(days=1), {}, existing
            ))
        self.assertEqual(feature["properties"]["Hourly"]["01"]["Ta"], 2)
        self.assertTrue(feature["properties"]["Activity_check_failed"])
        observed = summarize_document({"features": [feature]}, imgw_data.now_local.date())["123"]
        self.assertFalse(observed[2])


if __name__ == "__main__":
    unittest.main()
