const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const functionSource = (name, nextName) => source.slice(
    source.indexOf(`function ${name}(`),
    source.indexOf(`function ${nextName}(`)
);

function getChartData(properties, parameter, dateStr = '2026-11-25', previousDayStations = new Map(), nextDayStations = new Map(), rangeData = null) {
    const context = vm.createContext({
        meteorologicalDate: dateStr,
        previousDayStations,
        nextDayStations,
        getRoundedNumericValue(value, decimals = 1) {
            if (value === undefined || value === null || value === '' || !Number.isFinite(Number(value))) return null;
            return Number(Number(value).toFixed(decimals));
        },
        convertMetersPerSecondToKilometersPerHour(value) {
            return Number((Number(value) * 3.6).toFixed(1));
        }
    });
    vm.runInContext(
        functionSource('buildHourlySlots', 'getSynopticHourlySlots') + source.slice(
            source.indexOf('function getStationChartTimestampHour('),
            source.indexOf('function getStationChartRange(')
        ),
        context
    );
    return context.getStationChartData(properties, parameter, rangeData);
}

function getChartSlots(startDate, endDate) {
    const context = vm.createContext({});
    vm.runInContext(
        source.slice(
            source.indexOf('function getStationChartTimeSlots('),
            source.indexOf('function formatStationChartSlotDate(')
        ),
        context
    );
    return context.getStationChartTimeSlots(startDate, endDate);
}

const temperature = { key: 'Ta', label: 'Temperatura', unit: '°C', color: '#f00' };
const precipitation = { key: 'Precip_hour', label: 'Opad', unit: 'mm', color: '#00f' };
const wind = { key: 'Wind_avg', label: 'Wiatr', unit: 'km/h', color: '#808' };

