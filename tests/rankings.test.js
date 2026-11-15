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

function renderRanking(parameter, direction, sort, features, ranking = 'temperature', secondarySort = { sort: 'value', direction: 'highest' }) {
    const groups = ['Ta', 'Tmin_hour', 'Tmax_hour', 'Tmin', 'Tmax', 'Tg'];
    const tempLayerMapping = groups.map(key => ({ key, shortName: key, group: key }));
    const selectedLayers = Array.isArray(parameter) ? parameter : [parameter];
    const elements = {};
    const container = {
        querySelector(selector) {
            if (!elements[selector]) {
                elements[selector] = {
                    innerHTML: '',
                    setAttribute() {},
                    closest() { return this; }
                };
            }
            return elements[selector];
        }
    };
    const context = vm.createContext({
        tempLayerMapping,
        map: { hasLayer: layer => selectedLayers.includes(layer) },
        etykietyOpady24h: 'Precip_24h',
        etykietyOpady10min: 'Precip_hour',
        etykietyWindAvg: 'Wind_avg',
        etykietyWindMax: 'Wind_max',
        rankingsControl: { getContainer: () => container },
        globalGeoJsonData: { features },
        currentHourStr: '12',
        temperatureRankingDirection: direction,
        temperatureRankingSort: sort,
        secondaryRankingSorts: { precipitation: secondarySort, wind: secondarySort },
        document: { getElementById: () => ({ value: '2026-11-15' }) }
    });
    vm.runInContext([
        functionSource('formatValue', 'getRoundedNumericValue'),
        functionSource('getRoundedNumericValue', 'convertMetersPerSecondToKilometersPerHour'),
        functionSource('convertMetersPerSecondToKilometersPerHour', 'getLabelScaleColor'),
        functionSource('getSelectedTempParam', 'getFreshGroundTemperature'),
        functionSource('getFreshGroundTemperature', 'getFeatureTempValue'),
        source.slice(source.indexOf('function getFeatureTempValue('), source.indexOf('\n}', source.indexOf('function getFeatureTempValue(')) + 2),
        functionSource('escapeHtml', 'buildRankingsControl'),
        functionSource('updateRankingsPanel', 'showNoDataState'),
        "let activeTempParam = 'Ta'; updateRankingsPanel('12');"
    ].join('\n'), context);
    return elements[`[data-ranking="${ranking}"]`].innerHTML;
}

function station(name, value, status = 'ACTIVE') {
    return { properties: {
        Station_name: name, Status: status,
        Hourly: { '12': { Ta: value } },
        Tmin_hour: value, Tmax_hour: value, Tmin: value, Tmax: value,
        Tg: value, Tg_time: '2026-11-15 06:00', Precip_24h: value
    } };
}

function rowFor(html, name) {
    return html.match(new RegExp(`<tr>[^<]*<td[^>]*>[^<]*</td><td[^>]*>${name}</td><td[^>]*>[^<]*</td></tr>`))?.[0];
}

test('all temperature parameters highlight both extremes for every sort order', () => {
    const features = [
        station('Zulu', 10.04), station('Alfa', -2), station('Beta', 4),
        station('Gamma', 10.03), station('Delta', -2), station('Inactive', 100, 'INACTIVE'),
        station('Missing', null)
    ];
    for (const parameter of ['Ta', 'Tmin_hour', 'Tmax_hour', 'Tmin', 'Tmax', 'Tg']) {
        for (const direction of ['highest', 'lowest']) {
            for (const sort of ['value', 'alphabetical-asc', 'alphabetical-desc']) {
                const html = renderRanking(parameter, direction, sort, features);
                for (const name of ['Zulu', 'Gamma']) {
                    assert.match(rowFor(html, name), /ranking-value-highlight/, `${parameter} ${direction} ${sort} ${name}`);
                }
                for (const name of ['Alfa', 'Delta']) {
                    assert.match(rowFor(html, name), /ranking-value-lowest-highlight/, `${parameter} ${direction} ${sort} ${name}`);
                }
                assert.doesNotMatch(rowFor(html, 'Beta'), /highlight/);
                assert.doesNotMatch(html, /Inactive|Missing/);
            }
        }
    }
});

test('equal temperature extremes keep the maximum color, as on the map', () => {
    const html = renderRanking('Ta', 'lowest', 'value', [station('Alfa', 2), station('Beta', 2)]);
    assert.match(rowFor(html, 'Alfa'), /ranking-value-highlight/);
    assert.doesNotMatch(html, /ranking-value-lowest-highlight/);
});

test('non-temperature ranking retains its direction-dependent highlight', () => {
    const features = [station('Alfa', 1), station('Beta', 3)];
    const highest = renderRanking('Precip_24h', 'highest', 'value', features);
    assert.match(rowFor(highest, 'Beta'), /ranking-value-highlight/);
    assert.doesNotMatch(rowFor(highest, 'Alfa'), /highlight/);
    const lowest = renderRanking('Precip_24h', 'lowest', 'alphabetical-asc', features);
    assert.match(rowFor(lowest, 'Alfa'), /ranking-value-lowest-highlight/);
    assert.doesNotMatch(rowFor(lowest, 'Beta'), /highlight/);
});

