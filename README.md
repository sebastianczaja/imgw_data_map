abc

### Wysokości stacji

Podczas aktualizacji danych wysokości stacji są pobierane z listy meteorologicznej
serwisu [IMGW Hydro](https://hydro.imgw.pl/) i dopasowywane po kodzie stacji.
Jeżeli IMGW nie udostępnia wysokości danej stacji, pozostaje wartość z
`all_stations.xlsx` albo brak danych. Archiwalne pliki nie są zmieniane.

### Zmiana czasu

Podczas powtórzonej godziny jesiennej pomiary są zapisywane również według UTC,
aby można było osobno sprawdzić obie godziny. Starsze dane można uzupełnić:

```shell
python backfill_recent_data.py --from-date 2026-10-25 --to-date 2026-10-25 --utc-only
```