function renderChart(points, extraSeries = [], slots = undefined) {
    const context = vm.createContext({
        meteorologicalDate: '2026-11-25',
        escapeHtml(value) {
            return String(value ?? '').replace(/[&<>'"]/g, '');
        }
    });
    vm.runInContext(
        functionSource('formatStationChartHour', 'openStationCharts'),
        context
    );
    return context.renderStationChart([
        { parameter: temperature, chartData: { points, slots } },
        ...extraSeries
    ]);
}

function renderPopup(properties, values = {}) {
    const context = vm.createContext({
        props: properties,
        hourStr: '12',
        hourlyTa: values.hourlyTa ?? null,
        hourlyPrecip: values.hourlyPrecip ?? null,
        wAvgKmh: values.wAvgKmh ?? null,
        wMaxKmh: values.wMaxKmh ?? null,
        getFreshGroundTemperature: props => props.Tg ?? null,
        formatStationPopupTime: () => '06:00'
    });
    const start = source.indexOf('            const fTa = formatValue(hourlyTa, 1)');
    const end = source.indexOf('            const getEx =', start);
    vm.runInContext([
        functionSource('formatValue', 'getRoundedNumericValue'),
        functionSource('formatStationPopupValue', 'renderDataForHour'),
        source.slice(start, end),
        'result = popupContent;'
    ].join('\n'), context);
    return context.result;
}

test('station popup shows missing measurements and keeps zero values', () => {
    const html = renderPopup({ Station_name: 'Alfa', Station_id: '123', Tmin: 0, Tmax: 5.2 }, {
        hourlyTa: 0,
        hourlyPrecip: 0
    });
    assert.match(html, /<strong>Temperatura aktualna:<\/strong> 0\.0°C/);
    assert.doesNotMatch(html, /Temperatura aktualna \(Ta\)/);
    assert.match(html, /<strong>Tmin dobowe:<\/strong> 0\.0°C/);
    assert.match(html, /<strong>Tmax dobowe:<\/strong> 5\.2°C/);
    assert.match(html, /<strong>Opad godzinowy \(12:00\):<\/strong> 0\.0 mm/);
    for (const label of [
        'Wysokość', 'Tmin godzinowe', 'Tmax godzinowe', 'Temperatura przy gruncie',
        'Suma opadów', 'Średnia prędkość wiatru (12:00)', 'Maksymalny poryw wiatru'
    ]) {
        assert.ok(html.includes(`<strong>${label}:</strong> Brak danych`), label);
    }
    assert.match(html, /Pokaż wykresy/);
});

test('station popup shows absent daily extrema and retains ground temperature time', () => {
    const html = renderPopup({ Station_name: 'Beta', Station_id: '456', Tg: -2.4 });
    assert.match(html, /<strong>Temperatura aktualna:<\/strong> Brak danych/);
    assert.match(html, /<strong>Tmin dobowe:<\/strong> Brak danych/);
    assert.match(html, /<strong>Tmax dobowe:<\/strong> Brak danych/);
    assert.match(html, /<strong>Temperatura przy gruncie \(06:00\):<\/strong> -2\.4°C/);
});

test('hourly chart data uses available readings in the 36-hour window and converts wind speed', () => {
    const wind = getChartData(
        { Hourly: { '00': { Wind_avg: 2 }, '01': {}, '03': { Wind_avg: 4.5 } } },
        { hourlyKey: 'Wind_avg', valueKey: 'Wind_avg', convertWindSpeed: true }
    );

    assert.deepEqual(
        Array.from(wind.points, point => [point.hour, point.value]),
        [[5, 7.2], [8, 16.2]]
    );
    assert.equal(wind.slots.length, 37);
    assert.equal(wind.slots[0].utc, '2026-11-24T18:00:00Z');
    assert.equal(wind.slots[0].date, '2026-11-24');
    assert.equal(wind.slots[0].localHour, '19');
    assert.equal(wind.slots[36].utc, '2026-11-26T06:00:00Z');
    assert.equal(wind.slots[36].localHour, '07');

    const summer = getChartData({ Hourly: {} }, { hourlyKey: 'Ta' }, '2026-07-15');
    assert.equal(summer.slots[0].utc, '2026-07-14T18:00:00Z');
    assert.equal(summer.slots[0].localHour, '20');
    assert.equal(summer.slots[36].utc, '2026-07-16T06:00:00Z');
    assert.equal(summer.slots[36].localHour, '08');
});

test('hourly charts do not substitute a daily measurement for missing hourly data', () => {
    const data = getChartData(
        { Wind_avg: 3, Hourly: { '01': { Wind_avg: null } } },
        { hourlyKey: 'Wind_avg', valueKey: 'Wind_avg', convertWindSpeed: true }
    );
    assert.equal(data.points.length, 0);
    const zeros = getChartData({ Hourly: { '00': { Precip: 0 } } }, { hourlyKey: 'Precip' });
    assert.equal(zeros.points[0].value, 0);
});

test('chart data combines the adjacent date files across both boundaries', () => {
    const stationId = 'station';
    const previous = { Station_id: stationId, Hourly: { '19': { Ta: 1.1 } } };
    const current = { Station_id: stationId, Hourly: { '00': { Ta: 2.2 } } };
    const next = { Station_id: stationId, Hourly: { '07': { Ta: 3.3, Precip: 4.4 } } };
    const data = getChartData(
        current,
        { hourlyKey: 'Ta' },
        '2026-11-25',
        new Map([[stationId, previous]]),
        new Map([[stationId, next]])
    );
    assert.deepEqual(Array.from(data.points, point => [point.hour, point.value]), [
        [0, 1.1],
        [5, 2.2],
        [36, 3.3]
    ]);
});

test('multi-day chart windows include both complete UTC boundaries and all daily slots', () => {
    const slots = getChartSlots('2026-11-24', '2026-11-26');
    assert.equal(slots.length, 85);
    assert.equal(slots[0].utc, '2026-11-23T18:00:00Z');
    assert.equal(slots[84].utc, '2026-11-27T06:00:00Z');
    assert.equal(slots.filter(slot => slot.utc.endsWith('T18:00:00Z')).length, 4);
    assert.equal(slots.filter(slot => slot.utc.endsWith('T06:00:00Z')).length, 4);

    const daylightSavingSlots = getChartSlots('2026-10-24', '2026-10-26');
    assert.equal(daylightSavingSlots.length, 85);
    assert.equal(daylightSavingSlots.filter(slot =>
        slot.date === '2026-10-25' && slot.localHour === '02'
    ).length, 2);
});

test('range loader fetches every selected and adjacent archive date for the station', async () => {
    const dates = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'];
    const requests = [];
    let renderedRange = null;
    const nodes = {
        stationChartRangeStatus: { textContent: '' },
        stationChartsContent: { innerHTML: '' },
        stationChartParameters: { innerHTML: '' }
    };
    const context = vm.createContext({
        availableDates: dates,
        stationChartRangeRequest: 0,
        stationChartRangeData: null,
        stationChartRangePending: false,
        document: { getElementById: id => nodes[id] },
        fetch: async url => {
            const date = url.match(/imgw_data\/(\d{4}-\d{2}-\d{2})\.geojson/)[1];
            requests.push(date);
            return {
                ok: true,
                async json() {
                    return { features: [{ properties: { Station_id: 'station', Archive_date: date } }] };
                }
            };
        },
        renderStationCharts: (properties, rangeData) => { renderedRange = rangeData; }
    });
    vm.runInContext(
        source.slice(
            source.indexOf('function getStationChartTimeSlots('),
            source.indexOf('function formatStationChartSlotDate(')
        )
        + source.slice(
            source.indexOf('function getStationChartArchiveDates('),
            source.indexOf('function openStationCharts(')
        ),
        context
    );

    await context.loadStationChartRange({ Station_id: 'station' }, '2026-11-24', '2026-11-25');

    assert.deepEqual(requests.sort(), dates);
    assert.equal(renderedRange.propertiesByDate.size, 4);
    assert.equal(renderedRange.propertiesByDate.get('2026-11-23').Archive_date, '2026-11-23');
    assert.equal(renderedRange.propertiesByDate.get('2026-11-26').Archive_date, '2026-11-26');
    assert.equal(nodes.stationChartRangeStatus.textContent, '');
});

test('range loader reports missing neighboring files instead of implying complete edge data', async () => {
    const selectedDates = ['2026-11-24', '2026-11-25'];
    const nodes = {
        stationChartRangeStatus: { textContent: '' },
        stationChartsContent: { innerHTML: '' },
        stationChartParameters: { innerHTML: '' }
    };
    const context = vm.createContext({
        availableDates: selectedDates,
        stationChartRangeRequest: 0,
        stationChartRangeData: null,
        stationChartRangePending: false,
        document: { getElementById: id => nodes[id] },
        fetch: async () => ({
            ok: true,
            async json() {
                return { features: [{ properties: { Station_id: 'station' } }] };
            }
        }),
        renderStationCharts() {}
    });
    vm.runInContext(
        source.slice(
            source.indexOf('function getStationChartTimeSlots('),
            source.indexOf('function formatStationChartSlotDate(')
        )
        + source.slice(
            source.indexOf('function getStationChartArchiveDates('),
            source.indexOf('function openStationCharts(')
        ),
        context
    );

    await context.loadStationChartRange({ Station_id: 'station' }, '2026-11-24', '2026-11-25');

    assert.match(nodes.stationChartRangeStatus.textContent, /Brak danych z 2026-11-23 i 2026-11-26/);
});

test('multi-day chart data reads the station from every archive date, including edge dates', () => {
    const slots = getChartSlots('2026-11-24', '2026-11-25');
    const rangeData = {
        startDate: '2026-11-24',
        endDate: '2026-11-25',
        slots,
        propertiesByDate: new Map([
            ['2026-11-23', { Hourly: { '19': { Ta: 1.1 } } }],
            ['2026-11-24', { Hourly: { '19': { Ta: 2.2 } } }],
            ['2026-11-25', { Hourly: { '19': { Ta: 3.3 } } }],
            ['2026-11-26', { Hourly: { '07': { Ta: 4.4 } } }]
        ])
    };
    const data = getChartData(
        { Station_id: 'station' },
        { hourlyKey: 'Ta' },
        '2026-11-25',
        new Map(),
        new Map(),
        rangeData
    );
    assert.deepEqual(Array.from(data.points, point => [point.hour, point.value]), [
        [0, 1.1],
        [24, 2.2],
        [48, 3.3],
        [60, 4.4]
    ]);
});

test('multi-day plots and tables mark each internal synoptic and hydrological boundary', () => {
    const slots = getChartSlots('2026-11-24', '2026-11-26');
    const html = renderChart(
        [{ hour: 0, value: 1 }],
        [{
            parameter: precipitation,
            chartData: { points: [{ hour: 0, value: 0 }], slots }
        }],
        slots
    );
    const plots = [...html.matchAll(/<section class="station-chart-group">([\s\S]*?)<\/section>/g)]
        .map(match => match[1]);
    assert.equal((plots[0].match(/class="station-chart-synoptic-divider"/g) || []).length, 3);
    assert.equal((plots[1].match(/class="station-chart-hydrological-divider"/g) || []).length, 3);
    assert.match(plots[0], /<svg class="station-chart-y-axis"[^>]*aria-hidden="true">[\s\S]*?class="station-chart-y-axis-background"[\s\S]*?class="station-chart-y-label"/);
    const synopticLabels = [...plots[0].matchAll(
        /<text x="([^"]+)" y="52" class="station-chart-synoptic-label" text-anchor="middle">(.*?)<\/text>/g
    )];
    const synopticDividerXs = [...plots[0].matchAll(
        /<line x1="([^"]+)" y1="60" x2="[^"]+" y2="524" class="station-chart-synoptic-divider"/g
    )].map(match => match[1]);
    const hydrologicalLabels = [...plots[1].matchAll(
        /<text x="([^"]+)" y="52" class="station-chart-hydrological-label" text-anchor="middle">(.*?)<\/text>/g
    )];
    const hydrologicalDividerXs = [...plots[1].matchAll(
        /<line x1="([^"]+)" y1="60" x2="[^"]+" y2="524" class="station-chart-hydrological-divider"/g
    )].map(match => match[1]);
    assert.deepEqual(synopticLabels.map(match => match[2]), [
        'DOBA SYNOPTYCZNA 24.11.2026',
        'DOBA SYNOPTYCZNA 25.11.2026',
        'DOBA SYNOPTYCZNA 26.11.2026'
    ]);
    let previousDividerX = 55;
    synopticLabels.forEach((label, index) => {
        const dividerX = Number(synopticDividerXs[index]);
        const midpoint = (previousDividerX + dividerX) / 2;
        assert.ok(Math.abs(Number(label[1]) - midpoint) < 1e-9);
        previousDividerX = dividerX;
    });
    assert.deepEqual(hydrologicalLabels.map(match => match[2]), [
        'DOBA HYDROLOGICZNA 23.11.2026',
        'DOBA HYDROLOGICZNA 24.11.2026',
        'DOBA HYDROLOGICZNA 25.11.2026',
        'DOBA HYDROLOGICZNA 26.11.2026'
    ]);
    previousDividerX = 55;
    hydrologicalLabels.forEach((label, index) => {
        const dividerX = index < hydrologicalDividerXs.length ? Number(hydrologicalDividerXs[index]) : 1980;
        const midpoint = (previousDividerX + dividerX) / 2;
        assert.ok(Math.abs(Number(label[1]) - midpoint) < 1e-9);
        previousDividerX = dividerX;
    });
    assert.equal((html.match(/class="station-chart-table-synoptic-boundary"/g) || []).length, 3);
    assert.equal((html.match(/class="station-chart-table-hydrological-boundary"/g) || []).length, 3);
    assert.equal((html.match(/class="station-chart-x-label"/g) || []).length, 170);
    assert.equal((html.match(/<tbody>[\s\S]*?<\/tbody>/)[0].match(/<tr/g) || []).length, 85);
    assert.match(plots[0], /style="width:2000px;max-width:none"/);
    assert.match(plots[0], /class="station-chart-date-label"[^>]*>24\.11\.2026<\/text>/);
});

