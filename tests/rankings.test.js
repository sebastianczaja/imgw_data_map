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

function renderRanking(parameter, direction, sort, features) {
    const groups = ['Ta', 'Tmin_hour', 'Tmax_hour', 'Tmin', 'Tmax', 'Tg'];
    const tempLayerMapping = groups.map(key => ({ key, shortName: key, group: key }));
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
        map: { hasLayer: layer => layer === parameter },
        etykietyOpady24h: 'Precip_24h',
        etykietyOpady10min: 'Precip_hour',
        etykietyWindAvg: 'Wind_avg',
        etykietyWindMax: 'Wind_max',
        rankingsControl: { getContainer: () => container },
        globalGeoJsonData: { features },
        currentHourStr: '12',
        temperatureRankingDirection: direction,
        temperatureRankingSort: sort,
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
    return elements['[data-ranking="temperature"]'].innerHTML;
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
    return html.match(new RegExp(`<tr>[^<]*<td[^>]*>[^<]*</td><td[^>]*>${name}</td></tr>`))?.[0];
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
