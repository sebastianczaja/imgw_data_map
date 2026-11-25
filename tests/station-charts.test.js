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

function getChartData(properties, parameter) {
    const context = vm.createContext({
        getRoundedNumericValue(value, decimals = 1) {
            if (value === undefined || value === null || value === '' || !Number.isFinite(Number(value))) return null;
            return Number(Number(value).toFixed(decimals));
        },
        convertMetersPerSecondToKilometersPerHour(value) {
            return Number((Number(value) * 3.6).toFixed(1));
        }
    });
    vm.runInContext(
        functionSource('getStationChartTimestampHour', 'formatStationChartHour'),
        context
    );
    return context.getStationChartData(properties, parameter);
}

const temperature = { key: 'Ta', label: 'Temperatura', unit: '°C', color: '#f00' };
const precipitation = { key: 'Precip_hour', label: 'Opad', unit: 'mm', color: '#00f' };
const wind = { key: 'Wind_avg', label: 'Wiatr', unit: 'km/h', color: '#808' };

function renderChart(points, extraSeries = []) {
    const context = vm.createContext({
        escapeHtml(value) {
            return String(value ?? '').replace(/[&<>'"]/g, '');
        }
    });
    vm.runInContext(
        functionSource('formatStationChartHour', 'openStationCharts'),
        context
    );
    return context.renderStationChart([
        { parameter: temperature, chartData: { points } },
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

test('hourly chart data uses available local-hour readings and converts wind speed', () => {
    const wind = getChartData(
        { Hourly: { '00': { Wind_avg: 2 }, '01': {}, '03': { Wind_avg: 4.5 } } },
        { hourlyKey: 'Wind_avg', valueKey: 'Wind_avg', convertWindSpeed: true }
    );

    assert.deepEqual(
        Array.from(wind.points, point => [point.hour, point.value]),
        [[0, 7.2], [3, 16.2]]
    );
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
        { hour: 0, value: -2.5 },
        { hour: 1, value: 3.2 },
        { hour: 2, value: 4.1 }
    ]);

    assert.equal((html.match(/class="station-chart-value-label"/g) || []).length, 3);
    assert.equal((html.match(/class="station-chart-hour-gridline"/g) || []).length, 24);
    assert.equal((html.match(/class="station-chart-x-label"/g) || []).length, 24);
    assert.match(html, /<th scope="row">00:00<\/th><td>-2\.5 °C<\/td>/);
    assert.match(html, /<th scope="row">01:00<\/th><td>3\.2 °C<\/td>/);
    assert.match(html, /<th scope="row">02:00<\/th><td>4\.1 °C<\/td>/);
    assert.match(html, />23:00<\/text>/);
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
    const columns = [...table.matchAll(/<th scope="col" title="[^"]*">.*?<\/span>([^<]+)<\/th>/g)]
        .map(match => match[1]);
    assert.deepEqual(columns, [
        'Ta', 'Precip_hour', 'Wind_avg', 'Wind_max'
    ]);
    assert.match(table, /<th scope="col">Godzina<\/th>/);
    assert.equal((table.match(/<th scope="row">/g) || []).length, 24);
    assert.match(table, /<th scope="row">00:00<\/th><td>0\.0 °C<\/td><td>Brak danych<\/td><td>7\.2 km\/h<\/td><td>10\.8 km\/h<\/td>/);
    assert.match(table, /<th scope="row">01:00<\/th><td>Brak danych<\/td><td>0\.0 mm<\/td>/);
    assert.match(table, /<th scope="row">02:00<\/th><td>3\.0 °C<\/td>/);
    assert.match(table, /<th scope="row">23:00<\/th>/);
});

test('chart range follows data with at least three units of padding', () => {
    const context = vm.createContext({});
    vm.runInContext(functionSource('getStationChartRange', 'renderStationChart'), context);
    const range = points => context.getStationChartRange([{ chartData: { points } }]);
    assert.deepEqual({ ...range([{ value: -2.5 }, { value: 4.1 }]) }, { min: -6, max: 8 });
    assert.deepEqual({ ...range([{ value: 0 }]) }, { min: -3, max: 3 });
    assert.deepEqual({ ...context.getStationChartRange([
        { chartData: { points: [{ value: 2.2 }] } },
        { chartData: { points: [{ value: 17.1 }] } }
    ]) }, { min: -1, max: 21 });
    assert.equal(range([{ value: Number.MAX_VALUE }]), null);
});

test('extreme observations fit within the plot rather than being clipped', () => {
    const html = renderChart([
        { hour: 0, value: 50 },
        { hour: 1, value: -50 }
    ]);

    assert.match(html, />-50\.0<\/text>/);
    assert.match(html, />0\.0<\/text>/);
    assert.match(html, />50\.0<\/text>/);
    assert.doesNotMatch(html, /station-chart-point-out-of-range/);
    const pointYs = [...html.matchAll(/<circle cx="[^"]+" cy="([^"]+)" r="3.5"/g)]
        .map(match => Number(match[1]));
    assert.equal(pointYs.length, 2);
    assert.ok(pointYs[0] > 60 && pointYs[0] < 283);
    assert.ok(pointYs[1] > 283 && pointYs[1] < 506);
    assert.match(html, /<th scope="row">00:00<\/th><td>50\.0 °C<\/td>/);
    assert.match(html, /<th scope="row">01:00<\/th><td>-50\.0 °C<\/td>/);
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
    for (const [index, range] of [[0, 46], [1, 6], [2, 6]]) {
        assert.equal((plots[index].match(/class="station-chart-hour-gridline"/g) || []).length, 24);
        assert.equal((plots[index].match(/class="station-chart-gridline"/g) || []).length, 1);
        const gridY = [...plots[index].matchAll(/<line x1="[^"]+" y1="([^"]+)"[^>]+class="station-chart-gridline-minor"/g)]
            .map(match => Number(match[1]));
        assert.equal(gridY.length, 4);
        for (let i = 0; i < gridY.length; i++) {
            assert.ok(Math.abs(gridY[i] - (i + 1) * 446 / range) < 1e-9);
        }
        const height = Number(plots[index].match(/<pattern[^>]+height="([^"]+)"/)[1]);
        assert.ok(Math.abs(height - 5 * 446 / range) < 1e-9);
    }
    assert.match(plots[1], />12\.0<\/text>/);
    assert.match(plots[1], />18\.0<\/text>/);
    assert.match(plots[2], />97\.0<\/text>/);
    assert.match(plots[2], />103\.0<\/text>/);
    assert.match(html, /<th scope="row">00:00<\/th><td>0\.0 °C<\/td><td>15\.0 mm<\/td><td>100\.0 km\/h<\/td><td>100\.0 km\/h<\/td>/);
    assert.equal((html.match(/<polyline /g) || []).length, 0);
    const labelYs = [...plots[2].matchAll(/<text x="55" y="([^"]*)" class="station-chart-value-label"/g)]
        .map(match => Number(match[1]));
    assert.equal(new Set(labelYs).size, 2);
    assert.ok(labelYs.every(y => y < 283));
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
        datePicker: { value: '2026-11-22' }
    };
    const context = vm.createContext({
        document: { getElementById: id => nodes[id] },
        escapeHtml: value => String(value),
        getRoundedNumericValue: value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(1)),
        convertMetersPerSecondToKilometersPerHour: value => Number((value * 3.6).toFixed(1))
    });
    vm.runInContext(
        source.slice(source.indexOf('const stationChartParameters = ['), source.indexOf('];', source.indexOf('const stationChartParameters = [')) + 2)
        + '\n' + functionSource('getStationChartData', 'initStationChartsDialog'),
        context
    );
    context.openStationCharts({
        Station_name: 'Alfa',
        Wind_max: 20,
        Hourly: { '00': { Ta: 0, Precip: 0, Wind_avg: 2 } }
    });
    assert.deepEqual(checks.map(check => check.dataset.chartParameter), ['Ta', 'Precip_hour', 'Wind_avg', 'Wind_max']);
    assert.equal(checks[3].disabled, true);
    assert.equal((content.innerHTML.match(/<svg /g) || []).length, 3);
    assert.match(content.innerHTML, /7\.2 km\/h/);
    checks[1].checked = false;
    checks[1].onChange();
    assert.equal((content.innerHTML.match(/<svg /g) || []).length, 2);
    assert.doesNotMatch(content.innerHTML, /0\.0 mm/);
    assert.doesNotMatch(content.innerHTML, />Precip_hour<\/th>/);
    assert.match(content.innerHTML, /7\.2 km\/h/);
    checks.forEach(check => { check.checked = false; });
    checks[0].onChange();
    assert.match(content.innerHTML, /Zaznacz zmienną/);
});