test('precipitation summaries use archived totals for the start date of each hydrological day', () => {
    const slots = getChartSlots('2026-11-24', '2026-11-26');
    const propertiesByDate = new Map([
        ['2026-11-23', { Precip_24h: 0, Number_of_precip_measurements: 24 }],
        ['2026-11-24', { Precip_24h: 12.4, Number_of_precip_measurements: 24, Hourly: { '08': { Precip: 1.1 } } }],
        ['2026-11-25', { Precip_24h: null }],
        ['2026-11-26', { Precip_24h: 5.2, Number_of_precip_measurements: 24 }]
    ]);
    const chartData = getChartData({ Station_id: 'station' }, { ...precipitation, hourlyKey: 'Precip' },
        '2026-11-24', new Map(), new Map(),
        { startDate: '2026-11-24', slots, propertiesByDate });
    const html = renderChart([{ hour: 0, value: 1 }], [{ parameter: precipitation, chartData }], slots);
    const plots = [...html.matchAll(/<section class="station-chart-group">([\s\S]*?)<\/section>/g)]
        .map(match => match[1]);
    const labels = [...plots[1].matchAll(
        /<text x="([^"]+)" y="52" class="station-chart-hydrological-label" text-anchor="middle">([^<]+)<\/text>/g
    )];
    const summaries = [...plots[1].matchAll(
        /<text x="([^"]+)" y="76" class="station-chart-precipitation-summary" text-anchor="middle">([^<]+)<\/text>/g
    )];
    assert.deepEqual(labels.map(match => match[2]), [
        'DOBA HYDROLOGICZNA 23.11.2026', 'DOBA HYDROLOGICZNA 24.11.2026',
        'DOBA HYDROLOGICZNA 25.11.2026', 'DOBA HYDROLOGICZNA 26.11.2026'
    ]);
    assert.deepEqual(summaries.map(match => match[2]), [
        'Precip_24h = 0.0 mm', 'Precip_24h = 12.4 mm',
        'Precip_24h = brak danych', 'Precip_24h = 5.2 mm'
    ]);
    assert.deepEqual(summaries.map(match => match[1]), labels.map(match => match[1]));
    assert.doesNotMatch(plots[0], /station-chart-precipitation-summary/);
});

test('hydrological totals use all 24 UTC readings and reject partial archived sums', () => {
    for (const date of ['2026-11-23', '2026-10-24', '2026-03-28']) {
        const slots = getChartSlots(date);
        const period = slots.filter(slot => slot.utc > `${date}T06:00:00Z`);
        const propertiesByDate = new Map();
        for (const slot of period) {
            if (!propertiesByDate.has(slot.date)) propertiesByDate.set(slot.date, { Hourly: {} });
            const hourly = propertiesByDate.get(slot.date).Hourly;
            const hour = hourly[slot.localHour] ||= {};
            hour.Precip = 0.1;
            hour.UTC ||= {};
            hour.UTC[slot.utc] = { Precip: 0.1 };
        }
        const archive = propertiesByDate.get(date);
        archive.Precip_24h = 1.3;
        archive.Number_of_precip_measurements = 8;
        const data = getChartData({ Station_id: 'station' }, { ...precipitation, hourlyKey: 'Precip' },
            date, new Map(), new Map(), { startDate: date, slots, propertiesByDate });
        assert.equal(data.dailyPrecipitation.get(date), 2.4);
        const last = period[period.length - 1];
        delete propertiesByDate.get(last.date).Hourly[last.localHour].Precip;
        delete propertiesByDate.get(last.date).Hourly[last.localHour].UTC[last.utc];
        const incomplete = getChartData({ Station_id: 'station' }, { ...precipitation, hourlyKey: 'Precip' },
            date, new Map(), new Map(), { startDate: date, slots, propertiesByDate });
        assert.equal(incomplete.dailyPrecipitation.has(date), false);
        if (date === '2026-10-24') {
            propertiesByDate.get(last.date).Hourly[last.localHour].Precip = 0.1;
            propertiesByDate.get(last.date).Hourly[last.localHour].UTC[last.utc] = { Precip: 0.1 };
            const repeated = period.filter(slot =>
                period.some(other => other !== slot && other.date === slot.date && other.localHour === slot.localHour)
            );
            assert.equal(repeated.length, 2);
            delete propertiesByDate.get(repeated[0].date).Hourly[repeated[0].localHour].UTC[repeated[0].utc];
            const missingRepeat = getChartData({ Station_id: 'station' }, { ...precipitation, hourlyKey: 'Precip' },
                date, new Map(), new Map(), { startDate: date, slots, propertiesByDate });
            assert.equal(missingRepeat.dailyPrecipitation.has(date), false);
        }
    }
});

test('map data shares the verified hydrological totals with rankings and popups', () => {
    const date = '2026-11-23';
    const slots = getChartSlots(date).filter(slot => slot.utc > `${date}T06:00:00Z`);
    const current = { Station_id: '1', Precip_24h: 1.3, Number_of_precip_measurements: 8, Hourly: {} };
    const next = { Station_id: '1', Hourly: {} };
    for (const slot of slots) {
        (slot.date === date ? current : next).Hourly[slot.localHour] = { Precip: 0.1 };
    }
    const partial = { Station_id: '2', Precip_24h: 5, Number_of_precip_measurements: 8 };
    const verifiedZero = { Station_id: '3', Precip_24h: 0, Number_of_precip_measurements: 24 };
    const data = { features: [current, partial, verifiedZero].map(properties => ({ properties })) };
    const context = vm.createContext({
        globalGeoJsonData: null,
        meteorologicalDate: '',
        meteorologicalHourlySlots: [],
        synopticHourlySlots: [],
        precipitationHourlySlots: [],
        previousDayStations: new Map(),
        nextDayStations: new Map(),
        latestAvailableDate: 'other',
        latestMeteorologicalHour: null,
        latestMeteorologicalHourByParameter: null,
        currentHourStr: '',
        document: { getElementById: () => null },
        getLastAvailableHourFromData: () => 12,
        renderDataForHour: () => {},
        getRoundedNumericValue: value => value == null || value === '' || !Number.isFinite(Number(value))
            ? null : Number(Number(value).toFixed(1))
    });
    vm.runInContext(
        functionSource('buildHourlySlots', 'getMeteorologicalHourlyValue')
        + functionSource('getDailyPrecipitation', 'getStationChartData')
        + functionSource('processData', 'formatStationPopupValue'),
        context
    );
    context.processData(data, 12, date, null, { features: [{ properties: next }] });
    assert.equal(current.Precip_24h, 2.4);
    assert.equal(partial.Precip_24h, null);
    assert.equal(verifiedZero.Precip_24h, 0);
    assert.equal(context.globalGeoJsonData, data);
});

