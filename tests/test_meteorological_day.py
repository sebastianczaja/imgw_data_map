from datetime import date, timedelta
import unittest
from zoneinfo import ZoneInfo

import imgw_data


class MeteorologicalDayTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
