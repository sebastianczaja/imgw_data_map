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
const slotsContext = vm.createContext({});
vm.runInContext(functionSource('getMeteorologicalHourlySlots', 'getMeteorologicalHourlyValue'), slotsContext);

function station(id, date = '2026-11-22') {
    const current = { Station_id: id, Station_name: id, Status: 'ACTIVE', Tmin_hour: -1, Tmax_hour: 2, Tmin: -2, Tmax: 3, Wind_max: 4, Hourly: {} };
    const previous = { Station_id: id, Hourly: {} };
    for (const slot of slotsContext.getMeteorologicalHourlySlots(date)) {
        const hourly = slot.date === date ? current.Hourly : previous.Hourly;
        if (!hourly[slot.hour]) hourly[slot.hour] = { Ta: 1, Precip: 0, Wind_avg: 2, Wind_max: 4 };
        if (slot.repeated) {
            hourly[slot.hour].UTC = hourly[slot.hour].UTC || {};
            hourly[slot.hour].UTC[slot.utc] = { Ta: 1, Precip: 0, Wind_avg: 2, Wind_max: 4 };
        }
    }
    current.Hourly['12'] = { Ta: 1, Precip: 0, Wind_avg: 2, Wind_max: 4 };
    return { current, previous };
}

function renderMarkers(stations, date = '2026-11-22') {
    const markers = {};
    const groups = [
        'etykietyTa', 'etykietyTmin', 'etykietyTmax', 'etykietyTminHour', 'etykietyTmaxHour',
        'etykietyTg', 'etykietyOpady24h', 'etykietyOpady10min', 'etykietyWindAvg',
        'etykietyWindMax', 'etykietyElevation', 'etykietyStationName'
    ];
    const context = vm.createContext({
        ...Object.fromEntries(groups.map(group => [group, group])),
        globalGeoJsonData: { features: stations.map(item => ({ properties: item.current })) },
        meteorologicalDate: date,
        meteorologicalHourlySlots: slotsContext.getMeteorologicalHourlySlots(date),
        previousDayStations: new Map(stations.map(item => [item.current.Station_id, item.previous])),
        layersControl: {},
        rankingsControl: {},
        map: { on() {} },
        clearMapData() {},
        updateRankingsPanel() {},
        updateLegendVisibility() {},
        getFreshGroundTemperature() { return null; },
        formatStationPopupTime() { return ''; },
        addDataToParamGroup(value, suffix, className, position, latlng, popup, feature, group, elevation, extreme, key, missingCurrentValue) {
            if ((value === null || value === undefined) && !missingCurrentValue) return;
            markers[`${feature.properties.Station_id}:${group}`] = missingCurrentValue
                ? '#e74c3c' : context.getMarkerStyle(feature, key).fillColor;
        },
        L: {
            geoJSON(data, options) {
                data.features.forEach(feature => options.pointToLayer(feature, [0, 0]));
            }
        }
    });
    vm.runInContext([
        functionSource('getMeteorologicalHourlyValue', 'hasMeteorologicalHourlyValue'),
        functionSource('hasMeteorologicalHourlyValue', 'hasCompleteHourlyData'),
        functionSource('hasCompleteHourlyData', 'hasAnyMeteorologicalHourlyData'),
        functionSource('hasAnyMeteorologicalHourlyData', 'getMarkerStyle'),
        functionSource('getMarkerStyle', 'formatValue'),
        functionSource('formatValue', 'getRoundedNumericValue'),
        functionSource('getRoundedNumericValue', 'convertMetersPerSecondToKilometersPerHour'),
        source.slice(source.indexOf('function convertMetersPerSecondToKilometersPerHour('), source.indexOf('const tempScale = [')),
        functionSource('formatStationPopupValue', 'renderDataForHour'),
        functionSource('renderDataForHour', 'escapeHtml'),
        "renderDataForHour('12');"
    ].join('\n'), context);
    return markers;
}

test('meteorological slots include both boundaries in Polish local time', () => {
    for (const [date, start, end] of [
        ['2026-11-22', '07', '07'],
        ['2026-07-22', '08', '08']
    ]) {
        const slots = slotsContext.getMeteorologicalHourlySlots(date);
        assert.equal(slots.length, 25);
        assert.equal(slots[0].hour, start);
        assert.equal(slots[24].hour, end);
        assert.equal(slots[24].date, date);
    }
});

