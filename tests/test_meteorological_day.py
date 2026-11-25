from datetime import date, timedelta
import io
import json
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

import backfill_recent_data
import imgw_data
from hourly_utc import merge_utc_readings


class MeteorologicalDayTests(unittest.TestCase):
    def test_frost_station_requires_matching_coordinates_even_for_one_result(self):
        source = {"lon": "19.215", "lat": "50.572778", "temp_min_2m": "0.8", "temp_max_2m": "10.7"}
        self.assertIsNone(imgw_data.find_przymrozek([source], 15.983056, 50.9325))
        self.assertIs(imgw_data.find_przymrozek([source], 19.215, 50.572778), source)
        self.assertIsNone(imgw_data.find_przymrozek([source], None, None))
        self.assertIsNone(imgw_data.find_przymrozek([{"lon": None, "lat": None}], 19.215, 50.572778))
        self.assertIsNone(imgw_data.find_przymrozek([source, dict(source)], 19.215, 50.572778))

    def test_frost_matching_distinguishes_stations_without_changing_hourly_extrema(self):
        first = {"lon": "15.983056", "lat": "50.9325", "temp_min_2m": "-3", "temp_max_2m": "4"}
        second = {"lon": "19.215", "lat": "50.572778", "temp_min_2m": "0.8", "temp_max_2m": "10.7"}
        temperature = {"temperature": [{"date": "2026-10-13T06:00:00Z", "value": 2}]}
        data = {"MYSLOW": [second, first]}
        extracted = imgw_data.extract_temperature_data(
            temperature, data, "MYSLOW", 15.983056, 50.9325, date(2026, 10, 13)
        )
        self.assertEqual((extracted.temp_min, extracted.temp_max), (-3, 4))
        self.assertEqual((extracted.temp_min_h, extracted.temp_max_h), (2, 2))
        missing = imgw_data.extract_temperature_data(
            temperature, {"MYSLOW": [second]}, "MYSLOW", 15.983056, 50.9325, date(2026, 10, 13)
        )
        self.assertIsNone(missing.temp_min)
        self.assertIsNone(missing.temp_max)
        self.assertEqual((missing.temp_min_h, missing.temp_max_h), (2, 2))

    def test_target_date_window_ends_on_date_in_summer_and_winter(self):
        warsaw = ZoneInfo("Europe/Warsaw")
        for target_date, expected_local_hour in (
            (date(2026, 7, 23), 8),
            (date(2026, 11, 23), 7),
        ):
            with self.subTest(target_date=target_date):
                start, end = imgw_data.get_meteo_day_window_for_date(target_date)
                self.assertEqual(
                    start.astimezone(warsaw).date(), target_date - timedelta(days=1)
                )
                self.assertEqual(end.astimezone(warsaw).date(), target_date)
                self.assertEqual(start.astimezone(warsaw).hour, expected_local_hour)
                self.assertEqual(end.astimezone(warsaw).hour, expected_local_hour)
                self.assertEqual(end - start, timedelta(days=1))

    def test_boundary_temperature_belongs_to_both_meteorological_days(self):
        temperature_data = {
            "temperature": [{"value": -9.0, "date": "2026-11-23T06:00:00Z"}]
        }
        for meteo_date in (date(2026, 11, 23), date(2026, 11, 24)):
            with self.subTest(meteo_date=meteo_date):
                extracted = imgw_data.extract_temperature_data(
                    temperature_data, None, "TEST", None, None, meteo_date
                )
                self.assertEqual(extracted.temp_min_h, -9.0)
                self.assertEqual(extracted.temp_max_h, -9.0)
                self.assertEqual(extracted.temp_min_h_time, "2026-11-23T06:00:00Z")
                self.assertEqual(extracted.temp_max_h_time, "2026-11-23T06:00:00Z")

    def test_current_temperature_is_independent_of_selected_meteorological_date(self):
        temperature_data = {
            "temperature": [
                {"value": 0.8, "date": "2026-11-22T18:00:00Z"},
                {"value": 4.0, "date": "2026-11-23T10:00:00Z"},
            ]
        }
        extracted = imgw_data.extract_temperature_data(
            temperature_data, None, "TEST", None, None, date(2026, 11, 22)
        )
        self.assertEqual(extracted.temp_current, 4.0)
        self.assertEqual(extracted.temp_current_time, "2026-11-23T10:00:00Z")

    def test_repeated_hour_preserves_both_utc_readings_and_wind_intervals(self):
        data = {
            "temperature": [
                {"date": "2026-10-25T00:00:00Z", "value": 1.7},
                {"date": "2026-10-25T01:00:00Z", "value": 1.4},
            ],
            "precip": [{"date": "2026-10-25T00:00:00Z", "value": 0}],
            "wind": {
                "velocityObs": [
                    {"date": "2026-10-25T00:00:00Z", "value": 2},
                    {"date": "2026-10-25T01:00:00Z", "value": 3},
                ],
                "maxVelocity": [
                    {"date": "2026-10-24T23:50:00Z", "value": 5},
                    {"date": "2026-10-25T00:50:00Z", "value": 7},
                ],
            },
        }
        hourly = imgw_data.build_hourly_data(data, date(2026, 10, 25))
        utc = hourly["02"]["UTC"]
        self.assertEqual(utc["2026-10-25T00:00:00Z"], {"Ta": 1.7, "Precip": 0, "Wind_avg": 2, "Wind_max": 5})
        self.assertEqual(utc["2026-10-25T01:00:00Z"], {"Ta": 1.4, "Wind_avg": 3, "Wind_max": 7})
        self.assertEqual(hourly["02"]["Ta"], 1.4)

    def test_utc_backfill_merges_without_overwriting_existing_readings(self):
        hour = {"UTC": {"2026-10-25T00:00:00Z": {"Ta": 1}}}
        additions = merge_utc_readings(hour, {
            "2026-10-25T00:00:00Z": {"Ta": 2, "Precip": 0},
            "2026-10-25T01:00:00Z": {"Ta": 3},
        })
        self.assertEqual(additions, 3)
        self.assertEqual(hour["UTC"]["2026-10-25T00:00:00Z"], {"Ta": 1, "Precip": 0})
        self.assertEqual(hour["UTC"]["2026-10-25T01:00:00Z"], {"Ta": 3})

    def test_spring_clock_change_does_not_create_repeated_hour_metadata(self):
        hourly = imgw_data.build_hourly_data({}, date(2026, 3, 29))
        self.assertTrue(all("UTC" not in values for values in hourly.values()))

    def test_backfill_recovers_utc_without_changing_existing_local_values(self):
        payload = {
            "temperature": [
                {"date": "2026-10-25T00:00:00Z", "value": 1.7},
                {"date": "2026-10-25T01:00:00Z", "value": 1.4},
            ]
        }
        with patch.object(backfill_recent_data, "urlopen", return_value=io.BytesIO(json.dumps(payload).encode())):
            _, readings, _, error = backfill_recent_data.fetch_station_history(
                "123", {"2026-10-25"}, ("2026-10-25",), 800
            )
        self.assertIsNone(error)
        document = {"features": [{"properties": {
            "Status": "ACTIVE", "Station_id": "123",
            "Hourly": {"02": {"Ta": 9}},
        }}]}
        counts = {}
        selected = backfill_recent_data.select_hourly_readings(readings, "2026-10-25", True)
        backfill_recent_data.add_missing_readings(document, {"123": selected}, counts)
        hour = document["features"][0]["properties"]["Hourly"]["02"]
        self.assertEqual(hour["Ta"], 9)
        self.assertEqual(hour["UTC"]["2026-10-25T00:00:00Z"]["Ta"], 1.7)
        self.assertEqual(hour["UTC"]["2026-10-25T01:00:00Z"]["Ta"], 1.4)
        self.assertGreater(counts["02"]["UTC"], 0)


if __name__ == "__main__":
    unittest.main()
