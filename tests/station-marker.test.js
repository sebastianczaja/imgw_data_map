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
vm.runInContext(functionSource('buildHourlySlots', 'getMeteorologicalHourlyValue'), slotsContext);

function station(id, date = '2026-11-22') {
    const current = { Station_id: id, Station_name: id, Status: 'ACTIVE', Tmin_hour: -1, Tmax_hour: 2, Tmin: -2, Tmax: 3, Wind_max: 4, Hourly: {} };
    const previous = { Station_id: id, Hourly: {} };
    const next = { Station_id: id, Hourly: {} };
    const previousDate = new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    for (const slot of slotsContext.getMeteorologicalHourlySlots(date)) {
        const hourly = slot.date === date
            ? current.Hourly
            : slot.date === previousDate ? previous.Hourly : next.Hourly;
        if (!hourly[slot.hour]) hourly[slot.hour] = { Ta: 1, Precip: 0, Wind_avg: 2, Wind_max: 4 };
        if (slot.repeated) {
            hourly[slot.hour].UTC = hourly[slot.hour].UTC || {};
            hourly[slot.hour].UTC[slot.utc] = { Ta: 1, Precip: 0, Wind_avg: 2, Wind_max: 4 };
        }
    }
    current.Hourly['12'] = { Ta: 1, Precip: 0, Wind_avg: 2, Wind_max: 4 };
    return { current, previous, next };
}

function retainCurrentDayThroughHour(sample, hour) {
    for (const hourKey of Object.keys(sample.current.Hourly)) {
        if (Number(hourKey) > hour) delete sample.current.Hourly[hourKey];
    }
    sample.next.Hourly = {};
}

function renderMarkers(stations, date = '2026-11-22', hour = '12', latestDate = date, options = {}) {
    const markers = {};
    const TestDate = options.now ? class extends Date {
        constructor(...args) { super(...(args.length ? args : [options.now])); }
    } : Date;
    const hourlySlots = slotsContext.getMeteorologicalHourlySlots(date);
    const end = Date.parse(hourlySlots[hourlySlots.length - 1].utc);
    const days = {};
    for (let offset = 0; offset <= 30; offset++) {
        const day = new Date(end - offset * 86400000).toISOString().slice(0, 10);
        days[day] = {
            stations: Object.fromEntries(stations.map(item => [
                item.current.Station_id, offset === 1 ? [(end - 86400000) / 1000, (end - 86400000) / 1000] : null
            ])),
            ...(options.dailyParameters?.[day] ? { parameters: options.dailyParameters[day] } : {})
        };
    }
    const parameters = Object.fromEntries(stations.map(item => [
        item.current.Station_id,
        Object.fromEntries(['Ta', 'Precip', 'Wind_avg', 'Wind_max', 'Tmin', 'Tmax', 'Tg', 'Precip_24h']
            .map(key => [key, (end - 86400000) / 1000]))
    ]));
    const groups = [
        'etykietyTa', 'etykietyTmin', 'etykietyTmax', 'etykietyTminHour', 'etykietyTmaxHour',
        'etykietyTg', 'etykietyOpady24h', 'etykietyOpady10min', 'etykietyWindAvg',
        'etykietyWindMax', 'etykietyElevation', 'etykietyStationName'
    ];
    const context = vm.createContext({
        ...Object.fromEntries(groups.map(group => [group, group])),
        globalGeoJsonData: { features: stations.map(item => ({ properties: item.current })) },
        meteorologicalDate: date,
        Date: TestDate,
        meteorologicalHourlySlots: hourlySlots,
        synopticHourlySlots: slotsContext.getSynopticHourlySlots(date),
        precipitationHourlySlots: slotsContext.getHydrologicalHourlySlots(date),
        latestAvailableDate: latestDate,
        latestMeteorologicalHour: null,
        latestMeteorologicalHourByParameter: null,
        previousDayStations: new Map(stations.map(item => [item.current.Station_id, item.previous])),
        nextDayStations: new Map(stations.map(item => [item.current.Station_id, item.next])),
        stationActivityIndex: options.index
            ? { ...options.index, parameters: options.index.parameters ?? parameters }
            : { days, parameters },
        visibleStationStatuses: options.visible ?? { active: true, incomplete: true, missing: true, closed: true },
        layersControl: {},
        rankingsControl: {},
        map: { on() {} },
        clearMapData() {},
        updateRankingsPanel() {},
        updateLegendVisibility() {},
        getFreshGroundTemperature() { return null; },
        formatStationPopupTime() { return ''; },
        addDataToParamGroup(value, suffix, className, position, latlng, popup, feature, group, elevation, extreme, key, missingCurrentValue) {
            if (options.values) options.values[`${feature.properties.Station_id}:${group}`] = value;
            if ((value === null || value === undefined) && !missingCurrentValue && !key) return;
            if (!context.visibleStationStatuses[context.getMarkerStatus(feature, key)]) return;
            markers[`${feature.properties.Station_id}:${group}`] = context.getMarkerStyle(feature, key).fillColor;
        },
        L: {
            geoJSON(data, options) {
                data.features.forEach(feature => options.pointToLayer(feature, [0, 0]));
            }
        }
    });
    vm.runInContext([
        functionSource('buildHourlySlots', 'getMeteorologicalHourlyValue'),
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
        `latestMeteorologicalHour = latestAvailableDate === meteorologicalDate
            ? getLatestMeteorologicalHourlyData(globalGeoJsonData, { features: [...previousDayStations.values()].map(properties => ({ properties })) }, { features: [...nextDayStations.values()].map(properties => ({ properties })) }, meteorologicalDate)
            : null;`,
        `latestMeteorologicalHourByParameter = latestAvailableDate === meteorologicalDate
            ? Object.fromEntries(['Ta', 'Precip', 'Wind_avg', 'Wind_max'].map(parameterKey => [
                parameterKey,
                getLatestMeteorologicalHourlyData(globalGeoJsonData, { features: [...previousDayStations.values()].map(properties => ({ properties })) }, { features: [...nextDayStations.values()].map(properties => ({ properties })) }, meteorologicalDate, parameterKey)
            ]))
            : null;`,
        `renderDataForHour(${JSON.stringify(hour)});`
    ].join('\n'), context);
    return markers;
}