test('all rankings show station elevation in a separate column', () => {
    const features = [station('Alfa', 1), station('Beta', 3), station('Gamma', 2)];
    features[0].properties.Elevation = 123.6;
    features[1].properties.Elevation = 0;
    features[2].properties.Elevation = '  ';
    features.forEach(feature => { feature.properties.Wind_max = 2; });
    for (const ranking of ['temperature', 'precipitation', 'wind']) {
        const html = renderRanking(['Ta', 'Precip_24h', 'Wind_max'], 'highest', 'value', features, ranking);
        assert.match(rowFor(html, 'Alfa'), /<td class="ranking-elevation[^"]*">124<\/td>/);
        assert.match(rowFor(html, 'Beta'), /<td class="ranking-elevation[^"]*">0<\/td>/);
        assert.match(rowFor(html, 'Gamma'), /<td class="ranking-elevation[^"]*">—<\/td>/);
    }
});

test('extreme rows highlight every cell, including missing elevation', () => {
    const features = [station('Alfa', 1), station('Beta', 3), station('Gamma', 3), station('Delta', 2)];
    features.forEach(feature => { feature.properties.Wind_max = feature.properties.Precip_24h; });
    for (const ranking of ['temperature', 'precipitation', 'wind']) {
        const html = renderRanking(['Ta', 'Precip_24h', 'Wind_max'], 'highest', 'alphabetical-asc', features, ranking);
        for (const name of ['Beta', 'Gamma']) {
            assert.equal((rowFor(html, name).match(/ranking-value-highlight/g) || []).length, 3);
        }
        assert.doesNotMatch(rowFor(html, 'Delta'), /highlight/);
        if (ranking === 'temperature') {
            assert.equal((rowFor(html, 'Alfa').match(/ranking-value-lowest-highlight/g) || []).length, 3);
        } else {
            assert.doesNotMatch(rowFor(html, 'Alfa'), /highlight/);
        }
    }
});

test('empty rankings span all three columns', () => {
    assert.match(renderRanking('Ta', 'highest', 'value', []), /colspan="3">Brak danych/);
});

test('sorting by elevation keeps missing values last and preserves extremes', () => {
    const features = [station('Alfa', 1), station('Beta', 3), station('Gamma', 2), station('Delta', 4)];
    features[0].properties.Elevation = 200;
    features[1].properties.Elevation = 0;
    features[2].properties.Elevation = null;
    features[3].properties.Elevation = 100;
    const stationOrder = html => [...html.matchAll(/class="ranking-station[^"]*">([^<]+)<\/td>/g)].map(match => match[1]);
    for (const ranking of ['temperature', 'precipitation', 'wind']) {
        features.forEach(feature => { feature.properties.Wind_max = feature.properties.Precip_24h; });
        for (const [sort, expected] of [
            ['elevation-asc', ['Beta', 'Delta', 'Alfa', 'Gamma']],
            ['elevation-desc', ['Alfa', 'Delta', 'Beta', 'Gamma']]
        ]) {
            const html = renderRanking(['Ta', 'Precip_24h', 'Wind_max'], 'highest', sort, features, ranking, { sort, direction: 'highest' });
            assert.deepEqual(stationOrder(html), expected);
            assert.match(rowFor(html, 'Delta'), /ranking-value-highlight/);
        }
    }
});

test('column clicks toggle sorting independently and save the primary ranking', () => {
    const buttons = {};
    const button = name => buttons[name] = { addEventListener: (event, handler) => { buttons[name].click = handler; } };
    const controls = {
        '.rankings-toggle': button('toggle')
    };
    const tables = ['temperature', 'precipitation', 'wind'].map(name => ({
        dataset: { rankingTable: name },
        querySelectorAll: () => ['value', 'alphabetical', 'elevation'].map(column => {
            const element = button(`${name}-${column}`);
            element.dataset = { rankingColumn: column };
            return element;
        })
    }));
    const div = {
        querySelector: selector => controls[selector],
        querySelectorAll: () => tables
    };
    const saved = [];
    const context = vm.createContext({
        rankingsControl: null,
        map: {},
        currentHourStr: '12',
        temperatureRankingSort: 'value',
        temperatureRankingDirection: 'highest',
        secondaryRankingSorts: {
            precipitation: { sort: 'value', direction: 'highest' },
            wind: { sort: 'value', direction: 'highest' }
        },
        loadMapPreferences: () => ({}),
        saveMapPreferences: (...args) => saved.push(args.slice(-2)),
        updateRankingsPanel() {},
        L: {
            control: () => ({ addTo() { this.onAdd(); } }),
            DomUtil: { create: () => div },
            DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {} }
        }
    });
    vm.runInContext(functionSource('buildRankingsControl', 'updateRankingsPanel') + '\nbuildRankingsControl();', context);

    assert.match(div.innerHTML, /<section class="ranking-section">\s*<div class="ranking-table-wrap"><table data-ranking-table="temperature">/);
    buttons['temperature-value'].click();
    assert.deepEqual(saved.at(-1), ['lowest', 'value']);
    buttons['temperature-alphabetical'].click();
    buttons['temperature-alphabetical'].click();
    assert.deepEqual(saved.at(-1), ['lowest', 'alphabetical-desc']);
    buttons['temperature-elevation'].click();
    assert.deepEqual(saved.at(-1), ['lowest', 'elevation-asc']);
    buttons['temperature-elevation'].click();
    assert.deepEqual(saved.at(-1), ['lowest', 'elevation-desc']);
    const savedCount = saved.length;
    buttons['precipitation-value'].click();
    buttons['wind-elevation'].click();
    assert.equal(context.secondaryRankingSorts.precipitation.direction, 'lowest');
    assert.equal(context.secondaryRankingSorts.wind.sort, 'elevation-asc');
    assert.equal(context.secondaryRankingSorts.precipitation.sort, 'value');
    assert.equal(saved.length, savedCount);
});
