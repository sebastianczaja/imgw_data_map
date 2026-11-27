import asyncio
from datetime import date, datetime, timedelta, timezone
import io
import json
import unittest
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

import backfill_recent_data
import imgw_data
from hourly_utc import merge_utc_readings


class MeteorologicalDayTests(unittest.TestCase):
    def test_precipitation_requires_all_distinct_hours_in_hydrological_window(self):
        start = datetime(2026, 10, 24, 6, tzinfo=timezone.utc)
        rows = [
            {"date": (start + timedelta(hours=hour)).isoformat(), "value": 0.1}
            for hour in range(25)
        ]
        with patch.object(imgw_data, "get_precipitation_day_window", return_value=(start, start + timedelta(days=1))):
            complete = imgw_data.extract_precip_data({"precip": rows})
            incomplete = imgw_data.extract_precip_data({"precip": rows[:-1] + [rows[-2]]})
            zero = imgw_data.extract_precip_data({"precip": [dict(row, value=0) for row in rows]})
        self.assertEqual(complete.all_precip_amount, 24)
        self.assertAlmostEqual(complete.precip_sum, 2.4)
        self.assertEqual(incomplete.all_precip_amount, 23)
        self.assertIsNone(incomplete.precip_sum)
        self.assertEqual(zero.precip_sum, 0)

    def test_latest_hydrological_day_is_complete_just_before_next_boundary(self):
        now = datetime(2026, 11, 25, 5, 40, tzinfo=timezone.utc)
        end = datetime(2026, 11, 24, 6, tzinfo=timezone.utc)
        async def fetch_profile(_session, url):
            hours = int(url.rsplit("=", 1)[1])
            latest = now.replace(minute=0)
            return {"precip": [
                {"date": (latest - timedelta(hours=offset)).isoformat(), "value": 0.1}
                for offset in range(hours)
            ]}
        station = {"Station_id": "123", "Station_name": "TEST", "Status": "ACTIVE",
                   "Elevation": None, "coordinates": None}
        daily = {}
        window = (end - timedelta(days=1), end)
        with patch.object(imgw_data, "fetch_json", AsyncMock(side_effect=fetch_profile)), \
                patch.object(imgw_data, "get_precipitation_day_window", return_value=(end, end + timedelta(days=1))):
            asyncio.run(imgw_data.process_missing_station(
                None, station, None, date(2026, 11, 24), {}, daily, window
            ))
        self.assertEqual(daily["123"]["Number_of_precip_measurements"], 24)
        self.assertAlmostEqual(daily["123"]["Precip_24h"], 2.4)

    def test_backfill_does_not_store_partial_precipitation_as_daily_total(self):
        start = datetime(2026, 10, 24, 6, tzinfo=timezone.utc)
        rows = [
            {"date": (start + timedelta(hours=hour)).isoformat(), "value": 0.1}
            for hour in range(1, 25)
        ]
        for data, expected_count in ((rows, 24), (rows[:-1] + [rows[-2]], 23)):
            with self.subTest(expected_count=expected_count):
                payload = {"precip": data}
                with patch.object(backfill_recent_data, "urlopen", return_value=io.BytesIO(json.dumps(payload).encode())):
                    _, _, daily, error = backfill_recent_data.fetch_station_history("123", {"2026-10-24"})
                self.assertIsNone(error)
                self.assertEqual(daily["2026-10-24"]["Number_of_precip_measurements"], expected_count)
                if expected_count == 24:
                    self.assertAlmostEqual(daily["2026-10-24"]["Precip_24h"], 2.4)
                else:
                    self.assertNotIn("Precip_24h", daily["2026-10-24"])

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

    def test_synoptic_window_ends_on_target_date_in_summer_and_winter(self):
        warsaw = ZoneInfo("Europe/Warsaw")
        for target_date, expected_local_hour in (
            (date(2026, 7, 23), 20),
            (date(2026, 11, 23), 19),
        ):
            with self.subTest(target_date=target_date):
                start, end = imgw_data.get_synoptic_day_window_for_date(target_date)
                self.assertEqual(
                    start.astimezone(warsaw).date(), target_date - timedelta(days=1)
                )
                self.assertEqual(end.astimezone(warsaw).date(), target_date)
                self.assertEqual(start.astimezone(warsaw).hour, expected_local_hour)
                self.assertEqual(end.astimezone(warsaw).hour, expected_local_hour)
                self.assertEqual(end - start, timedelta(days=1))

    def test_boundary_temperature_belongs_to_both_meteorological_days(self):
        temperature_data = {
            "temperature": [{"value": -9.0, "date": "2026-11-23T18:00:00Z"}]
        }
        for meteo_date in (date(2026, 11, 23), date(2026, 11, 24)):
            with self.subTest(meteo_date=meteo_date):
                extracted = imgw_data.extract_temperature_data(
                    temperature_data, None, "TEST", None, None, meteo_date
                )
                self.assertEqual(extracted.temp_min_h, -9.0)
                self.assertEqual(extracted.temp_max_h, -9.0)
                self.assertEqual(extracted.temp_min_h_time, "2026-11-23T18:00:00Z")
                self.assertEqual(extracted.temp_max_h_time, "2026-11-23T18:00:00Z")

    def test_backfill_assigns_precipitation_to_previous_day_and_synoptic_values_to_ending_date(self):
        self.assertEqual(
            backfill_recent_data.precipitation_date(datetime.fromisoformat("2026-11-25T06:00:00+00:00")),
            "2026-11-24",
        )
        self.assertEqual(
            backfill_recent_data.synoptic_date(datetime.fromisoformat("2026-11-25T18:00:00+00:00")),
            "2026-11-25",
        )
        self.assertEqual(
            backfill_recent_data.synoptic_date(datetime.fromisoformat("2026-11-25T18:00:01+00:00")),
            "2026-11-26",
        )

    def test_backfill_daily_values_use_their_own_reporting_day(self):
        payload = {
            "precip": [
                {"date": (datetime(2026, 11, 24, 6, tzinfo=timezone.utc) + timedelta(hours=hour)).isoformat(), "value": 0.1}
                for hour in range(1, 25)
            ],
            "wind": {
                "velocityObs": [
                    {"date": "2026-11-25T18:00:00Z", "value": 3},
                    {"date": "2026-11-25T19:00:00Z", "value": 6},
                ],
                "maxVelocity": [
                    {"date": "2026-11-25T18:00:00Z", "value": 8},
                    {"date": "2026-11-25T19:00:00Z", "value": 12},
                ],
            },
        }
        target_dates = {"2026-11-24", "2026-11-25", "2026-11-26"}
        with patch.object(backfill_recent_data, "urlopen", return_value=io.BytesIO(json.dumps(payload).encode())):
            _, _, daily, error = backfill_recent_data.fetch_station_history(
                "123", target_dates, hours_interval=800
            )
        self.assertIsNone(error)
        self.assertAlmostEqual(daily["2026-11-24"]["Precip_24h"], 2.4)
        self.assertEqual(daily["2026-11-25"]["Wind_avg"], 3)
        self.assertEqual(daily["2026-11-25"]["Wind_max"], 8)
        self.assertEqual(daily["2026-11-26"]["Wind_avg"], 4.5)
        self.assertEqual(daily["2026-11-26"]["Wind_max"], 12)

    def test_backfill_refreshes_reassigned_daily_values(self):
        document = {"features": [
            {"properties": {
                "Station_id": "1", "Status": "ACTIVE", "Precip_24h": 18,
                "Number_of_precip_measurements": 8, "Wind_avg": 2, "Wind_max": 9,
            }},
            {"properties": {
                "Station_id": "2", "Status": "ACTIVE", "Precip_24h": 5,
                "Number_of_precip_measurements": 2,
            }},
        ]}
        counts = {}
        backfill_recent_data.refresh_daily_readings(
            document,
            {"1": {
                "Precip_24h": 2.4, "Number_of_precip_measurements": 24,
                "Wind_avg": 4.5, "Wind_max": 12,
            }},
            counts,
            {"1", "2"},
        )
        first, second = [feature["properties"] for feature in document["features"]]
        self.assertEqual(first["Precip_24h"], 2.4)
        self.assertEqual(first["Number_of_precip_measurements"], 24)
        self.assertEqual(first["Wind_avg"], 4.5)
        self.assertEqual(first["Wind_max"], 12)
        self.assertNotIn("Precip_24h", second)
        self.assertNotIn("Number_of_precip_measurements", second)
        self.assertEqual(counts["Precip_24h"], 2)

    def test_partial_precipitation_removes_stale_daily_total_from_archive(self):
        original = {"Station_id": "1", "Status": "ACTIVE", "Precip_24h": 9,
                    "Number_of_precip_measurements": 8}
        document = {"features": [{"properties": dict(original)}]}
        updates = imgw_data.update_daily_precipitation_readings(
            document, {"1": {"Precip_24h": None, "Number_of_precip_measurements": 23}}
        )
        self.assertEqual(updates, 2)
        properties = document["features"][0]["properties"]
        self.assertNotIn("Precip_24h", properties)
        self.assertEqual(properties["Number_of_precip_measurements"], 23)

        document = {"features": [{"properties": dict(original)}]}
        backfill_recent_data.refresh_daily_readings(
            document, {"1": {"Number_of_precip_measurements": 23}}, {}, {"1"}
        )
        properties = document["features"][0]["properties"]
        self.assertNotIn("Precip_24h", properties)
        self.assertEqual(properties["Number_of_precip_measurements"], 23)

    def test_partial_refresh_preserves_previously_complete_precipitation(self):
        original = {"Station_id": "1", "Status": "ACTIVE", "Precip_24h": 2.4,
                    "Number_of_precip_measurements": 24}
        document = {"features": [{"properties": dict(original)}]}
        imgw_data.update_daily_precipitation_readings(
            document, {"1": {"Precip_24h": None, "Number_of_precip_measurements": 23}}
        )
        self.assertEqual(document["features"][0]["properties"], original)
        document = {"features": [{"properties": dict(original)}]}
        backfill_recent_data.refresh_daily_readings(
            document, {"1": {"Number_of_precip_measurements": 23, "Wind_max": 8}}, {}, {"1"}
        )
        properties = document["features"][0]["properties"]
        self.assertEqual(properties["Precip_24h"], 2.4)
        self.assertEqual(properties["Number_of_precip_measurements"], 24)
        self.assertEqual(properties["Wind_max"], 8)

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