test('temperature plot highlights daily extrema on points and value labels', () => {
    const slots = getChartSlots('2026-11-24', '2026-11-26');
    const points = [[5, 8], [10, -4], [30, 12], [40, -7], [55, 5], [65, -3]]
        .map(([hour, value]) => ({ ...slots[hour], hour, value }));
    const html = renderChart(points, [], slots);
    const valueLabels = [...html.matchAll(
        /class="station-chart-value-label"[^>]*style="([^"]+)">([^<]+)<\/text>/g
    )].map(match => [match[1], match[2]]);
    const pointStyles = [...html.matchAll(
        /class="station-chart-point" style="fill:([^;"]+);stroke:([^;"]+)/g
    )].map(match => [match[1], match[2]]);

    assert.deepEqual(valueLabels, [
        ['fill:#d64545;font-weight:700', '8.0'],
        ['fill:#2878b5;font-weight:700', '-4.0'],
        ['fill:#d64545;font-weight:700', '12.0'],
        ['fill:#2878b5;font-weight:700', '-7.0'],
        ['fill:#d64545;font-weight:700', '5.0'],
        ['fill:#2878b5;font-weight:700', '-3.0']
    ]);
    assert.doesNotMatch(html, /class="station-chart-extrema-label/);
    assert.deepEqual(pointStyles, [
        ['#d64545', '#d64545'],
        ['#2878b5', '#2878b5'],
        ['#d64545', '#d64545'],
        ['#2878b5', '#2878b5'],
        ['#d64545', '#d64545'],
        ['#2878b5', '#2878b5']
    ]);
    const tiedExtrema = renderChart(
        [{ ...slots[5], hour: 5, value: 2 }],
        [],
        slots
    );
    assert.match(tiedExtrema, /r="3\.5" class="station-chart-point" style="fill:#2878b5;stroke:#2878b5;stroke-width:1\.5"/);
    assert.match(tiedExtrema, /r="2" class="station-chart-point" style="fill:#d64545;stroke:#d64545;stroke-width:1\.5"/);
    assert.match(tiedExtrema, /<linearGradient id="station-chart-temperature-both"><stop offset="50%" stop-color="#d64545"\/><stop offset="50%" stop-color="#2878b5"\/><\/linearGradient>/);
    assert.match(tiedExtrema, /style="fill:url\(#station-chart-temperature-both\);font-weight:700">2\.0<\/text>/);
});

test('temperature summaries show centered daily extrema and mean of available Ta', () => {
    const slots = getChartSlots('2026-11-24', '2026-11-26');
    const points = [[0, 0], [1, 2], [24, 7], [25, -5], [48, 1], [73, 99]]
        .map(([hour, value]) => ({ ...slots[hour], hour, value }));
    const html = renderChart(points, [
        { parameter: precipitation, chartData: { points: [{ hour: 0, value: 4 }], slots } }
    ], slots);
    const plots = [...html.matchAll(/<section class="station-chart-group">([\s\S]*?)<\/section>/g)]
        .map(match => match[1]);
    const summaries = [...plots[0].matchAll(
        /<text x="([^"]+)" y="76" class="station-chart-temperature-summary" text-anchor="middle"><title>Średnia z (\d+) dostępnych pomiarów godzinowych Ta<\/title><tspan class="station-chart-summary-min">([^<]+)<\/tspan><tspan dx="16" class="station-chart-summary-max">([^<]+)<\/tspan><tspan dx="16">([^<]+)<\/tspan><\/text>/g
    )];
    assert.deepEqual(summaries.map(match => match.slice(2)), [
        ['3', 'Tmin_hour = 0.0 °C', 'Tmax_hour = 7.0 °C', 'Tavg = 3.0 °C'],
        ['2', 'Tmin_hour = -5.0 °C', 'Tmax_hour = 1.0 °C', 'Tavg = -2.0 °C'],
        ['0', 'Tmin_hour = brak danych', 'Tmax_hour = brak danych', 'Tavg = brak danych']
    ]);
    const dayLabels = [...plots[0].matchAll(
        /<text x="([^"]+)" y="52" class="station-chart-synoptic-label"/g
    )].map(match => match[1]);
    assert.deepEqual(summaries.map(match => match[1]), dayLabels);
    assert.doesNotMatch(plots[1], /station-chart-temperature-summary/);
});

test('chart data selects repeated local hours by UTC timestamp', () => {
    const data = getChartData({
        Station_id: 'station',
        Hourly: {
            '02': {
                Ta: 9,
                UTC: {
                    '2026-10-25T00:00:00Z': { Ta: 1.1 },
                    '2026-10-25T01:00:00Z': { Ta: 2.2 }
                }
            }
        }
    }, { hourlyKey: 'Ta' }, '2026-10-25');
    const repeatedHours = data.points.filter(point => point.date === '2026-10-25' && point.localHour === '02');
    assert.deepEqual(Array.from(repeatedHours, point => [point.utc, point.value]), [
        ['2026-10-25T00:00:00Z', 1.1],
        ['2026-10-25T01:00:00Z', 2.2]
    ]);
});

test('ground temperature popup time is shown as hours and minutes only', () => {
    const context = vm.createContext({});
    vm.runInContext(
        source.slice(source.indexOf('function getStationChartTimestampHour('), source.indexOf('function getStationChartData('))
            + source.slice(source.indexOf('function formatStationChartHour('), source.indexOf('function renderStationChart(')),
        context
    );

    assert.equal(context.formatStationPopupTime('2026-11-24 04:05:00'), '04:05');
    assert.equal(context.formatStationPopupTime('invalid timestamp'), '');
});