test('closed and missing stations have only clickable markers and remain filterable', () => {
    const layers = [];
    const popups = [];
    const context = vm.createContext({
        visibleStationStatuses: { active: true, incomplete: true, closed: true, missing: true },
        getMarkerStatus: feature => feature.properties.status,
        getMarkerStyle: () => ({ fillColor: '#b0b0b0' }),
        getRoundedNumericValue: value => value == null ? null : Number(value),
        formatValue: value => value == null ? null : String(value),
        getTemperatureStyle: () => ({ bg: 'white' }),
        getStationHighlightKey: () => '',
        map: { getSize: () => ({ x: 800, y: 600 }) },
        L: {
            circleMarker: () => ({ kind: 'marker', bindPopup(content) { popups.push(content); }, on() {} }),
            tooltip: () => ({
                kind: 'label',
                setContent() { return this; },
                setLatLng() { return this; }
            })
        }
    });
    vm.runInContext(functionSource('addDataToParamGroup', 'getSelectedTempParam'), context);
    const group = { addLayer: layer => layers.push(layer.kind) };
    const add = (status, value, key) => context.addDataToParamGroup(
        value, '', 'temp-aktualna', 'etykieta-gora', [0, 0],
        '__STATION_STATUS__', { properties: { status } }, group, false, '', key
    );

    add('closed', null, '');
    assert.deepEqual(layers, ['marker']);
    layers.length = 0;
    add('missing', null, 'Ta');
    assert.deepEqual(layers, ['marker']);
    layers.length = 0;
    popups.length = 0;
    add('active', 2, 'Ta');
    assert.deepEqual(layers, ['marker', 'label']);
    assert.match(popups[0], /border:1px solid #000/);
    assert.match(popups[0], /color:#000/);
    layers.length = 0;
    add('incomplete', null, 'Ta');
    assert.deepEqual(layers, ['marker']);
    layers.length = 0;
    add('incomplete', 0, 'Ta');
    assert.deepEqual(layers, ['marker', 'label']);
    layers.length = 0;
    context.visibleStationStatuses.incomplete = false;
    add('incomplete', null, 'Ta');
    assert.deepEqual(layers, []);
    context.visibleStationStatuses.closed = false;
    add('closed', null, 'Ta');
    assert.deepEqual(layers, []);
    context.visibleStationStatuses.missing = false;
    add('missing', null, 'Ta');
    assert.deepEqual(layers, []);
    context.visibleStationStatuses.missing = true;
    add('missing', null, 'Tmin');
    assert.deepEqual(layers, ['marker']);
});

test('meteorological slots include both boundaries in Polish local time', () => {
    for (const [date, start, end] of [
        ['2026-11-22', '07', '07'],
        ['2026-07-22', '08', '08']
    ]) {
        const slots = slotsContext.getHydrologicalHourlySlots(date);
        assert.equal(slots.length, 25);
        assert.equal(slots[0].hour, start);
        assert.equal(slots[0].date, date);
        assert.equal(slots[24].hour, end);
        const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
        assert.equal(slots[24].date, nextDate);

        const synopticSlots = slotsContext.getSynopticHourlySlots(date);
        const previousDate = new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
        assert.equal(synopticSlots.length, 25);
        assert.equal(synopticSlots[0].hour, date === '2026-11-22' ? '19' : '20');
        assert.equal(synopticSlots[0].date, previousDate);
        assert.equal(synopticSlots[24].hour, date === '2026-11-22' ? '19' : '20');
        assert.equal(synopticSlots[24].date, date);
    }
});

test('synoptic and hydrological windows use their date-specific hourly parameters', () => {
    const groupsByParameter = {
        Ta: ['etykietyTa', 'etykietyTminHour', 'etykietyTmaxHour'],
        Precip: ['etykietyOpady10min'],
        Wind_avg: ['etykietyWindAvg'],
        Wind_max: ['etykietyWindMax']
    };
    for (const [parameter, affectedGroups] of Object.entries(groupsByParameter)) {
        const sample = station(`gap-${parameter}`, '2026-11-25');
        retainCurrentDayThroughHour(sample, 10);
        delete sample.current.Hourly['08'][parameter];
        const markers = renderMarkers([sample], '2026-11-25', '10');
        for (const group of Object.values(groupsByParameter).flat()) {
            assert.equal(
                markers[`gap-${parameter}:${group}`],
                affectedGroups.includes(group) ? '#ffff00' : '#2ecc71',
                `${parameter}:${group}`
            );
        }
    }

    const completeToday = station('complete-today', '2026-11-25');
    retainCurrentDayThroughHour(completeToday, 15);
    const markers = renderMarkers([completeToday], '2026-11-25', '15');
    for (const group of Object.values(groupsByParameter).flat()) {
        assert.equal(markers[`complete-today:${group}`], '#2ecc71', group);
    }
});

test('a stalled update ignores globally unavailable later hours but still detects earlier gaps', () => {
    const complete = station('complete');
    const gap = station('gap');
    for (const sample of [complete, gap]) retainCurrentDayThroughHour(sample, 10);
    delete gap.current.Hourly['08'].Ta;
    delete gap.current.Hourly['09'].Precip;
    delete gap.current.Hourly['08'].Wind_avg;
    delete gap.current.Hourly['07'].Wind_max;
    const markers = renderMarkers([complete, gap], '2026-11-22', '10');
    for (const group of ['etykietyTa', 'etykietyTminHour', 'etykietyTmaxHour', 'etykietyOpady10min', 'etykietyWindAvg', 'etykietyWindMax']) {
        assert.equal(markers[`complete:${group}`], '#2ecc71', group);
        assert.equal(markers[`gap:${group}`], '#ffff00', group);
    }
});

test('a station without observations yet stays green before the meteorological day is complete', () => {
    const observed = station('observed');
    const waiting = station('waiting');
    for (const sample of [observed, waiting]) retainCurrentDayThroughHour(sample, 10);
    for (const hourly of [waiting.previous.Hourly, waiting.current.Hourly, waiting.next.Hourly]) {
        for (const values of Object.values(hourly)) delete values.Ta;
    }
    const markers = renderMarkers([observed, waiting], '2026-11-22', '03');
    for (const group of ['etykietyTa', 'etykietyTminHour', 'etykietyTmaxHour']) {
        assert.equal(markers[`waiting:${group}`], '#2ecc71', group);
    }
});

test('a later wind observation does not extend the Ta completeness cutoff', () => {
    const complete = station('complete');
    const gap = station('gap');
    for (const sample of [complete, gap]) {
        retainCurrentDayThroughHour(sample, 10);
        sample.current.Hourly['11'] = { Wind_max: 5 };
    }
    delete gap.current.Hourly['08'].Ta;
    const markers = renderMarkers([complete, gap], '2026-11-22', '10');
    for (const group of ['etykietyTa', 'etykietyTminHour', 'etykietyTmaxHour']) {
        assert.equal(markers[`complete:${group}`], '#2ecc71', group);
        assert.equal(markers[`gap:${group}`], '#ffff00', group);
    }
});

test('data ending at 10:00 do not mark later hours as gaps in the meteorological day', () => {
    const complete = station('complete');
    const gap = station('gap');
    for (const sample of [complete, gap]) {
        retainCurrentDayThroughHour(sample, 10);
        sample.current.Hourly['10'] = { Ta: 1, Precip: 0, Wind_avg: 2, Wind_max: 4 };
    }
    delete gap.current.Hourly['08'].Ta;
    const markers = renderMarkers([complete, gap], '2026-11-22', '10');
    assert.equal(markers['complete:etykietyTa'], '#2ecc71');
    assert.equal(markers['gap:etykietyTa'], '#ffff00');
});

test('past dates still require the complete meteorological day', () => {
    const sample = station('past');
    retainCurrentDayThroughHour(sample, 10);
    const markers = renderMarkers([sample], '2026-11-22', '03', '2026-11-23');
    assert.equal(markers['past:etykietyTa'], '#ffff00');
    assert.equal(markers['past:etykietyWindMax'], '#ffff00');
});

test('later observations after the meteorological boundary expose a missing boundary hour', () => {
    const sample = station('boundary');
    delete sample.previous.Hourly['19'].Ta;
    const markers = renderMarkers([sample], '2026-11-22', '12');
    assert.equal(markers['boundary:etykietyTa'], '#ffff00');
});

test('a later observation of one parameter does not make other parameters incomplete', () => {
    const sample = station('gap');
    retainCurrentDayThroughHour(sample, 10);
    sample.current.Hourly['11'] = { Precip: 0 };
    const markers = renderMarkers([sample], '2026-11-22', '10');
    assert.equal(markers['gap:etykietyTa'], '#2ecc71');
    assert.equal(markers['gap:etykietyOpady10min'], '#2ecc71');
    assert.equal(markers['gap:etykietyWindAvg'], '#2ecc71');
});

test('a stalled update between repeated UTC hours checks only the observed occurrence', () => {
    const sample = station('complete', '2026-10-25');
    for (const hour of Object.keys(sample.current.Hourly)) {
        if (Number(hour) > 2) delete sample.current.Hourly[hour];
    }
    delete sample.current.Hourly['02'].UTC['2026-10-25T01:00:00Z'].Ta;
    const markers = renderMarkers([sample], '2026-10-25', '01');
    assert.equal(markers['complete:etykietyTa'], '#2ecc71');
    assert.equal(markers['complete:etykietyWindMax'], '#2ecc71');
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

test('temperature markers include both synoptic boundary readings', () => {
    const complete = station('complete');
    const startGap = station('start-gap');
    const endGap = station('end-gap');
    delete startGap.previous.Hourly['19'].Ta;
    delete endGap.current.Hourly['19'].Ta;
    const markers = renderMarkers([complete, startGap, endGap]);

    for (const group of ['etykietyTa', 'etykietyTminHour', 'etykietyTmaxHour']) {
        assert.equal(markers[`complete:${group}`], '#2ecc71', group);
        assert.equal(markers[`start-gap:${group}`], '#ffff00', group);
        assert.equal(markers[`end-gap:${group}`], '#ffff00', group);
    }
    assert.equal(markers['start-gap:etykietyTmin'], '#2ecc71');
    assert.equal(markers['start-gap:etykietyTmax'], '#2ecc71');
});

test('precipitation markers include both hydrological boundary readings', () => {
    const complete = station('complete');
    const startGap = station('start-gap');
    const endGap = station('end-gap');
    delete startGap.current.Hourly['07'].Precip;
    delete endGap.next.Hourly['07'].Precip;
    const markers = renderMarkers([complete, startGap, endGap]);
    assert.equal(markers['complete:etykietyOpady10min'], '#2ecc71');
    assert.equal(markers['start-gap:etykietyOpady10min'], '#ffff00');
    assert.equal(markers['end-gap:etykietyOpady10min'], '#ffff00');
});

test('precipitation and wind markers check their own hourly series independently', () => {
    const sample = station('gap');
    delete sample.current.Hourly['10'].Precip;
    delete sample.current.Hourly['08'].Wind_avg;
    delete sample.current.Hourly['08'].Wind_max;
    const complete = station('complete');
    const markers = renderMarkers([sample, complete]);
    for (const group of ['etykietyOpady10min', 'etykietyWindAvg', 'etykietyWindMax']) {
        assert.equal(markers[`gap:${group}`], '#ffff00', group);
        assert.equal(markers[`complete:${group}`], '#2ecc71', group);
    }
    assert.equal(markers['gap:etykietyTa'], '#2ecc71');
});

test('missing next-day data does not count as complete meteorological observations', () => {
    const sample = station('missing-next');
    sample.previous.Hourly = {};
    sample.next.Hourly = {};
    const markers = renderMarkers([sample], '2026-11-22', '12', '2026-11-23');
    for (const group of ['etykietyTa', 'etykietyTminHour', 'etykietyTmaxHour', 'etykietyOpady10min', 'etykietyWindAvg', 'etykietyWindMax']) {
        assert.equal(markers[`missing-next:${group}`], '#ffff00', group);
    }
});

test('missing selected-hour Ta is yellow when later observations confirm a gap', () => {
    const missing = station('missing');
    delete missing.current.Hourly['12'].Ta;
    delete missing.current.Hourly['12'].Precip;
    delete missing.current.Hourly['12'].Wind_avg;
    missing.current.Precip_10min = 2;
    const noData = station('no-data');
    for (const hourly of [noData.previous.Hourly, noData.current.Hourly, noData.next.Hourly]) {
        for (const values of Object.values(hourly)) delete values.Ta;
    }
    const values = {};
    const markers = renderMarkers([missing, noData], '2026-11-22', '12', '2026-11-22', { values });
    assert.equal(markers['missing:etykietyTa'], '#ffff00');
    for (const group of ['etykietyOpady10min', 'etykietyWindAvg']) {
        assert.equal(markers[`missing:${group}`], '#ffff00', group);
    }
    assert.equal(values['missing:etykietyOpady10min'], null);
    assert.equal(markers['no-data:etykietyTa'], '#e74c3c');
    const filtered = renderMarkers([missing], '2026-11-22', '12', '2026-11-22', {
        visible: { active: true, incomplete: false, missing: true, closed: true }
    });
    assert.equal(filtered['missing:etykietyTa'], undefined);
    assert.equal(filtered['missing:etykietyOpady10min'], undefined);
    assert.equal(filtered['missing:etykietyWindAvg'], undefined);
});

test('30-day history determines inactive stations and filters hide each status', () => {
    const active = station('active');
    const incomplete = station('incomplete');
    const missing = station('missing');
    const closed = station('closed');
    delete incomplete.current.Hourly['08'].Ta;
    for (const hourly of [missing.previous.Hourly, missing.current.Hourly, missing.next.Hourly]) {
        for (const values of Object.values(hourly)) delete values.Ta;
    }
    const end = Date.parse('2026-11-23T06:00:00Z');
    const days = {};
    for (let offset = 0; offset <= 30; offset++) {
        const day = new Date(end - offset * 86400000).toISOString().slice(0, 10);
        days[day] = { stations: Object.fromEntries(['active', 'incomplete', 'missing', 'closed'].map(id => [
            id, id !== 'closed' && offset === 1 ? [(end - 86400000) / 1000, (end - 86400000) / 1000] : null
        ])) };
    }
    const stations = [active, incomplete, missing, closed];
    const index = { days };
    const all = renderMarkers(stations, '2026-11-22', '12', '2026-11-22', { index });
    assert.equal(all['active:etykietyTa'], '#2ecc71');
    assert.equal(all['incomplete:etykietyTa'], '#ffff00');
    assert.equal(all['missing:etykietyTa'], '#e74c3c');
    assert.equal(all['closed:etykietyTa'], '#b0b0b0');
    for (const [status, id] of Object.entries({ active: 'active', incomplete: 'incomplete', missing: 'missing', closed: 'closed' })) {
        const visible = { active: true, incomplete: true, missing: true, closed: true, [status]: false };
        const filtered = renderMarkers(stations, '2026-11-22', '12', '2026-11-22', { index, visible });
        assert.equal(filtered[`${id}:etykietyTa`], undefined);
    }
});

test('incomplete history never proves a station has been closed', () => {
    const sample = station('unknown');
    for (const hourly of [sample.previous.Hourly, sample.current.Hourly, sample.next.Hourly]) {
        for (const values of Object.values(hourly)) delete values.Ta;
    }
    const markers = renderMarkers([sample], '2026-11-22', '12', '2026-11-22', { index: { days: {} } });
    assert.equal(markers['unknown:etykietyTa'], '#ffff00');
});

test('parameters never observed in available history are not shown as missing', () => {
    const rainOnly = station('rain-only');
    const formerlyMeasured = station('previously-measured');
    const measuredLater = station('measured-later');
    for (const sample of [rainOnly, formerlyMeasured, measuredLater]) {
        for (const hourly of [sample.previous.Hourly, sample.current.Hourly, sample.next.Hourly]) {
            for (const values of Object.values(hourly)) delete values.Ta;
        }
    }
    const end = Date.parse('2026-11-23T06:00:00Z') / 1000;
    const parameters = {
        'rain-only': { Precip: end - 86400 },
        'previously-measured': { Ta: end - 86400, Precip: end - 86400 },
        'measured-later': { Ta: end + 1, Precip: end - 86400 }
    };
    const stations = [rainOnly, formerlyMeasured, measuredLater];
    const days = {};
    for (let offset = 0; offset <= 30; offset++) {
        const day = new Date((end - offset * 86400) * 1000).toISOString().slice(0, 10);
        days[day] = { stations: Object.fromEntries(stations.map(item => [
            item.current.Station_id, offset === 1 ? [end - 86400, end - 86400] : null
        ])) };
    }
    const markers = renderMarkers(stations, '2026-11-22', '12', '2026-11-22', {
        index: { days, parameters }
    });
    assert.equal(markers['rain-only:etykietyTa'], undefined);
    assert.equal(markers['rain-only:etykietyOpady10min'], '#2ecc71');
    assert.equal(markers['previously-measured:etykietyTa'], '#e74c3c');
    assert.equal(markers['measured-later:etykietyTa'], undefined);
    assert.equal(markers['rain-only:etykietyStationName'], '#2ecc71');
});

test('daily Tmin and Tmax require their own measurement history', () => {
    const never = station('never');
    const minOnly = station('min-only');
    const later = station('later');
    const current = station('current');
    const stale = station('stale');
    const samples = [never, minOnly, later, current, stale];
    for (const sample of samples) {
        sample.current.Tmin = null;
        sample.current.Tmax = null;
    }
    current.current.Tmax = 0;
    const end = Date.parse('2026-11-23T06:00:00Z') / 1000;
    const parameters = {
        never: { Ta: end - 86400 },
        'min-only': { Ta: end - 86400, Tmin: end - 86400 },
        later: { Ta: end - 86400, Tmin: end + 1, Tmax: end + 1 },
        current: { Ta: end - 86400 },
        stale: { Ta: end - 86400 }
    };
    const days = {};
    for (let offset = 0; offset <= 31; offset++) {
        const day = new Date((end - offset * 86400) * 1000).toISOString().slice(0, 10);
        days[day] = { stations: Object.fromEntries(samples.map(sample => [
            sample.current.Station_id, offset === 1 ? [end - 86400, end - 86400] : null
        ])) };
    }
    const selectedDay = Date.parse('2026-11-22T00:00:00Z') / 1000;
    const recentMinDay = new Date((selectedDay - 29 * 86400) * 1000).toISOString().slice(0, 10);
    const staleMinDay = new Date((selectedDay - 30 * 86400) * 1000).toISOString().slice(0, 10);
    days[recentMinDay].parameters = { 'min-only': 16 };
    days[staleMinDay].parameters = { stale: 16 };
    const markers = renderMarkers(samples, '2026-11-22', '12', '2026-11-23', {
        index: { days, parameters },
        dailyParameters: Object.fromEntries(Object.entries(days).map(([day, entry]) => [day, entry.parameters]))
    });
    for (const id of ['never', 'later']) {
        assert.equal(markers[`${id}:etykietyTmin`], undefined);
        assert.equal(markers[`${id}:etykietyTmax`], undefined);
        assert.equal(markers[`${id}:etykietyTa`], '#2ecc71');
    }
    assert.equal(markers['min-only:etykietyTmin'], '#e74c3c');
    assert.equal(markers['min-only:etykietyTmax'], undefined);
    assert.equal(markers['current:etykietyTmax'], '#2ecc71');
    assert.equal(markers['current:etykietyTmin'], undefined);
    assert.equal(markers['stale:etykietyTmin'], undefined);
    assert.equal(markers['never:etykietyTminHour'], '#2ecc71');
    assert.equal(markers['never:etykietyTmaxHour'], '#2ecc71');
});

test('daily extrema deadline is 22:00 in Warsaw time', () => {
    const context = vm.createContext({ Intl });
    vm.runInContext(functionSource('hasDailyExtremaDeadlinePassed', 'getStationActivity'), context);
    const deadlinePassed = context.hasDailyExtremaDeadlinePassed;
    assert.equal(deadlinePassed('2026-11-25', new Date('2026-11-25T20:59:00Z')), false);
    assert.equal(deadlinePassed('2026-11-25', new Date('2026-11-25T21:00:00Z')), true);
    assert.equal(deadlinePassed('2026-11-24', new Date('2026-11-25T12:00:00Z')), true);
    assert.equal(deadlinePassed('2026-11-26', new Date('2026-11-25T21:00:00Z')), false);
});

test('daily extrema stay hidden before 22:00 and turn into marker-only missing status after', () => {
    const pending = station('pending', '2026-11-25');
    pending.current.Tmin = null;
    pending.current.Tmax = null;
    const priorDay = '2026-11-24';
    const beforeDeadline = renderMarkers([pending], '2026-11-25', '12', '2026-11-25', {
        dailyParameters: { [priorDay]: { pending: 16 | 32 } },
        now: '2026-11-25T20:59:00Z'
    });
    const afterDeadline = renderMarkers([pending], '2026-11-25', '12', '2026-11-25', {
        dailyParameters: { [priorDay]: { pending: 16 | 32 } },
        now: '2026-11-25T21:00:00Z'
    });
    for (const group of ['etykietyTmin', 'etykietyTmax']) {
        assert.equal(beforeDeadline[`pending:${group}`], undefined);
        assert.equal(afterDeadline[`pending:${group}`], '#e74c3c');
    }
});

test('inactive stations only appear on parameter layers they have measured', () => {
    const rainOnly = station('rain-only');
    const temperature = station('temperature');
    const unknown = station('unknown');
    const recordedClosed = station('recorded-closed');
    recordedClosed.current.Status = 'CLOSED';
    const stations = [rainOnly, temperature, unknown, recordedClosed];
    for (const sample of stations) {
        sample.previous.Hourly = {};
        sample.current.Hourly = {};
        sample.next.Hourly = {};
        delete sample.current.Tmin_hour;
        delete sample.current.Tmax_hour;
        delete sample.current.Tmin;
        delete sample.current.Tmax;
        delete sample.current.Wind_max;
    }
    const end = Date.parse('2026-11-22T06:00:00Z') / 1000;
    const parameters = {
        'rain-only': { Precip: end - 40 * 86400 },
        temperature: { Ta: end - 40 * 86400 },
        unknown: {},
        'recorded-closed': { Precip: end - 40 * 86400 }
    };
    const days = {};
    for (let offset = 0; offset <= 30; offset++) {
        const day = new Date((end - offset * 86400) * 1000).toISOString().slice(0, 10);
        days[day] = { stations: { 'rain-only': null, temperature: null, unknown: null } };
    }
    const markers = renderMarkers(stations, '2026-11-22', '12', '2026-11-22', {
        index: { days, parameters }
    });
    assert.equal(markers['rain-only:etykietyTa'], undefined);
    assert.equal(markers['rain-only:etykietyOpady10min'], '#b0b0b0');
    assert.equal(markers['rain-only:etykietyStationName'], '#b0b0b0');
    assert.equal(markers['temperature:etykietyTa'], '#b0b0b0');
    assert.equal(markers['unknown:etykietyTa'], undefined);
    assert.equal(markers['recorded-closed:etykietyTa'], undefined);
    assert.equal(markers['recorded-closed:etykietyOpady10min'], '#b0b0b0');
});

test('a measured value after a missing slot exposes a gap in the current day', () => {
    const sample = station('partial');
    for (const hourly of [sample.previous.Hourly, sample.current.Hourly, sample.next.Hourly]) {
        for (const values of Object.values(hourly)) delete values.Ta;
    }
    sample.next.Hourly = {};
    sample.current.Hourly['08'].Ta = 1;
    sample.current.Hourly['09'].Ta = 2;
    const markers = renderMarkers([sample], '2026-11-22', '09');
    assert.equal(markers['partial:etykietyTa'], '#ffff00');
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
