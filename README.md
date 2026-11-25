abc

### Wysokości stacji

Podczas aktualizacji danych wysokości stacji są pobierane z listy meteorologicznej
serwisu [IMGW Hydro](https://hydro.imgw.pl/) i dopasowywane po kodzie stacji.
Jeżeli IMGW nie udostępnia wysokości danej stacji, pozostaje wartość z
`all_stations.xlsx` albo brak danych. Archiwalne pliki nie są zmieniane.

### Temperatury z serwisu Przymrozki

Dobowe Tmin i Tmax są dopasowywane po nazwie oraz współrzędnych stacji
(tolerancja 0,00001°). Sama zgodność nazwy nie wystarcza: przy braku
jednoznacznego dopasowania wartości nie są przypisywane.

### Kompletność danych godzinowych

Dla najnowszego dnia żółte znaczniki uwzględniają pomiary do ostatniej godziny
dostępnej w danych dowolnej stacji. Późniejsze godziny nie są oceniane, a
wcześniejsze braki nadal powodują żółte oznaczenie. W starszych dniach
sprawdzana jest cała doba meteorologiczna, łącznie z godzinami granicznymi.

### Statusy stacji

Panel przy mapie pozwala ukrywać stacje aktywne (zielone), z niepełnymi danymi
(żółte), z całodobowym brakiem wybranego parametru (czerwone) oraz nieczynne
(szare). Brak pojedynczej godziny nie powoduje czerwonego oznaczenia.
Stacje nieczynne i stacje z całodobowym brakiem danych są widoczne jako same
kropki, bez etykiet. Brak wartości godzinowej dla wybranej godziny również
ukrywa etykietę; stacja pozostaje żółta, chyba że jest nieczynna lub ma
całodobowy brak danych.
Niezakończona lub jeszcze niepobrana doba nie jest uznawana za całodobowy brak.
Aktywność jest oceniana dla 30 dni do końca wybranej doby meteorologicznej
(06:00 UTC). Przy niepełnym archiwum odpowiednie statusy nie są potwierdzone;
ostrzeżenie pojawia się w panelu.

W danej warstwie nie są oznaczane jako brakujące stacje, dla których nie
potwierdzono żadnego pomiaru tego parametru w dostępnej historii do wybranego
dnia. Dotyczy to również oznaczenia stacji jako nieczynnej w tej warstwie.
Dobowe Tmin i Tmax wymagają osobnej historii każdego z tych parametrów;
wcześniejsze pomiary Ta nie potwierdzają ich dostępności.
Starsze pomiary sprzed początku archiwum nie mogą zostać uwzględnione.

Aktualizacja pobiera również profile zamkniętych stacji, także tych bez
współrzędnych. Stacje bez współrzędnych nie są wyświetlane na mapie, dopóki
IMGW ich nie udostępni. Błąd pobrania nie jest uznawany za brak pomiarów.
Workflow odświeża indeks `imgw_data/station_activity.json` i katalog
`all_stations.xlsx`: potwierdzone pomiary przywracają status aktywny, a
potwierdzone 30 dni bez pomiarów pozwalają zamknąć stację. Przy opóźnionych
danych lub niepełnej historii nie zamyka stacji. Wybór daty w przeglądarce
nie zmienia katalogu.

### Wykresy stacji

Zakres osi każdego wykresu zależy od wybranych danych i obejmuje co najmniej
trzy jednostki zapasu po obu stronach. Siatka ma linie co jednostkę, z mocniej
zaznaczonymi liniami co pięć jednostek.

### Zmiana czasu

Podczas powtórzonej godziny jesiennej pomiary są zapisywane również według UTC,
aby można było osobno sprawdzić obie godziny. Starsze dane można uzupełnić:

```shell
python backfill_recent_data.py --from-date 2026-10-25 --to-date 2026-10-25 --utc-only
```