test('hourly charts show each reading on the plot and in the table', () => {
    const html = renderChart([
        { hour: 0, date: '2026-11-24', localHour: '19', value: -2.5 },
        { hour: 1, date: '2026-11-24', localHour: '20', value: 3.2 },
        { hour: 2, date: '2026-11-24', localHour: '21', value: 4.1 }
    ]);

    const valueLabels = [...html.matchAll(
        /<text x="([^"]+)" y="([^"]+)" class="station-chart-value-label"[^>]*>([^<]+)<\/text>/g
    )];
    assert.deepEqual(valueLabels.map(match => match[3]), ['-2.5', '3.2', '4.1']);
    assert.match(html, /class="station-chart-value-label"[^>]*style="fill:#f00">3\.2<\/text>/);
    assert.equal((html.match(/class="station-chart-point"/g) || []).length, 3);
    const pointYs = [...html.matchAll(
        /<circle cx="[^"]+" cy="([^"]+)" r="2\.5" class="station-chart-point"/g
    )].map(match => Number(match[1]));
    valueLabels.forEach((label, index) => assert.ok(Number(label[2]) < pointYs[index]));
    const pointXs = [...html.matchAll(
        /<circle cx="([^"]+)" cy="[^"]+" r="2\.5" class="station-chart-point"/g
    )].map(match => Number(match[1]));
    const lineSegments = [...html.matchAll(
        /<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)" class="station-chart-line"/g
    )].map(match => match.slice(1).map(Number));
    assert.equal(lineSegments.length, 2);
    assert.ok(lineSegments.every((line, index) => line[0] > pointXs[index] && line[2] < pointXs[index + 1]));
    assert.doesNotMatch(html, /<polyline/);
    assert.match(html, /<title>Temperatura 24\.11 19:00: -2\.5 °C<\/title>/);
    assert.match(html, /<title>Temperatura 24\.11 21:00: 4\.1 °C<\/title>/);
    assert.equal((html.match(/class="station-chart-hour-gridline"/g) || []).length, 37);
    assert.equal((html.match(/class="station-chart-x-label"/g) || []).length, 37);
    assert.equal((html.match(/transform="rotate\(-90 /g) || []).length, 37);
    assert.equal((html.match(/class="station-chart-date-label"/g) || []).length, 3);
    assert.match(html, /class="station-chart-point" style="fill:none;stroke:#f00;stroke-width:1\.5"/);
    assert.match(html, /class="station-chart-x-label"[^>]*>19:00<\/text>/);
    assert.match(html, /class="station-chart-date-label"[^>]*>24\.11<\/text>/);
    assert.match(html, /class="station-chart-date-label"[^>]*>25\.11<\/text>/);
    assert.match(html, /class="station-chart-date-label"[^>]*>26\.11<\/text>/);
    assert.match(html, /<th scope="row">24\.11\.2026<\/th><th scope="row">19:00<\/th><td class="station-chart-table-temperature-min">-2\.5 °C<\/td>/);
    assert.match(html, /<th scope="row">24\.11\.2026<\/th><th scope="row">20:00<\/th><td>3\.2 °C<\/td>/);
    assert.match(html, /<th scope="row">24\.11\.2026<\/th><th scope="row">21:00<\/th><td class="station-chart-table-temperature-max">4\.1 °C<\/td>/);
});

test('hourly table shares a time column and aligns selected values and missing hours', () => {
    const html = renderChart(
        [{ hour: 0, value: 0 }, { hour: 2, value: 3 }],
        [
            { parameter: precipitation, chartData: { points: [{ hour: 1, value: 0 }] } },
            { parameter: wind, chartData: { points: [{ hour: 0, value: 7.2 }] } },
            { parameter: { ...wind, key: 'Wind_max', label: 'Poryw' }, chartData: { points: [{ hour: 0, value: 10.8 }] } }
        ]
    );
    const table = html.match(/<table class="station-chart-table"[\s\S]*?<\/table>/)[0];
    assert.equal((html.match(/<table class="station-chart-table"/g) || []).length, 1);
    assert.equal((html.match(/<section class="station-chart-group">/g) || []).length, 3);
    const columns = [...table.matchAll(/<th scope="col" title="[^"]*">.*?<\/span>([^<]+)<\/th>/g)]
        .map(match => match[1]);
    assert.deepEqual(columns, [
        'Ta', 'Precip_hour', 'Wind_avg', 'Wind_max'
    ]);
    assert.match(table, /<th scope="col">Data<\/th><th scope="col">Godzina<\/th>/);
    const tableBody = table.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
    assert.equal((tableBody.match(/<tr/g) || []).length, 37);
    assert.equal((table.match(/<table class="station-chart-table"/g) || []).length, 1);
    assert.equal((html.match(/<section class="station-chart-group">/g) || []).length, 3);
    assert.match(table, /<tr><th scope="row">24\.11\.2026<\/th><th scope="row">19:00<\/th><td class="station-chart-table-temperature-min">0\.0 °C<\/td><td>Brak danych<\/td><td class="station-chart-table-maximum">7\.2 km\/h<\/td><td class="station-chart-table-maximum">10\.8 km\/h<\/td><\/tr>/);
    assert.match(table, /<tr><th scope="row">24\.11\.2026<\/th><th scope="row">20:00<\/th><td>Brak danych<\/td><td class="station-chart-table-maximum">0\.0 mm<\/td>/);
    assert.match(table, /<tr><th scope="row">24\.11\.2026<\/th><th scope="row">21:00<\/th><td class="station-chart-table-temperature-max">3\.0 °C<\/td>/);
    assert.match(table, /<th scope="row">26\.11\.2026<\/th><th scope="row">07:00<\/th>/);
    assert.match(table, /<tr class="station-chart-table-hydrological-boundary"><th scope="row">25\.11\.2026<\/th><th scope="row">07:00<\/th>/);
    assert.match(table, /<tr class="station-chart-table-synoptic-boundary"><th scope="row">25\.11\.2026<\/th><th scope="row">19:00<\/th>/);
    assert.equal((table.match(/station-chart-table-hydrological-boundary/g) || []).length, 1);
    assert.equal((table.match(/station-chart-table-synoptic-boundary/g) || []).length, 1);
    assert.match(html, /Doba synoptyczna/);
    assert.match(html, /Doba hydrologiczna/);
});

test('precipitation uses zero-based bars with hover details for zero and positive readings', () => {
    const html = renderChart(
        [{ hour: 0, value: 1 }],
        [{
            parameter: precipitation,
            chartData: { points: [
                { hour: 0, date: '2026-11-24', localHour: '19', value: 0 },
                { hour: 1, date: '2026-11-24', localHour: '20', value: 2.5 },
                { hour: 2, date: '2026-11-24', localHour: '21', value: 5 }
            ] }
        }]
    );
    const precipitationPlot = [...html.matchAll(/<section class="station-chart-group">([\s\S]*?)<\/section>/g)]
        .map(match => match[1])[1];
    assert.equal((precipitationPlot.match(/class="station-chart-bar"/g) || []).length, 2);
    assert.equal((precipitationPlot.match(/class="station-chart-bar-zero"/g) || []).length, 1);
    assert.doesNotMatch(precipitationPlot, /<polyline|class="station-chart-point"/);
    assert.match(precipitationPlot, /class="station-chart-bar-zero"><title>Opad 24\.11 19:00: 0\.0 mm<\/title>/);
    assert.match(precipitationPlot, /class="station-chart-bar" style="fill:#00f"><title>Opad 24\.11 20:00: 2\.5 mm<\/title>/);
    assert.match(precipitationPlot, /class="station-chart-bar" style="fill:#00f"><title>Opad 24\.11 21:00: 5\.0 mm<\/title>/);
    const labels = [...precipitationPlot.matchAll(
        /<text x="([^"]+)" y="([^"]+)" class="station-chart-value-label"[^>]*>([^<]+)<\/text>/g
    )];
    const bars = [...precipitationPlot.matchAll(
        /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="[^"]+" class="station-chart-bar(?:-zero)?"/g
    )];
    assert.deepEqual(labels.map(match => match[3]), ['0.0', '2.5', '5.0']);
    labels.forEach((label, index) => {
        assert.equal(Number(label[1]), Number(bars[index][1]) + Number(bars[index][3]) / 2);
        assert.ok(Number(label[2]) < Number(bars[index][2]));
    });
});

test('wind values at the same hour remain separate above both points', () => {
    const html = renderChart([{ hour: 0, value: 1 }], [
        { parameter: wind, chartData: { points: [{ hour: 1, value: 7.2 }] } },
        { parameter: { ...wind, key: 'Wind_max', label: 'Poryw', color: '#080' }, chartData: { points: [{ hour: 1, value: 7.2 }] } }
    ]);
    const plot = [...html.matchAll(/<section class="station-chart-group">([\s\S]*?)<\/section>/g)][1][1];
    const labels = [...plot.matchAll(
        /<text x="([^"]+)" y="([^"]+)" class="station-chart-value-label"[^>]*style="fill:([^;"]+)[^"]*"[^>]*>([^<]+)<\/text>/g
    )];
    const pointY = Number(plot.match(/<circle cx="[^"]+" cy="([^"]+)"/)[1]);
    assert.deepEqual(labels.map(match => [match[3], match[4]]), [['#808', '7.2'], ['#d64545', '7.2']]);
    assert.equal(labels[0][1], labels[1][1]);
    assert.ok(labels.every(label => Number(label[2]) < pointY));
    assert.ok(Math.abs(Number(labels[0][2]) - Number(labels[1][2])) >= 11);
});

test('wind highlights tied maxima per series and synoptic day but not outside selected days', () => {
    const slots = getChartSlots('2026-11-24', '2026-11-26');
    const points = [[1, 4], [24, 10], [25, 5], [30, 8], [48, 8], [49, 9], [72, 7], [73, 30]]
        .map(([hour, value]) => ({ ...slots[hour], hour, value }));
    const gusts = [[1, 12], [24, 6], [25, 2], [30, 3], [48, 3], [49, 1]]
        .map(([hour, value]) => ({ ...slots[hour], hour, value }));
    const html = renderChart([{ ...slots[5], hour: 5, value: 1 }], [
        { parameter: wind, chartData: { points, slots } },
        { parameter: { ...wind, key: 'Wind_max', label: 'Poryw', color: '#080' }, chartData: { points: gusts, slots } }
    ], slots);
    const plot = [...html.matchAll(/<section class="station-chart-group">([\s\S]*?)<\/section>/g)][1][1];
    const styles = [...plot.matchAll(/class="station-chart-point" style="fill:([^;]+);stroke:([^;]+);stroke-width:1\.5"/g)]
        .map(match => [match[1], match[2]]);
    assert.deepEqual(styles, [
        ['none', '#808'], ['#808', '#808'], ['none', '#808'], ['#808', '#808'],
        ['#808', '#808'], ['#808', '#808'], ['none', '#808'], ['none', '#808'],
        ['#d64545', '#d64545'], ['none', '#080'], ['none', '#080'],
        ['#d64545', '#d64545'], ['#d64545', '#d64545'], ['#d64545', '#d64545']
    ]);
    const labels = [...plot.matchAll(/class="station-chart-value-label"[^>]*style="([^"]+)">([^<]+)<\/text>/g)]
        .map(match => [match[1], match[2]]);
    assert.deepEqual(labels, [
        ['fill:#808', '4.0'], ['fill:#808;font-weight:700', '10.0'], ['fill:#808', '5.0'],
        ['fill:#808;font-weight:700', '8.0'], ['fill:#808;font-weight:700', '8.0'],
        ['fill:#808;font-weight:700', '9.0'], ['fill:#808', '7.0'], ['fill:#808', '30.0'],
        ['fill:#d64545;font-weight:700', '12.0'], ['fill:#080', '6.0'], ['fill:#080', '2.0'],
        ['fill:#d64545;font-weight:700', '3.0'], ['fill:#d64545;font-weight:700', '3.0'],
        ['fill:#d64545;font-weight:700', '1.0']
    ]);
});

test('wind summaries show daily gust maxima and means of available hourly averages', () => {
    const slots = getChartSlots('2026-11-24', '2026-11-26');
    const makePoints = values => values.map(([hour, value]) => ({ ...slots[hour], hour, value }));
    const html = renderChart(makePoints([[5, 1]]), [
        { parameter: wind, chartData: { points: makePoints([[1, 0], [24, 9], [25, 4], [48, 8], [73, 30]]), slots } },
        { parameter: { ...wind, key: 'Wind_max', label: 'Poryw' }, chartData: { points: makePoints([[1, 11], [24, 6], [25, 4]]), slots } }
    ], slots);
    const plot = [...html.matchAll(/<section class="station-chart-group">([\s\S]*?)<\/section>/g)][1][1];
    const summaries = [...plot.matchAll(
        /<text x="([^"]+)" y="76" class="station-chart-wind-summary" text-anchor="middle"><title>Średnia z (\d+) dostępnych godzinowych prędkości wiatru<\/title><tspan class="station-chart-summary-max">([^<]+)<\/tspan><tspan dx="16">([^<]+)<\/tspan><\/text>/g
    )];
    assert.deepEqual(summaries.map(match => match.slice(2)), [
        ['2', 'Wind_max = 11.0 km/h', 'Wind_avg = 4.5 km/h'],
        ['2', 'Wind_max = 4.0 km/h', 'Wind_avg = 6.0 km/h'],
        ['0', 'Wind_max = brak danych', 'Wind_avg = brak danych']
    ]);
    const dayXs = [...plot.matchAll(/<text x="([^"]+)" y="52" class="station-chart-synoptic-label"/g)]
        .map(match => match[1]);
    assert.deepEqual(summaries.map(match => match[1]), dayXs);
});

