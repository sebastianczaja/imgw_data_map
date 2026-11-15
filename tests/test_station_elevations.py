import asyncio
import copy
import unittest
from unittest.mock import AsyncMock, patch

import imgw_data


class StationElevationTests(unittest.TestCase):
    def setUp(self):
        self.stations = {
            "1": {"Elevation": 100, "Status": "ACTIVE"},
            "2": {"Elevation": None, "Status": "ACTIVE"},
            "3": {"Elevation": 55, "Status": "CLOSED"},
            "4": {"Elevation": 23, "Status": "ACTIVE"},
        }

    def test_updates_matching_stations_and_preserves_unavailable_values(self):
        metadata = [
            {"code": "1", "altitude": 0},
            {"code": "2", "altitude": -2.5},
            {"code": "3", "altitude": 42.2},
            {"code": "4", "altitude": None},
            {"code": "5", "altitude": 30},
        ]
        self.assertEqual(imgw_data.apply_station_elevations(self.stations, metadata), 3)
        self.assertEqual([self.stations[str(i)]["Elevation"] for i in range(1, 5)], [0, -2.5, 42.2, 23])

    def test_invalid_response_fails_without_partial_updates(self):
        original = copy.deepcopy(self.stations)
        for metadata in (
            [],
            {},
            [{"code": "1", "altitude": 10}, {"code": "2"}],
            [{"code": "1", "altitude": 10}, {"code": "2", "altitude": float("nan")}],
            [{"code": "1", "altitude": True}],
            [{"code": "1", "altitude": 10}, {"code": "1", "altitude": 20}],
        ):
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                imgw_data.apply_station_elevations(self.stations, metadata)
            self.assertEqual(self.stations, original)

    def test_update_fetches_metadata_before_processing_measurements(self):
        fetch = AsyncMock(side_effect=[
            [{"code": "1", "altitude": 123.5}],
            RuntimeError("stop before processing measurements"),
        ])
        with patch.object(imgw_data, "stations_map", self.stations), \
             patch.object(imgw_data, "fetch_json", fetch):
            with self.assertRaisesRegex(RuntimeError, "stop before processing"):
                asyncio.run(imgw_data.main())
        self.assertEqual(self.stations["1"]["Elevation"], 123.5)
        self.assertEqual(fetch.await_args_list[0].args[1], imgw_data.station_metadata_url)
        self.assertEqual(fetch.await_args_list[0].kwargs["headers"]["Referer"], "https://hydro.imgw.pl/")


if __name__ == "__main__":
    unittest.main()