test('UTC metadata alone does not count as an available hourly measurement', () => {
    const context = vm.createContext({});
    vm.runInContext(functionSource('getLastAvailableHourFromData', 'processData'), context);
    const data = { features: [{ properties: {
        Status: 'ACTIVE',
        Hourly: { '03': { Precip: 0 }, '23': { UTC: { slot: {} } } }
    } }] };
    assert.equal(context.getLastAvailableHourFromData(data, 'Ta'), 3);
});

test('temperature markers include both meteorological boundary readings', () => {
    const complete = station('complete');
    const startGap = station('start-gap');
    const endGap = station('end-gap');
    delete startGap.previous.Hourly['07'].Ta;
    delete endGap.current.Hourly['07'].Ta;
    const markers = renderMarkers([complete, startGap, endGap]);

    for (const group of ['etykietyTa', 'etykietyTminHour', 'etykietyTmaxHour']) {
        assert.equal(markers[`complete:${group}`], '#2ecc71', group);
        assert.equal(markers[`start-gap:${group}`], '#ffff00', group);
        assert.equal(markers[`end-gap:${group}`], '#ffff00', group);
    }
    assert.equal(markers['start-gap:etykietyTmin'], '#2ecc71');
    assert.equal(markers['start-gap:etykietyTmax'], '#2ecc71');
});

test('precipitation and wind markers check their own hourly series independently', () => {
    const sample = station('gap');
    delete sample.previous.Hourly['10'].Precip;
    delete sample.current.Hourly['05'].Wind_avg;
    delete sample.previous.Hourly['23'].Wind_max;
    const complete = station('complete');
    const markers = renderMarkers([sample, complete]);
    for (const group of ['etykietyOpady10min', 'etykietyWindAvg', 'etykietyWindMax']) {
        assert.equal(markers[`gap:${group}`], '#ffff00', group);
        assert.equal(markers[`complete:${group}`], '#2ecc71', group);
    }
    assert.equal(markers['gap:etykietyTa'], '#2ecc71');
});

test('missing previous-day data does not mark meteorological observations as complete', () => {
    const sample = station('missing-previous');
    sample.previous.Hourly = {};
    const markers = renderMarkers([sample]);
    for (const group of ['etykietyTa', 'etykietyTminHour', 'etykietyTmaxHour', 'etykietyOpady10min', 'etykietyWindAvg', 'etykietyWindMax']) {
        assert.equal(markers[`missing-previous:${group}`], '#ffff00', group);
    }
});

test('missing selected-hour Ta is red only when the meteorological day contains Ta', () => {
    const missing = station('missing');
    delete missing.current.Hourly['12'].Ta;
    const noData = station('no-data');
    for (const hourly of [noData.current.Hourly, noData.previous.Hourly]) {
        for (const values of Object.values(hourly)) delete values.Ta;
    }
    const markers = renderMarkers([missing, noData]);
    assert.equal(markers['missing:etykietyTa'], '#e74c3c');
    assert.equal(markers['no-data:etykietyTa'], undefined);
});

test('both repeated UTC hours must have the relevant measurements', () => {
    const complete = station('complete', '2026-10-25');
    const missing = station('missing', '2026-10-25');
    const unknown = station('unknown', '2026-10-25');
    delete missing.current.Hourly['02'].UTC['2026-10-25T01:00:00Z'].Ta;
    delete missing.current.Hourly['02'].UTC['2026-10-25T00:00:00Z'].Wind_max;
    delete unknown.current.Hourly['02'].UTC;
    const markers = renderMarkers([complete, missing, unknown], '2026-10-25');
    for (const group of ['etykietyTa', 'etykietyTminHour', 'etykietyTmaxHour']) {
        assert.equal(markers[`complete:${group}`], '#2ecc71');
        assert.equal(markers[`missing:${group}`], '#ffff00');
        assert.equal(markers[`unknown:${group}`], '#ffff00');
    }
    assert.equal(markers['complete:etykietyWindMax'], '#2ecc71');
    assert.equal(markers['missing:etykietyWindMax'], '#ffff00');
    assert.equal(markers['missing:etykietyOpady10min'], '#2ecc71');
});