test('table highlights daily temperature extrema and tied precipitation and wind maxima', () => {
    const slots = getChartSlots('2026-11-24', '2026-11-26');
    const makePoints = values => values.map(([hour, value]) => ({ ...slots[hour], hour, value }));
    const html = renderChart(makePoints([[1, -3], [2, 4], [3, 2], [24, 4], [25, 5], [26, -4], [49, 7]]), [
        { parameter: precipitation, chartData: { points: makePoints([[11, 1], [12, 3], [13, 3], [14, 5], [36, 5]]), slots } },
        { parameter: wind, chartData: { points: makePoints([[1, 6], [2, 9], [3, 9], [25, 2], [26, 4]]), slots } }
    ], slots);
    const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(match => match[1]);
    assert.match(rows[1], /<td class="station-chart-table-temperature-min">-3\.0 °C<\/td>/);
    assert.match(rows[2], /<td class="station-chart-table-temperature-max">4\.0 °C<\/td>/);
    assert.match(rows[3], /<td>2\.0 °C<\/td>/);
    assert.match(rows[24], /<td class="station-chart-table-temperature-max">4\.0 °C<\/td>/);
    assert.match(rows[25], /<td class="station-chart-table-temperature-max">5\.0 °C<\/td>/);
    assert.match(rows[26], /<td class="station-chart-table-temperature-min">-4\.0 °C<\/td>/);
    assert.match(rows[49], /<td class="station-chart-table-temperature-both">7\.0 °C<\/td>/);
    assert.match(rows[11], /<td>1\.0 mm<\/td>/);
    assert.match(rows[12], /<td class="station-chart-table-maximum">3\.0 mm<\/td>/);
    assert.match(rows[13], /<td>3\.0 mm<\/td>/);
    assert.match(rows[14], /<td class="station-chart-table-maximum">5\.0 mm<\/td>/);
    assert.match(rows[36], /<td class="station-chart-table-maximum">5\.0 mm<\/td>/);
    assert.match(rows[1], /<td>6\.0 km\/h<\/td>/);
    assert.match(rows[2], /<td class="station-chart-table-maximum">9\.0 km\/h<\/td>/);
    assert.match(rows[3], /<td class="station-chart-table-maximum">9\.0 km\/h<\/td>/);
    assert.match(rows[26], /<td class="station-chart-table-maximum">4\.0 km\/h<\/td>/);
});

