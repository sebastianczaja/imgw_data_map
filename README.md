abc

### Wysokości stacji

Podczas aktualizacji danych wysokości stacji są pobierane z listy meteorologicznej
serwisu [IMGW Hydro](https://hydro.imgw.pl/) i dopasowywane po kodzie stacji.
Jeżeli IMGW nie udostępnia wysokości danej stacji, pozostaje wartość z
`all_stations.xlsx` albo brak danych. Archiwalne pliki nie są zmieniane.

### Temperatury z serwisu Przymrozki

Dobowe Tmin i Tmax są dopasowywane po nazwie oraz współrzędnych stacji
(tolerancja 0,00001°). Sama zgodność nazwy nie wystarcza: przy braku
jednoznacznego dopasowania wartości nie są przypisywane. Data dobowa pozostaje
taka, jaką podaje serwis Przymrozki.

### Kompletność danych godzinowych

Okna godzinowe zależą od rodzaju pomiaru. Temperatura (Ta, Tmin_hour,
Tmax_hour) i wiatr korzystają z doby synoptycznej: od 18:00 UTC dnia
poprzedniego do 18:00 UTC daty archiwum (19:00–19:00 zimą, 20:00–20:00
latem). Opady korzystają z doby opadowej: od 06:00 UTC daty archiwum do
06:00 UTC dnia następnego (07:00–07:00 zimą, 08:00–08:00 latem); poranny
pomiar graniczny jest przypisywany do poprzedniego dnia.
Dla najnowszego dnia żółte znaczniki uwzględniają pomiary do ostatniej godziny,
w której dowolna stacja ma odczyt danego parametru. Późniejsze godziny ani
odczyty innych parametrów nie są oceniane; wcześniejsze braki nadal powodują
żółte oznaczenie. W starszych dniach sprawdzana jest cała doba meteorologiczna,
łącznie z godzinami granicznymi. Każdy typ pomiaru sprawdza własne okno.

### Statusy stacji

Panel przy mapie pozwala ukrywać stacje aktywne (zielone), z niepełnymi danymi
(żółte), z całodobowym brakiem wybranego parametru (czerwone) oraz nieczynne
(szare). Brak pojedynczej godziny nie powoduje czerwonego oznaczenia.
Stacje nieczynne i stacje z całodobowym brakiem danych są widoczne jako same
kropki, bez etykiet. Brak wartości godzinowej dla wybranej godziny również
ukrywa etykietę. Dla Ta oraz godzinowych ekstremów temperatury żółty status
oznacza wykrytą lukę w danych; brak pomiarów z jeszcze niezakończonej doby sam
w sobie nie powoduje żółtego statusu.
Niezakończona lub jeszcze niepobrana doba nie jest uznawana za całodobowy brak.
Aktywność jest oceniana dla 30 dni do końca wybranego okna danych. Przy
niepełnym archiwum odpowiednie statusy nie są potwierdzone;
ostrzeżenie pojawia się w panelu.

W danej warstwie nie są oznaczane jako brakujące stacje, dla których nie
potwierdzono żadnego pomiaru tego parametru w dostępnej historii do wybranego
dnia. Dotyczy to również oznaczenia stacji jako nieczynnej w tej warstwie.
Dobowe Tmin i Tmax wymagają osobnej historii każdego z tych parametrów;
wcześniejsze pomiary Ta nie potwierdzają ich dostępności.
Dobowe Tmin i Tmax są zielone, gdy IMGW udostępni wartość. Jeśli stacja miała
ten parametr w którymś z ostatnich 30 dni, lecz brak wartości także po 22:00
czasu polskiego, pojawia się czerwona kropka bez etykiety. Wcześniej brak nie
jest jeszcze oznaczany.
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

Wykresy godzinowe mają dwa kalendarze początku i końca zakresu. Wybrany zakres
obejmuje pełne doby: od 18:00 UTC dnia poprzedzającego datę początkową do
06:00 UTC dnia następującego po dacie końcowej. Wykresy korzystają z danych
stacji z każdego pliku w zakresie oraz z plików sąsiednich. Etykiety osi
pokazują czas lokalny; jasnoszare linie oznaczają wewnętrzne granice dób
synoptycznych na wykresach temperatury i wiatru oraz dób hydrologicznych na
wykresie opadów. Daty obu rodzajów dób są umieszczone nad wykresem, na środku
przedziału między sąsiednimi podziałkami; doba hydrologiczna jest opisana datą
jej początku, również na częściowo widocznych krawędziach wykresu. U góry
wykresu opadów widnieje `Precip_24h` dla doby od 06:00 UTC danego dnia do
06:00 UTC następnego dnia (pomiary w przedziale od 07:00 do 06:00 UTC włącznie).
Suma jest obliczana z 24 różnych pomiarów godzinowych IMGW, a nie pobierana jako
gotowa suma dobowa. Mapa, zestawienia i wykresy przeliczają ją z dostępnych
danych godzinowych lub wykorzystują sumę archiwalną z potwierdzonymi 24
pomiarami; w przeciwnym razie pokazują brak danych. Samo wyświetlanie nie
nadpisuje plików archiwum; ostatnie sześć tygodni aktualizuje skrypt backfill.
Dłuższe wykresy można przewijać
poziomo, aby zachować czytelność godzin.
Na wykresie temperatury najwyższy i najniższy punkt Ta w każdej dobie
synoptycznej są oznaczone odpowiednio na czerwono (`Tmax_hour`) i niebiesko
(`Tmin_hour`): punkty są wypełnione, a wartości pogrubione i oznaczone tym
samym kolorem. Jeśli maksimum i minimum przypadają na ten sam punkt, widoczne
są oba kolory. U góry każdej doby wyświetlane są minimum, maksimum i średnia
arytmetyczna z dostępnych godzinowych pomiarów Ta; przy braku pomiarów podawany
jest brak danych. Na wykresie wiatru maksima każdej serii w każdej dobie
synoptycznej mają wypełnione punkty i pogrubione wartości; przy remisie
wyróżnione są wszystkie maksima. Dobowe maksima porywów `Wind_max` oraz ich
podsumowanie nad wykresem są czerwone. Pozostałe punkty są puste w środku,
a linie pomiarowe mają przerwę w ich obrębie. Podsumowanie wiatru dla każdej
doby zawiera najwyższy godzinowy poryw oraz średnią arytmetyczną dostępnych
godzinowych średnich prędkości, także dla niewybranej serii.
Wartości pomiarów są widoczne nad punktami i słupkami; po najechaniu na punkt
lub słupek wyświetlane są dodatkowo szczegóły pomiaru. Tabela poniżej jest
jedną zbiorczą tabelą zaznaczonych parametrów ze wszystkimi
godzinami, wartościami i datami zawierającymi rok. Data i godzina są w
oddzielnych kolumnach, a kolorowe linie i legenda oznaczają granice dób.
W tabeli pogrubione są dobowe maksima wiatru i godzinowych opadów, a także
minimum i maksimum temperatury, odpowiednio na niebiesko i czerwono.

Zakres osi każdego wykresu zależy od wybranych danych i obejmuje co najmniej
trzy jednostki zapasu po obu stronach. Górny zapas zwiększa się w razie potrzeby,
aby etykiety pomiarów nie nachodziły na podsumowania dobowe. Siatka ma linie co jednostkę, z mocniej
zaznaczonymi liniami co pięć jednostek. Skala opadów i wiatru zaczyna się od
zera, a opad godzinowy jest przedstawiany słupkami.

### Zmiana czasu

Podczas powtórzonej godziny jesiennej pomiary są zapisywane również według UTC,
aby można było osobno sprawdzić obie godziny. Starsze dane można uzupełnić:

```shell
python backfill_recent_data.py --from-date 2026-10-25 --to-date 2026-10-25 --utc-only
```