test('chart range follows data with at least three units of padding', () => {
    const context = vm.createContext({});
    vm.runInContext(functionSource('getStationChartRange', 'renderStationChart'), context);
    const range = points => context.getStationChartRange([{ chartData: { points } }], false, 464);
    assert.deepEqual({ ...range([{ value: -2.5 }, { value: 4.1 }]) }, { min: -6, max: 8 });
    assert.deepEqual({ ...range([{ value: 0 }]) }, { min: -3, max: 3 });
    assert.deepEqual({ ...context.getStationChartRange([
        { chartData: { points: [{ value: 15 }] } }
    ], true, 464) }, { min: 0, max: 18 });
    assert.deepEqual({ ...context.getStationChartRange([
        { chartData: { points: [{ value: 2.2 }] } },
        { chartData: { points: [{ value: 17.1 }] } }
    ], false, 464) }, { min: -1, max: 21 });
    assert.equal(range([{ value: Number.MAX_VALUE }]), null);
});

test('daily summaries stay clear of all value labels for small and large ranges', () => {
    for (const maximum of [0, 15, 100, 1000]) {
        const html = renderChart(
            [{ hour: 0, value: -maximum }, { hour: 12, value: maximum }],
            [
                { parameter: precipitation, chartData: { points: [{ hour: 12, value: maximum }] } },
                { parameter: wind, chartData: { points: [{ hour: 12, value: maximum }] } },
                { parameter: { ...wind, key: 'Wind_max', label: 'Poryw' },
                    chartData: { points: [{ hour: 12, value: maximum }] } }
            ]
        );
        const plots = [...html.matchAll(/<section class="station-chart-group">([\s\S]*?)<\/section>/g)]
            .map(match => match[1]);
        for (const plot of plots) {
            const summary = plot.match(/<text x="[^"]+" y="([^"]+)" class="station-chart-(?:temperature|precipitation|wind)-summary"/);
            assert.ok(summary);
            const summaryY = Number(summary[1]);
            const labels = [...plot.matchAll(/<text x="[^"]+" y="([^"]+)" class="station-chart-value-label"/g)];
            assert.ok(labels.length);
            for (const label of labels) {
                assert.ok(Number(label[1]) - summaryY >= 24,
                    `maximum ${maximum}: value label ${label[1]} is too close to summary ${summaryY}`);
            }
        }
    }
});

test('extreme observations fit within the plot rather than being clipped', () => {
    const html = renderChart([
        { hour: 0, value: 50 },
        { hour: 1, value: -50 }
    ]);

    assert.match(html, /class="station-chart-y-label"[^>]*>-50<\/text>/);
    assert.match(html, /class="station-chart-y-label"[^>]*>0<\/text>/);
    assert.match(html, /class="station-chart-y-label"[^>]*>50<\/text>/);
    assert.doesNotMatch(html, /station-chart-point-out-of-range/);
    const pointYs = [...html.matchAll(/<circle cx="[^"]+" cy="([^"]+)" r="2.5"/g)]
        .map(match => Number(match[1]));
    assert.equal(pointYs.length, 2);
    assert.ok(pointYs[0] > 60 && pointYs[0] < 283);
    assert.ok(pointYs[1] > 292 && pointYs[1] < 524);
    assert.match(html, /<th scope="row">24\.11\.2026<\/th><th scope="row">19:00<\/th><td class="station-chart-table-temperature-max">50\.0 °C<\/td>/);
    assert.match(html, /<th scope="row">24\.11\.2026<\/th><th scope="row">20:00<\/th><td class="station-chart-table-temperature-min">-50\.0 °C<\/td>/);
});

test('plots show one-unit gridlines with heavier lines every five and a shared wind scale', () => {
    const html = renderChart(
        [{ hour: 0, value: 0 }, { hour: 2, value: 40 }],
        [
            { parameter: precipitation, chartData: { points: [{ hour: 0, value: 15 }] } },
            { parameter: wind, chartData: { points: [{ hour: 0, value: 100 }] } },
            { parameter: { ...wind, key: 'Wind_max', label: 'Poryw' }, chartData: { points: [{ hour: 0, value: 100 }] } }
        ]
    );
    const plots = [...html.matchAll(/<section class="station-chart-group">([\s\S]*?)<\/section>/g)]
        .map(match => match[1]);
    assert.equal(plots.length, 3);
    assert.match(plots[0], /Temperatura aktualna \[°C\]/);
    assert.match(plots[1], /Opad godzinowy \[mm\]/);
    assert.match(plots[2], /Wiatr godzinowy \[km\/h\]/);
    for (const [index, range] of [[0, 51], [1, 18], [2, 119]]) {
        assert.equal((plots[index].match(/class="station-chart-hour-gridline"/g) || []).length, 37);
        assert.equal((plots[index].match(/class="station-chart-gridline"/g) || []).length, 1);
        const gridY = [...plots[index].matchAll(/<line x1="[^"]+" y1="([^"]+)"[^>]+class="station-chart-gridline-minor"/g)]
            .map(match => Number(match[1]));
        assert.equal(gridY.length, 4);
        for (let i = 0; i < gridY.length; i++) {
            assert.ok(Math.abs(gridY[i] - (i + 1) * 464 / range) < 1e-9);
        }
        const height = Number(plots[index].match(/<pattern[^>]+height="([^"]+)"/)[1]);
        assert.ok(Math.abs(height - 5 * 464 / range) < 1e-9);
    }
    assert.equal((plots[0].match(/class="station-chart-synoptic-divider"/g) || []).length, 1);
    assert.equal((plots[1].match(/class="station-chart-hydrological-divider"/g) || []).length, 1);
    assert.equal((plots[2].match(/class="station-chart-synoptic-divider"/g) || []).length, 1);
    assert.equal((plots[0].match(/class="station-chart-hydrological-divider"/g) || []).length, 0);
    assert.match(plots[0], /x1="605" y1="60" x2="605" y2="524" class="station-chart-synoptic-divider"/);
    assert.match(plots[0], /class="station-chart-synoptic-label"[^>]*>DOBA SYNOPTYCZNA 25\.11\.2026<\/text>/);
    assert.match(plots[2], /class="station-chart-synoptic-label"[^>]*>DOBA SYNOPTYCZNA 25\.11\.2026<\/text>/);
    assert.match(plots[1], /x1="330" y1="60" x2="330" y2="524" class="station-chart-hydrological-divider"/);
    assert.match(plots[1], /class="station-chart-hydrological-label"[^>]*>DOBA HYDROLOGICZNA 25\.11\.2026<\/text>/);
    assert.match(plots[1], /class="station-chart-y-label"[^>]*>12<\/text>/);
    assert.match(plots[1], /class="station-chart-y-label"[^>]*>18<\/text>/);
    assert.match(plots[1], /class="station-chart-y-label"[^>]*>0<\/text>/);
    assert.match(plots[2], /class="station-chart-y-label"[^>]*>0<\/text>/);
    assert.match(plots[2], /class="station-chart-y-label"[^>]*>100<\/text>/);
    assert.doesNotMatch(plots.join(''), /class="station-chart-y-label"[^>]*>-?\d+\.\d+<\/text>/);
    assert.match(html, /<th scope="row">24\.11\.2026<\/th><th scope="row">19:00<\/th><td class="station-chart-table-temperature-min">0\.0 °C<\/td><td class="station-chart-table-maximum">15\.0 mm<\/td><td class="station-chart-table-maximum">100\.0 km\/h<\/td><td class="station-chart-table-maximum">100\.0 km\/h<\/td>/);
    assert.equal((html.match(/<polyline /g) || []).length, 0);
    assert.equal((plots[0].match(/class="station-chart-value-label"/g) || []).length, 2);
    assert.equal((plots[1].match(/class="station-chart-value-label"/g) || []).length, 1);
    assert.equal((plots[2].match(/class="station-chart-value-label"/g) || []).length, 2);
    assert.match(plots[1], /<title>Opad 00:00: 15\.0 mm<\/title>/);
});

test('parameter checkboxes update plots and unavailable hourly series stay disabled', () => {
    const checks = [];
    const list = {
        set innerHTML(html) {
            checks.length = 0;
            for (const match of html.matchAll(/data-chart-parameter="([^"]+)"([^>]*)/g)) {
                checks.push({
                    dataset: { chartParameter: match[1] },
                    checked: match[2].includes(' checked'),
                    disabled: match[2].includes(' disabled'),
                    addEventListener(event, callback) { this.onChange = callback; }
                });
            }
        },
        querySelectorAll(selector) {
            return selector.endsWith(':checked') ? checks.filter(check => check.checked) : checks;
        }
    };
    const content = { innerHTML: '' };
    const dialog = { open: false, showModal() { this.open = true; } };
    const nodes = {
        stationChartsDialog: dialog,
        stationChartParameters: list,
        stationChartsContent: content,
        stationChartsTitle: {},
        stationChartsDate: {},
        stationChartStartDate: { value: '' },
        stationChartEndDate: { value: '' },
        stationChartRangeStatus: { textContent: '' },
        datePicker: { value: '2026-11-22' }
    };
    const context = vm.createContext({
        meteorologicalDate: '2026-11-25',
        stationChartRangeRequest: 0,
        stationChartRangeData: null,
        stationChartRangePending: false,
        openStationChartsProperties: null,
        document: { getElementById: id => nodes[id] },
        previousDayStations: new Map(),
        nextDayStations: new Map(),
        escapeHtml: value => String(value),
        getRoundedNumericValue: value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(1)),
        convertMetersPerSecondToKilometersPerHour: value => Number((value * 3.6).toFixed(1))
    });
    vm.runInContext(
        source.slice(source.indexOf('const stationChartParameters = ['), source.indexOf('];', source.indexOf('const stationChartParameters = [')) + 2)
        + '\n' + functionSource('buildHourlySlots', 'getSynopticHourlySlots')
        + source.slice(source.indexOf('function formatStationChartHour('), source.indexOf('function initStationChartsDialog(')),
        context
    );
    context.openStationCharts({
        Station_name: 'Alfa',
        Wind_max: 20,
        Hourly: { '00': { Ta: 0, Precip: 0, Wind_avg: 2 } }
    });
    assert.deepEqual(checks.map(check => check.dataset.chartParameter), ['Ta', 'Precip_hour', 'Wind_avg', 'Wind_max']);
    assert.equal(checks[3].disabled, true);
    assert.equal((content.innerHTML.match(/<svg class="station-chart-svg"/g) || []).length, 3);
    assert.match(content.innerHTML, /7\.2 km\/h/);
    assert.equal(nodes.stationChartStartDate.value, '2026-11-22');
    assert.equal(nodes.stationChartEndDate.value, '2026-11-22');
    checks[1].checked = false;
    checks[1].onChange();
    assert.equal((content.innerHTML.match(/<svg class="station-chart-svg"/g) || []).length, 2);
    assert.doesNotMatch(content.innerHTML, /0\.0 mm/);
    assert.doesNotMatch(content.innerHTML, />Precip_hour<\/th>/);
    assert.match(content.innerHTML, /7\.2 km\/h/);
    checks.forEach(check => { check.checked = false; });
    checks[0].onChange();
    assert.match(content.innerHTML, /Zaznacz zmienną/);
    context.openStationCharts({
        Station_name: 'Alfa',
        Hourly: { '00': { Wind_avg: 2, Wind_max: 3 } }
    });
    checks[3].checked = false;
    checks[3].onChange();
    assert.match(content.innerHTML, /Wind_max = 10\.8 km\/h/);
    assert.match(content.innerHTML, /Wind_avg = 7\.2 km\/h/);
    assert.doesNotMatch(content.innerHTML, />Wind_max<\/th>/);
});

test('open station charts refresh by station ID when the selected date changes', () => {
    const stationWithSameName = { Station_id: 'other', Station_name: 'Alfa' };
    const selectedStation = { Station_id: 'selected', Station_name: 'Alfa' };
    const nodes = {
        stationChartsDialog: { open: true },
        stationChartsDate: {},
        stationChartParameters: { innerHTML: '' },
        stationChartsContent: { innerHTML: '' },
        stationChartStartDate: { value: '' },
        stationChartEndDate: { value: '' },
        datePicker: { value: '2026-11-23' }
    };
    let renderedProperties = null;
    const context = vm.createContext({
        document: { getElementById: id => nodes[id] },
        openStationChartsStationId: 'selected',
        openStationChartsProperties: null,
        stationChartRangeData: null,
        stationChartRangeRequest: 0,
        stationChartRangePending: false,
        globalGeoJsonData: { features: [{ properties: stationWithSameName }, { properties: selectedStation }] },
        renderStationCharts: properties => { renderedProperties = properties; }
    });
    vm.runInContext(
        functionSource('refreshStationChartsForDate', 'restoreStationPopupAfterDateLoad')
        + '\nrefreshStationChartsForDate();',
        context
    );

    assert.equal(renderedProperties, selectedStation);
});

test('date navigation reopens the selected station popup by station ID', () => {
    let popupOpened = false;
    const markerGroups = Array.from({ length: 12 }, () => ({
        eachLayer(callback) {
            callback({ stationId: 'other', openPopup() { assert.fail('wrong station popup opened'); } });
        }
    }));
    markerGroups[4].eachLayer = callback => {
        callback({ stationId: 'selected', openPopup() { popupOpened = true; } });
    };
    const context = vm.createContext({
        stationPopupToRestore: 'selected',
        map: { hasLayer: () => true },
        etykietyTa: markerGroups[0],
        etykietyTmin: markerGroups[1],
        etykietyTmax: markerGroups[2],
        etykietyTminHour: markerGroups[3],
        etykietyTmaxHour: markerGroups[4],
        etykietyTg: markerGroups[5],
        etykietyOpady24h: markerGroups[6],
        etykietyOpady10min: markerGroups[7],
        etykietyWindAvg: markerGroups[8],
        etykietyWindMax: markerGroups[9],
        etykietyElevation: markerGroups[10],
        etykietyStationName: markerGroups[11]
    });
    vm.runInContext(
        functionSource('restoreStationPopupAfterDateLoad', 'initStationChartsDialog')
        + '\nrestoreStationPopupAfterDateLoad();',
        context
    );

    assert.equal(popupOpened, true);
    assert.equal(context.stationPopupToRestore, null);
});

