const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
});

const esriSatelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
});

const cartoDbDark = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20,
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), and the GIS User Community'
});

const darkMapReference = L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20,
    opacity: 0.7,
    attribution: 'Granice i miejscowości &copy; Esri'
});

const openTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: 'Map data &copy; OpenStreetMap contributors'
});

let activeBaseLayer = openTopo;
const mapPreferencesStorageKey = 'imgw_map_preferences';

function loadMapPreferences() {
    const defaults = {
        baseLayer: 'topo',
        opacity: 1,
        parameters: ['Temperatura aktualna (Ta)'],
        temperatureRankingDirection: 'highest',
        temperatureRankingSort: 'value'
    };

    try {
        const savedPreferences = JSON.parse(localStorage.getItem(mapPreferencesStorageKey));
        if (!savedPreferences || typeof savedPreferences !== 'object') return defaults;

        return {
            baseLayer: ['osm', 'esri', 'carto', 'topo'].includes(savedPreferences.baseLayer)
                ? savedPreferences.baseLayer
                : defaults.baseLayer,
            opacity: Number.isFinite(Number(savedPreferences.opacity))
                ? Math.min(1, Math.max(0, Number(savedPreferences.opacity)))
                : defaults.opacity,
            parameters: Array.isArray(savedPreferences.parameters)
                ? savedPreferences.parameters
                : defaults.parameters,
            temperatureRankingDirection: ['highest', 'lowest'].includes(savedPreferences.temperatureRankingDirection)
                ? savedPreferences.temperatureRankingDirection
                : 'highest',
            temperatureRankingSort: savedPreferences.temperatureRankingSort === 'alphabetical'
                ? 'alphabetical-asc'
                : ['value', 'alphabetical-asc', 'alphabetical-desc', 'elevation-asc', 'elevation-desc'].includes(savedPreferences.temperatureRankingSort)
                    ? savedPreferences.temperatureRankingSort
                    : 'value'
        };
    } catch (error) {
        return defaults;
    }
}

const initialMapPreferences = loadMapPreferences();
let temperatureRankingDirection = initialMapPreferences.temperatureRankingDirection;
let temperatureRankingSort = initialMapPreferences.temperatureRankingSort;
const secondaryRankingSorts = {
    precipitation: { sort: 'value', direction: 'highest' },
    wind: { sort: 'value', direction: 'highest' }
};

function saveMapPreferences(baseLayer, opacity, parameters, rankingDirection, rankingSort) {
    try {
        localStorage.setItem(mapPreferencesStorageKey, JSON.stringify({
            baseLayer,
            opacity,
            parameters,
            temperatureRankingDirection: rankingDirection,
            temperatureRankingSort: rankingSort
        }));
    } catch (error) {
        console.warn('Nie udało się zapisać ustawień mapy:', error);
    }
}

const map = L.map('map', {
    center: [52.218811, 19.479699],
    zoom: 6.7,
    zoomSnap: 0.1,
    layers: [openTopo],
    zoomControl: false,
    keyboard: false
});

map.setView([52.218811, 19.479699], 6.7);
map.invalidateSize();
map.whenReady(() => {
    setTimeout(() => {
        map.panBy([0, 36], { animate: false });
    }, 60);
});

// layer groups
const etykietyTa = L.layerGroup();
const etykietyTmin = L.layerGroup();
const etykietyTmax = L.layerGroup();
const etykietyTminHour = L.layerGroup();
const etykietyTmaxHour = L.layerGroup();
const etykietyTg = L.layerGroup();
const etykietyOpady24h = L.layerGroup();
const etykietyOpady10min = L.layerGroup();
const etykietyWindAvg = L.layerGroup();
const etykietyWindMax = L.layerGroup();
const etykietyElevation = L.layerGroup();
const etykietyStationName = L.layerGroup();

let hoveredRankingStationId = null;

function getStationHighlightKey(properties) {
    return String(properties?.Station_id ?? properties?.Station_name ?? '');
}

function setStationLabelHighlight(label, highlighted) {
    if (highlighted && !label.style.getPropertyValue('--station-highlight-color')) {
        const backgroundElement = label.firstElementChild || label;
        label.style.setProperty(
            '--station-highlight-color',
            getComputedStyle(backgroundElement).backgroundColor
        );
    }
    label.classList.toggle('ranking-station-hover', highlighted);
}

function setHoveredRankingStation(stationId, rankingRow = null) {
    hoveredRankingStationId = stationId;
    document.querySelectorAll('.stacja-etykieta[data-station-id]').forEach(label => {
        setStationLabelHighlight(label, stationId !== null && label.dataset.stationId === stationId);
    });
    document.querySelectorAll('.ranking-section tr.ranking-row-hover').forEach(row => {
        row.classList.remove('ranking-row-hover');
        row.style.removeProperty('--station-highlight-color');
    });
    if (rankingRow) {
        rankingRow.style.setProperty('--station-highlight-color', rankingRow.dataset.highlightColor);
        rankingRow.classList.add('ranking-row-hover');
    }
}

const tempLayerMapping = [
    { key: 'Ta', label: 'Temperatura aktualna (Ta)', shortName: 'Ta', group: etykietyTa },
    { key: 'Tmin_hour', label: 'Temperatura min. godzinowa (Tmin_hour)', shortName: 'Tmin_hour', group: etykietyTminHour },
    { key: 'Tmax_hour', label: 'Temperatura max. godzinowa (Tmax_hour)', shortName: 'Tmax_hour', group: etykietyTmaxHour },
    { key: 'Tmin', label: 'Temperatura minimalna (Tmin)', shortName: 'Tmin', group: etykietyTmin },
    { key: 'Tmax', label: 'Temperatura maksymalna (Tmax)', shortName: 'Tmax', group: etykietyTmax },
    { key: 'Tg', label: 'Temperatura przy gruncie (Tg)', shortName: 'Tg', group: etykietyTg }
];

const rankingParameterDefinitions = [
    ...tempLayerMapping.map(parameter => ({
        key: parameter.key,
        shortName: parameter.shortName,
        unit: '°C',
        category: 'temperature'
    })),
    { key: 'Precip_24h', shortName: 'Precip_24h', unit: 'mm', category: 'precipitation' },
    { key: 'Precip_hour', shortName: 'Precip_hour', unit: 'mm', category: 'precipitation' },
    { key: 'Wind_avg', shortName: 'Wind_avg', unit: 'km/h', category: 'wind' },
    { key: 'Wind_max', shortName: 'Wind_max', unit: 'km/h', category: 'wind' }
];

const stationChartParameters = [
    { key: 'Ta', label: 'Temperatura aktualna (Ta)', unit: '°C', hourlyKey: 'Ta', color: '#d35400' },
    { key: 'Precip_hour', label: 'Opad godzinowy (Precip_hour)', unit: 'mm', hourlyKey: 'Precip', color: '#2878b5' },
    { key: 'Wind_avg', label: 'Średnia prędkość wiatru (Wind_avg)', unit: 'km/h', hourlyKey: 'Wind_avg', convertWindSpeed: true, color: '#7754a5' },
    { key: 'Wind_max', label: 'Maksymalny poryw wiatru (Wind_max)', unit: 'km/h', hourlyKey: 'Wind_max', convertWindSpeed: true, color: '#b3397a' }
];

let activeTempParam = 'Ta';
let rankingParameterOverride = null;
let currentHourStr = '12';

etykietyTa.addTo(map);

let globalGeoJsonData = null;
let meteorologicalDate = '';
let meteorologicalHourlySlots = [];
let previousDayStations = new Map();
let latestAvailableDate = null;
let latestMeteorologicalHour = null;
let latestMeteorologicalHourByParameter = null;
let dateLoadRequest = 0;
let stationActivityIndex = null;
let stationActivityRequest = null;
const visibleStationStatuses = { active: true, incomplete: true, missing: true, closed: true };

function getMeteorologicalHourlySlots(dateStr) {
    const end = Date.parse(`${dateStr}T06:00:00Z`);
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    });
    const slots = Array.from({ length: 25 }, (_, index) => {
        const instant = new Date(end - (24 - index) * 3600000);
        const parts = Object.fromEntries(
            formatter.formatToParts(instant)
                .filter(part => part.type !== 'literal')
                .map(part => [part.type, part.value])
        );
        return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour, utc: instant.toISOString().replace('.000Z', 'Z') };
    });
    const counts = new Map();
    slots.forEach(slot => {
        const key = `${slot.date} ${slot.hour}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    slots.forEach(slot => { slot.repeated = counts.get(`${slot.date} ${slot.hour}`) > 1; });
    return slots;
}

function getLatestMeteorologicalHourlyData(data, previousData, dateStr, parameterKey = null) {
    const nextDate = new Date(Date.parse(`${dateStr}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const slots = [...getMeteorologicalHourlySlots(dateStr), ...getMeteorologicalHourlySlots(nextDate)];
    let latest = null;
    for (const slot of slots) {
        const source = slot.date === dateStr ? data : slot.date < dateStr ? previousData : null;
        if (!Array.isArray(source?.features)) continue;
        const timestamp = Date.parse(slot.utc);
        for (const feature of source.features) {
            const properties = feature?.properties;
            if (!properties || properties.Status === 'CLOSED') continue;
            const hour = properties.Hourly?.[slot.hour];
            const values = slot.repeated && hour?.UTC && Object.keys(hour.UTC).length
                ? hour.UTC[slot.utc]
                : hour;
            for (const key of parameterKey ? [parameterKey] : ['Ta', 'Precip', 'Wind_avg', 'Wind_max']) {
                const value = values?.[key];
                if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))) {
                    latest = Math.max(latest ?? -Infinity, timestamp);
                }
            }
        }
    }
    return latest;
}

function getLatestMeteorologicalHourForParameter(parameterKey) {
    return latestMeteorologicalHourByParameter
        && Object.hasOwn(latestMeteorologicalHourByParameter, parameterKey)
        ? latestMeteorologicalHourByParameter[parameterKey]
        : latestMeteorologicalHour;
}

function getMeteorologicalHourlyValue(feature, slot, parameterKey) {
    const properties = feature?.properties;
    const station = slot.date === meteorologicalDate
        ? properties
        : previousDayStations.get(String(properties?.Station_id));
    const hour = station?.Hourly?.[slot.hour];
    return slot.repeated ? hour?.UTC?.[slot.utc]?.[parameterKey] : hour?.[parameterKey];
}

function hasMeteorologicalHourlyValue(feature, slot, parameterKey) {
    const value = getMeteorologicalHourlyValue(feature, slot, parameterKey);
    return value !== undefined && value !== null && value !== ''
        && Number.isFinite(Number(value));
}

function hasCompleteHourlyData(feature, parameterKey) {
    const cutoff = getLatestMeteorologicalHourForParameter(parameterKey);
    const slots = cutoff === null
        ? meteorologicalHourlySlots
        : meteorologicalHourlySlots.filter(slot => Date.parse(slot.utc) <= cutoff);
    return meteorologicalHourlySlots.length === 25
        && slots.length > 0
        && slots.every(slot => hasMeteorologicalHourlyValue(feature, slot, parameterKey));
}

function hasAnyMeteorologicalHourlyData(feature, parameterKey) {
    const cutoff = getLatestMeteorologicalHourForParameter(parameterKey);
    return meteorologicalHourlySlots.some(slot =>
        (cutoff === null || Date.parse(slot.utc) <= cutoff)
        && hasMeteorologicalHourlyValue(feature, slot, parameterKey));
}

function hasRecentDailyExtremaMeasurement(feature, parameterKey) {
    const stationId = String(feature?.properties?.Station_id);
    const parameterBit = parameterKey === 'Tmin' ? 16 : 32;
    const selectedDay = Date.parse(`${meteorologicalDate}T00:00:00Z`);
    for (let offset = 0; offset < 30; offset++) {
        const day = new Date(selectedDay - offset * 86400000).toISOString().slice(0, 10);
        const mask = stationActivityIndex?.days?.[day]?.parameters?.[stationId];
        if (Number.isInteger(mask) && (mask & parameterBit) !== 0) return true;
    }
    return false;
}

function hasDailyExtremaDeadlinePassed(selectedDate, now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    if (selectedDate < today) return true;
    if (selectedDate > today) return false;
    return Number(parts.hour) >= 22;
}

function getStationActivity(feature) {
    if (!stationActivityIndex?.days || !meteorologicalDate) return 'unknown';
    const end = Date.parse(`${meteorologicalDate}T06:00:00Z`);
    const start = end - 30 * 86400000;
    const stationId = String(feature?.properties?.Station_id);
    let complete = true;
    for (let timestamp = start; timestamp <= end; timestamp += 86400000) {
        const day = new Date(timestamp).toISOString().slice(0, 10);
        const stations = stationActivityIndex.days[day]?.stations;
        if (!stations || !Object.hasOwn(stations, stationId)) {
            complete = false;
            continue;
        }
        const observed = stations[stationId];
        if (observed && observed[0] * 1000 <= end && observed[1] * 1000 >= start) return 'active';
        if (observed && observed.length > 2) complete = false;
    }
    return complete ? 'inactive' : 'unknown';
}

function getParameterCapability(feature, parameterKey) {
    const properties = feature?.properties;
    const hourlyKey = ['Tmin_hour', 'Tmax_hour'].includes(parameterKey) ? 'Ta' : parameterKey;
    const currentValue = properties?.Hourly?.[currentHourStr]?.[hourlyKey];
    if (getRoundedNumericValue(currentValue) !== null ||
        getRoundedNumericValue(properties?.[parameterKey]) !== null) return true;
    if (!stationActivityIndex?.parameters) return null;
    const first = stationActivityIndex.parameters[String(properties?.Station_id)] || {};
    const keys = parameterKey === 'Precip_24h' ? ['Precip_24h', 'Precip'] : [hourlyKey];
    const end = Date.parse(`${meteorologicalDate}T06:00:00Z`) / 1000;
    return keys.some(key => Number.isFinite(first[key]) && first[key] <= end);
}

function getMarkerStatus(feature, parameterKey) {
    if (parameterKey === 'Tmin' || parameterKey === 'Tmax') {
        const properties = feature?.properties;
        if (getRoundedNumericValue(properties?.[parameterKey]) !== null) return 'active';
        if (properties?.Activity_check_failed || !hasRecentDailyExtremaMeasurement(feature, parameterKey)) {
            return 'unsupported';
        }
        return hasDailyExtremaDeadlinePassed(meteorologicalDate) ? 'missing' : 'unsupported';
    }
    if (parameterKey && getParameterCapability(feature, parameterKey) === false) return 'unsupported';
    const activity = getStationActivity(feature);
    if (activity === 'inactive' || (activity === 'unknown' && feature?.properties?.Status === 'CLOSED')) return 'closed';
    const effectiveParameter = parameterKey || ['Ta', 'Precip', 'Wind_avg', 'Wind_max']
        .find(key => getParameterCapability(feature, key) === true);
    if (!effectiveParameter) return activity === 'active' ? 'active' : 'incomplete';
    const capability = getParameterCapability(feature, effectiveParameter);
    if (capability === false) return 'unsupported';
    if (feature?.properties?.Activity_check_failed) return 'incomplete';
    const completenessParameter = ['Ta', 'Tmin_hour', 'Tmax_hour'].includes(effectiveParameter)
        ? 'Ta'
        : ['Precip', 'Wind_avg', 'Wind_max'].includes(effectiveParameter) ? effectiveParameter : null;
    const latestParameterHour = completenessParameter
        ? getLatestMeteorologicalHourForParameter(completenessParameter)
        : latestMeteorologicalHour;
    const dayCompletionHour = latestParameterHour ?? latestMeteorologicalHour;
    const dayFinished = dayCompletionHour === null
        ? meteorologicalDate !== latestAvailableDate
        : meteorologicalHourlySlots.length === 25
            && dayCompletionHour >= Date.parse(meteorologicalHourlySlots[24].utc);
    if (completenessParameter) {
        if (!hasAnyMeteorologicalHourlyData(feature, completenessParameter)) {
            if (['Ta', 'Tmin_hour', 'Tmax_hour'].includes(parameterKey) && !dayFinished) {
                return activity === 'active' ? 'active' : 'incomplete';
            }
            return capability === true && activity === 'active' && dayFinished && previousDayStations.has(String(feature?.properties?.Station_id))
                ? 'missing' : 'incomplete';
        }
        if (['Precip', 'Wind_avg'].includes(parameterKey)) {
            const properties = feature?.properties;
            const selectedValue = properties?.Hourly
                ? properties.Hourly[currentHourStr]?.[parameterKey]
                : parameterKey === 'Ta' ? properties?.Ta : parameterKey === 'Precip' ? properties?.Precip_10min : null;
            if (getRoundedNumericValue(selectedValue) === null) return 'incomplete';
        }
        return hasCompleteHourlyData(feature, completenessParameter) ? 'active' : 'incomplete';
    }
    const parameterValue = parameterKey === 'Tg'
        ? getFreshGroundTemperature(feature?.properties)
        : feature?.properties?.[parameterKey];
    if (parameterKey && getRoundedNumericValue(parameterValue) === null) {
        return capability === true && activity === 'active' && dayFinished ? 'missing' : 'incomplete';
    }
    return 'active';
}

function getMarkerStyle(feature, parameterKey) {
    const colors = { active: '#2ecc71', incomplete: '#ffff00', missing: '#e74c3c', closed: '#b0b0b0' };
    return {
        radius: 3,
        fillColor: colors[getMarkerStatus(feature, parameterKey)],
        color: '#000',
        weight: 1,
        opacity: 1,
        fillOpacity: 0.8
    };
}

function formatValue(value, decimals = 1) {
    if (value !== undefined && value !== null && value !== "") {
        if (!isNaN(value) && typeof value !== 'string') {
            return Number(value).toFixed(decimals);
        }
        return value;
    }
    return null;
}

function getRoundedNumericValue(value, decimals = 1) {
    if (value === undefined || value === null || value === '' || !Number.isFinite(Number(value))) return null;
    return Number(Number(value).toFixed(decimals));
}

function convertMetersPerSecondToKilometersPerHour(value) {
    if (value !== undefined && value !== null && value !== "") {
        if (!isNaN(value)) {
            return Number(value) * 3.6;
        }
    }
    return null;
}

const tempScale = [
    { t: -50, r: 255, g: 255, b: 255 }, { t: -45, r: 232, g: 220, b: 246 }, { t: -40, r: 245, g: 242, b: 245 }, { t: -35, r: 212, g: 185, b: 204 }, { t: -30, r: 125, g: 90,  b: 110 },
    { t: -25, r: 214, g: 110, b: 247 }, { t: -20, r: 135, g: 45,  b: 230 }, { t: -15, r: 40,  g: 30,  b: 215 },
    { t: -10, r: 50,  g: 100, b: 230 }, { t: -5,  r: 120, g: 190, b: 245 }, { t: 0,   r: 195, g: 255, b: 250 },
    { t: 5,   r: 120, g: 235, b: 160 }, { t: 10,  r: 55,  g: 160, b: 50  }, { t: 15,  r: 175, g: 215, b: 65  },
    { t: 20,  r: 255, g: 245, b: 50  }, { t: 25,  r: 255, g: 165, b: 40  }, { t: 30,  r: 255, g: 50,  b: 40  },
    { t: 35,  r: 180, g: 25,  b: 45  }, { t: 40,  r: 245, g: 150, b: 180 }, { t: 45, r: 249, g: 198, b: 205 }, { t: 50, r: 255, g: 255, b: 255 }
];

const precipLabelScale = [[0, 225, 242, 255], [5, 145, 210, 250], [10, 55, 145, 230], [20, 30, 90, 195], [30, 25, 55, 130], [40, 65, 30, 125], [50, 105, 35, 155], [60, 145, 35, 175], [70, 180, 35, 170], [80, 205, 45, 175], [90, 225, 80, 190], [100, 240, 115, 205], [110, 242, 145, 201], [120, 244, 165, 208], [130, 235, 175, 210], [140, 224, 183, 211], [150, 210, 190, 210], [160, 195, 198, 209], [170, 182, 207, 211], [180, 185, 218, 219], [190, 205, 232, 230], [200, 255, 255, 255]];
const windLabelScale = [[0, 255, 255, 255], [10, 197, 213, 224], [20, 79, 145, 200], [30, 61, 175, 160], [40, 84, 174, 88], [50, 143, 214, 163], [60, 241, 220, 69], [70, 243, 154, 54], [80, 216, 107, 38], [90, 222, 55, 61], [100, 151, 27, 40], [110, 93, 16, 28], [120, 116, 29, 49], [130, 132, 62, 76], [140, 148, 96, 106], [150, 163, 126, 133], [160, 178, 153, 158], [170, 193, 177, 181], [180, 208, 199, 201], [190, 227, 223, 224], [200, 245, 245, 245]];

function getLabelScaleColor(value, scale) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return 'rgba(230, 233, 234, 0.98)';
    if (numericValue <= scale[0][0]) return `rgba(${scale[0][1]}, ${scale[0][2]}, ${scale[0][3]}, 0.98)`;
    if (numericValue >= scale[scale.length - 1][0]) {
        const last = scale[scale.length - 1];
        return `rgba(${last[1]}, ${last[2]}, ${last[3]}, 0.98)`;
    }
    for (let index = 0; index < scale.length - 1; index++) {
        const lower = scale[index];
        const upper = scale[index + 1];
        if (numericValue >= lower[0] && numericValue <= upper[0]) {
            const fraction = (numericValue - lower[0]) / (upper[0] - lower[0]);
            return `rgba(${Math.round(lower[1] + fraction * (upper[1] - lower[1]))}, ${Math.round(lower[2] + fraction * (upper[2] - lower[2]))}, ${Math.round(lower[3] + fraction * (upper[3] - lower[3]))}, 0.98)`;
        }
    }
    return 'rgba(230, 233, 234, 0.98)';
}

function getContrastTextColor(backgroundColor) {
    const channels = backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!channels) return 'rgb(17, 24, 39)';
    const [red, green, blue] = channels.slice(1, 4).map(Number).map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    return luminance >= 0.18 ? '#000000' : '#ffffff';
}

function getTemperatureStyle(temp) {
    let t = parseFloat(temp);
    if (isNaN(t)) return { bg: 'rgba(230, 233, 234, 0.98)' };
    if (t <= tempScale[0].t) return { bg: `rgba(${tempScale[0].r}, ${tempScale[0].g}, ${tempScale[0].b}, 0.98)` };
    if (t >= tempScale[tempScale.length - 1].t) return { bg: `rgba(${tempScale[tempScale.length - 1].r}, ${tempScale[tempScale.length - 1].g}, ${tempScale[tempScale.length - 1].b}, 0.98)` };

    let lower = tempScale[0], upper = tempScale[tempScale.length - 1];
    for (let i = 0; i < tempScale.length - 1; i++) {
        if (t >= tempScale[i].t && t <= tempScale[i+1].t) { lower = tempScale[i]; upper = tempScale[i+1]; break; }
    }
    const fraction = (t - lower.t) / (upper.t - lower.t);
    return { bg: `rgba(${Math.round(lower.r + fraction * (upper.r - lower.r))}, ${Math.round(lower.g + fraction * (upper.g - lower.g))}, ${Math.round(lower.b + fraction * (upper.b - lower.b))}, 0.98)` };
}

function keepPopupWithinMap(popup) {
    const element = popup.getElement();
    if (!element) return;

    const mapBounds = map.getContainer().getBoundingClientRect();
    const popupBounds = element.getBoundingClientRect();
    const padding = 8;
    let offsetX = 0;
    let offsetY = 0;

    if (popupBounds.left < mapBounds.left + padding) {
        offsetX = mapBounds.left + padding - popupBounds.left;
    } else if (popupBounds.right > mapBounds.right - padding) {
        offsetX = mapBounds.right - padding - popupBounds.right;
    }
    if (popupBounds.top < mapBounds.top + padding) {
        offsetY = mapBounds.top + padding - popupBounds.top;
    } else if (popupBounds.bottom > mapBounds.bottom - padding) {
        offsetY = mapBounds.bottom - padding - popupBounds.bottom;
    }

    if (offsetX || offsetY) {
        const position = L.DomUtil.getPosition(element);
        L.DomUtil.setPosition(element, position.add(L.point(offsetX, offsetY)));
    }
}

function addDataToParamGroup(rawValue, suffix, className, positionClass, latlng, popupContent, feature, group, isElevation = false, extremeType = '', parameterKey = '', missingCurrentValue = false) {
    const decimals = isElevation ? 0 : 1;
    missingCurrentValue = missingCurrentValue || (parameterKey !== '' && getRoundedNumericValue(rawValue) === null);
    const formatted = missingCurrentValue ? 'b.d.' : formatValue(rawValue, decimals);
    const status = getMarkerStatus(feature, parameterKey);
    if ((formatted !== null || status === 'closed') && visibleStationStatuses[status]) {
        const markerStyle = getMarkerStyle(feature, parameterKey);
        const marker = L.circleMarker(latlng, markerStyle);
        const statusNames = { active: 'Aktywna', incomplete: 'Niepełne dane', missing: 'Brak danych', closed: 'Nieczynna / zamknięta' };
        marker.bindPopup(popupContent.replace('__STATION_STATUS__',
            `<span style="display:inline-block; padding:1px 4px; border:1px solid #000; border-radius:3px; color:#000; background-color:${markerStyle.fillColor}; font-weight:bold;">${statusNames[status]}</span>`), {
            autoPan: false,
            maxWidth: Math.min(520, Math.max(160, map.getSize().x - 24)),
            maxHeight: Math.min(320, Math.max(120, map.getSize().y - 24)),
            className: 'station-info-popup'
        });
        marker.on('popupopen', event => {
            const chartButton = event.popup.getElement()?.querySelector('[data-show-station-charts]');
            if (chartButton) {
                chartButton.onclick = () => openStationCharts(feature.properties);
            }
            requestAnimationFrame(() => keepPopupWithinMap(event.popup));
        });
        group.addLayer(marker);
        if (status === 'closed' || status === 'missing'
            || (missingCurrentValue && ['Ta', 'Precip', 'Wind_avg'].includes(parameterKey))) return;
        const direction = positionClass === 'etykieta-dol' ? 'bottom' : 'top';

        let extraClass = '';
        if (extremeType === 'max') extraClass = ' ramka-max';
        if (extremeType === 'min') extraClass = ' ramka-min';

        const fullClassName = 'stacja-etykieta ' + className + ' ' + positionClass + extraClass;
        const isTemperatureLayer = ['temp-aktualna', 'temp-min', 'temp-min-hour', 'temp-max', 'temp-max-hour', 'temp-grunt'].includes(className);
        const isPrecipitationLayer = ['opad-dobowy', 'opad-10min'].includes(className);
        const isWindLayer = ['wiatr-avg', 'wiatr-max'].includes(className);

        let tooltipContent;
        let stationHighlightColor = null;
        if (isTemperatureLayer || isPrecipitationLayer || isWindLayer) {
            let borderStyle = '1px solid #666';
            const labelColor = missingCurrentValue ? '#b0b0b0' : isTemperatureLayer
                ? getTemperatureStyle(rawValue).bg
                : getLabelScaleColor(rawValue, isPrecipitationLayer ? precipLabelScale : windLabelScale);
            stationHighlightColor = labelColor;
            const textColor = '#000000';
            tooltipContent = `<div style="background: ${labelColor} !important; color: ${textColor} !important; text-shadow: none; border: ${borderStyle} !important; box-sizing: content-box !important; width: 100%; height: 100%; display: inline-flex; align-items: center; justify-content: center; margin: -1px -2px; padding: 0 2px; border-radius: 2px;">${formatted}${missingCurrentValue ? '' : suffix}</div>`;
        } else {
            tooltipContent = `${formatted}${suffix}`;
        }

        const lbl = L.tooltip({ permanent: true, direction: direction, offset: [0, 0], className: fullClassName }).setContent(tooltipContent).setLatLng(latlng);
        const stationId = getStationHighlightKey(feature?.properties);
        if (stationId) {
            lbl.on('add', () => {
                const element = lbl.getElement();
                if (!element) return;
                element.dataset.stationId = stationId;
                if (stationHighlightColor) {
                    element.style.setProperty('--station-highlight-color', stationHighlightColor);
                }
                setStationLabelHighlight(element, hoveredRankingStationId === stationId);
            });
        }
        group.addLayer(lbl);
    }
}

function getSelectedTempParam() {
    const activeMapping = tempLayerMapping.find(t => t.key === activeTempParam);
    if (activeMapping && map.hasLayer(activeMapping.group)) {
        return activeMapping;
    }
    const checkedMapping = tempLayerMapping.find(t => map.hasLayer(t.group));
    if (checkedMapping) {
        return checkedMapping;
    }
    return tempLayerMapping.find(t => t.key === activeTempParam) || tempLayerMapping[0];
}

function getFreshGroundTemperature(props) {
    const value = getRoundedNumericValue(props?.Tg);
    const measuredDate = typeof props?.Tg_time === 'string' ? props.Tg_time.slice(0, 10) : '';
    const selectedDate = document.getElementById('datePicker')?.value;
    if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(measuredDate)
        || !/^\d{4}-\d{2}-\d{2}$/.test(selectedDate || '')) {
        return null;
    }

    const selectedDay = Date.parse(`${selectedDate}T00:00:00Z`);
    const measuredDay = Date.parse(`${measuredDate}T00:00:00Z`);
    const ageInDays = (selectedDay - measuredDay) / 86400000;
    return Number.isInteger(ageInDays) && ageInDays >= 0 && ageInDays <= 1
        ? value
        : null;
}

function getFeatureTempValue(props, tempKey, hourStr) {
    if (!props) return null;
    if (tempKey === 'Ta') {
        if (props.Hourly) {
            const hourlyTa = (props.Hourly[hourStr] && props.Hourly[hourStr].Ta !== undefined && props.Hourly[hourStr].Ta !== null)
                ? props.Hourly[hourStr].Ta
                : null;
            return getRoundedNumericValue(hourlyTa);
        }
        return getRoundedNumericValue(props.Ta);
    }
    if (tempKey === 'Tmin') {
        return getRoundedNumericValue(props.Tmin);
    }
    if (tempKey === 'Tmax') {
        return getRoundedNumericValue(props.Tmax);
    }
    if (tempKey === 'Tmin_hour') {
        return getRoundedNumericValue(props.Tmin_hour);
    }
    if (tempKey === 'Tmax_hour') {
        return getRoundedNumericValue(props.Tmax_hour);
    }
    if (tempKey === 'Tg') {
        return getFreshGroundTemperature(props);
    }
    return getRoundedNumericValue(props[tempKey]);
}

function getRankingParameterValue(props, parameter, hourStr) {
    if (parameter.category === 'temperature') {
        return getFeatureTempValue(props, parameter.key, hourStr);
    }
    if (parameter.key === 'Precip_24h') {
        return props.Precip_24h == null ? null : Number(props.Precip_24h);
    }
    if (parameter.key === 'Precip_hour') {
        const value = props.Hourly?.[hourStr]?.Precip ?? props.Precip_10min;
        return value == null ? null : Number(value);
    }
    if (parameter.key === 'Wind_avg') {
        const value = props.Hourly?.[hourStr]?.Wind_avg;
        return value == null ? null : Number(convertMetersPerSecondToKilometersPerHour(value));
    }
    if (parameter.key === 'Wind_max') {
        return props.Wind_max == null
            ? null
            : Number(convertMetersPerSecondToKilometersPerHour(props.Wind_max));
    }
    return null;
}

function clearMapData() {
    [etykietyTa, etykietyTmin, etykietyTmax, etykietyTminHour, etykietyTmaxHour, etykietyTg, etykietyOpady24h, etykietyOpady10min, etykietyWindAvg, etykietyWindMax, etykietyElevation, etykietyStationName].forEach(g => { try { g.clearLayers(); } catch (e){} });
}

let layersControl = null;
let rankingsControl = null;

function getLastAvailableHourFromData(data, parameterKey = 'Ta') {
    if (!data || !Array.isArray(data.features)) return 23;

    let maxParameterHour = -1;
    let maxAnyHour = -1;
    data.features.forEach(feature => {
        const props = feature && feature.properties ? feature.properties : null;
        if (!props || props.Status !== 'ACTIVE' || !props.Hourly) return;

        Object.keys(props.Hourly).forEach(hourKey => {
            const hourValue = props.Hourly[hourKey];
            if (!hourValue) return;
            const hourNum = Number(hourKey);
            if (!Number.isNaN(hourNum)) {
                if (hourValue[parameterKey] !== undefined && hourValue[parameterKey] !== null && hourValue[parameterKey] !== '') {
                    maxParameterHour = Math.max(maxParameterHour, hourNum);
                }
                const hasMeasurement = Object.keys(hourValue).some(key => key !== 'UTC' && hourValue[key] !== undefined && hourValue[key] !== null && hourValue[key] !== '');
                if (hasMeasurement) maxAnyHour = Math.max(maxAnyHour, hourNum);
            }
        });
    });

    if (maxParameterHour >= 0) return maxParameterHour;
    if (maxAnyHour >= 0) return maxAnyHour;
    return 23;
}

function processData(data, selectedHour, dateStr, previousData) {
    globalGeoJsonData = data;
    meteorologicalDate = dateStr;
    meteorologicalHourlySlots = getMeteorologicalHourlySlots(dateStr);
    previousDayStations = new Map(
        (previousData?.features || [])
            .filter(feature => feature?.properties?.Station_id != null)
            .map(feature => [String(feature.properties.Station_id), feature.properties])
    );
    latestMeteorologicalHour = dateStr === latestAvailableDate
        ? getLatestMeteorologicalHourlyData(data, previousData, dateStr)
        : null;
    latestMeteorologicalHourByParameter = dateStr === latestAvailableDate
        ? Object.fromEntries(['Ta', 'Precip', 'Wind_avg', 'Wind_max'].map(parameterKey => [
            parameterKey,
            getLatestMeteorologicalHourlyData(data, previousData, dateStr, parameterKey)
        ]))
        : null;
    const hourSlider = document.getElementById('hourSlider');
    const hour = Number.isInteger(selectedHour) && selectedHour >= 0 && selectedHour <= 23
        ? selectedHour
        : getLastAvailableHourFromData(data);
    const hourStr = hourSlider ? String(hour).padStart(2, '0') : '12';
    currentHourStr = hourStr;
    if (hourSlider) {
        hourSlider.value = String(hour);
        const currentTimeLabel = document.getElementById('currentTimeLabel');
        const span = currentTimeLabel ? currentTimeLabel.querySelector('span') : null;
        if (span) span.textContent = hourStr + ':00';
    }
    renderDataForHour(hourStr);
}

function formatStationPopupValue(label, value, unit) {
    const formattedValue = value === null ? 'Brak danych' : `${value}${unit}`;
    return `<p><strong>${label}:</strong> ${formattedValue}</p>`;
}

function renderDataForHour(hourStr) {
    if (!layersControl) buildUnifiedLayerControl();
    if (!rankingsControl) buildRankingsControl();
    currentHourStr = hourStr;
    clearMapData();
    updateRankingsPanel(hourStr);
    if (!globalGeoJsonData) return;

    let extremes = { Ta: { min: Infinity, max: -Infinity }, Tmin: { min: Infinity, max: -Infinity }, Tmax: { min: Infinity, max: -Infinity }, Tmin_hour: { min: Infinity, max: -Infinity }, Tmax_hour: { min: Infinity, max: -Infinity }, Tg: { min: Infinity, max: -Infinity }, Wind_avg: { min: Infinity, max: -Infinity }, Wind_max: { min: Infinity, max: -Infinity }, Precip_24h: { max: -Infinity }, Precip_10min: { max: -Infinity } };

    globalGeoJsonData.features.forEach(f => {
        const p = f.properties;
        if (p.Status === 'ACTIVE') {
            const hourlyWindAvg = p.Hourly?.[hourStr]?.Wind_avg;
            const wAvg = convertMetersPerSecondToKilometersPerHour(hourlyWindAvg), wMax = convertMetersPerSecondToKilometersPerHour(p.Wind_max);
            const hourlyTa = p.Hourly
                ? (p.Hourly[hourStr] && p.Hourly[hourStr].Ta !== undefined && p.Hourly[hourStr].Ta !== null ? p.Hourly[hourStr].Ta : null)
                : (p.Ta !== undefined ? p.Ta : null);
            const hourlyPrecip = p.Hourly
                ? (p.Hourly[hourStr] && p.Hourly[hourStr].Precip !== undefined && p.Hourly[hourStr].Precip !== null ? p.Hourly[hourStr].Precip : null)
                : (p.Precip_10min !== undefined ? p.Precip_10min : null);

            const updateExtreme = (extreme, value) => {
                const roundedValue = getRoundedNumericValue(value);
                if (roundedValue === null) return;
                extreme.min = Math.min(extreme.min, roundedValue);
                extreme.max = Math.max(extreme.max, roundedValue);
            };

            updateExtreme(extremes.Ta, hourlyTa);
            updateExtreme(extremes.Tmin, p.Tmin);
            updateExtreme(extremes.Tmax, p.Tmax);
            updateExtreme(extremes.Tmin_hour, p.Tmin_hour);
            updateExtreme(extremes.Tmax_hour, p.Tmax_hour);
            updateExtreme(extremes.Tg, getFreshGroundTemperature(p));
            updateExtreme(extremes.Wind_avg, wAvg);
            updateExtreme(extremes.Wind_max, wMax);
            const roundedPrecip24h = getRoundedNumericValue(p.Precip_24h);
            const roundedPrecip10min = getRoundedNumericValue(hourlyPrecip);
            if (roundedPrecip24h !== null) extremes.Precip_24h.max = Math.max(extremes.Precip_24h.max, roundedPrecip24h);
            if (roundedPrecip10min !== null) extremes.Precip_10min.max = Math.max(extremes.Precip_10min.max, roundedPrecip10min);
        }
    });

    L.geoJSON(globalGeoJsonData, {
        pointToLayer: function (feature, latlng) {
            const props = feature.properties;
            const hourlyWindAvg = props.Hourly?.[hourStr]?.Wind_avg;
            const wAvgKmh = convertMetersPerSecondToKilometersPerHour(hourlyWindAvg), wMaxKmh = convertMetersPerSecondToKilometersPerHour(props.Wind_max);
            
            let hourlyTa = props.Hourly
                ? (props.Hourly[hourStr] && props.Hourly[hourStr].Ta !== undefined && props.Hourly[hourStr].Ta !== null ? props.Hourly[hourStr].Ta : null)
                : (props.Ta !== undefined ? props.Ta : null);
            let hourlyPrecip = props.Hourly
                ? (props.Hourly[hourStr] && props.Hourly[hourStr].Precip !== undefined && props.Hourly[hourStr].Precip !== null ? props.Hourly[hourStr].Precip : null)
                : (props.Precip_10min !== undefined ? props.Precip_10min : null);

            const fTa = formatValue(hourlyTa, 1), 
                  fTmin = formatValue(props.Tmin, 1), 
                  fTmax = formatValue(props.Tmax, 1), 
                  fTminHour = formatValue(props.Tmin_hour, 1), 
                  fTmaxHour = formatValue(props.Tmax_hour, 1), 
                  groundTemp = getFreshGroundTemperature(props),
                  fTg = formatValue(groundTemp, 1), 
                  fPrecip24h = formatValue(props.Precip_24h, 1), 
                  fPrecip10min = formatValue(hourlyPrecip, 1), 
                  fWindAvg = formatValue(wAvgKmh, 1), 
                  fWindMax = formatValue(wMaxKmh, 1), 
                  fElevation = formatValue(props.Elevation, 0);

            let popupContent = `<h3>${props.Station_name || 'Stacja pomiarowa'}</h3><hr><p><strong>ID:</strong> ${props.Station_id}</p><p><strong>Status:</strong> __STATION_STATUS__</p>`;
            popupContent += formatStationPopupValue('Wysokość', fElevation, ' m n.p.m.');
            popupContent += formatStationPopupValue('Temperatura aktualna', fTa, '°C');
            popupContent += formatStationPopupValue(`Opad godzinowy (${hourStr}:00)`, fPrecip10min, ' mm');
            popupContent += formatStationPopupValue('Tmin godzinowe', fTminHour, '°C');
            popupContent += formatStationPopupValue('Tmax godzinowe', fTmaxHour, '°C');
            popupContent += formatStationPopupValue('Tmin dobowe', fTmin, '°C');
            popupContent += formatStationPopupValue('Tmax dobowe', fTmax, '°C');
            const formattedTgTime = fTg !== null ? formatStationPopupTime(props.Tg_time) : '';
            const tgTime = formattedTgTime ? ` (${formattedTgTime})` : '';
            popupContent += formatStationPopupValue(`Temperatura przy gruncie${tgTime}`, fTg, '°C');
            popupContent += formatStationPopupValue('Suma opadów', fPrecip24h, ' mm');
            popupContent += formatStationPopupValue(`Średnia prędkość wiatru (${hourStr}:00)`, fWindAvg, ' km/h');
            popupContent += formatStationPopupValue('Maksymalny poryw wiatru', fWindMax, ' km/h');
            popupContent += `<hr><p class="station-chart-action"><button type="button" class="station-chart-button" data-show-station-charts aria-label="Pokaż wykresy" title="Pokaż wykresy">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 13.5h12M3.5 11V8.5M7 11V5M10.5 11V7M14 11V3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                <span>Pokaż wykresy</span>
            </button></p>`;

            const getEx = (val, field) => {
                const roundedValue = getRoundedNumericValue(val);
                if (roundedValue === null) return '';
                if (extremes[field].max !== undefined && roundedValue === extremes[field].max) return 'max';
                if (['Precip_24h', 'Precip_10min', 'Wind_avg', 'Wind_max'].includes(field)) return '';
                if (extremes[field].min !== undefined && roundedValue === extremes[field].min) return 'min';
                return '';
            };

            if (getRoundedNumericValue(hourlyTa) !== null) {
                addDataToParamGroup(hourlyTa, '°C', 'temp-aktualna', 'etykieta-gora', latlng, popupContent, feature, etykietyTa, false, getEx(hourlyTa, 'Ta'), 'Ta');
            } else {
                addDataToParamGroup(null, '', 'temp-aktualna', 'etykieta-gora', latlng, popupContent, feature, etykietyTa, false, '', 'Ta', true);
            }
            addDataToParamGroup(props.Tmin, '°C', 'temp-min', 'etykieta-dol', latlng, popupContent, feature, etykietyTmin, false, getEx(props.Tmin, 'Tmin'), 'Tmin');
            addDataToParamGroup(props.Tmin_hour, '°C', 'temp-min-hour', 'etykieta-dol', latlng, popupContent, feature, etykietyTminHour, false, getEx(props.Tmin_hour, 'Tmin_hour'), 'Tmin_hour');
            addDataToParamGroup(props.Tmax, '°C', 'temp-max', 'etykieta-gora', latlng, popupContent, feature, etykietyTmax, false, getEx(props.Tmax, 'Tmax'), 'Tmax');
            addDataToParamGroup(props.Tmax_hour, '°C', 'temp-max-hour', 'etykieta-gora', latlng, popupContent, feature, etykietyTmaxHour, false, getEx(props.Tmax_hour, 'Tmax_hour'), 'Tmax_hour');
            addDataToParamGroup(groundTemp, '°C', 'temp-grunt', 'etykieta-gora', latlng, popupContent, feature, etykietyTg, false, getEx(groundTemp, 'Tg'), 'Tg');
            addDataToParamGroup(props.Precip_24h, ' mm', 'opad-dobowy', 'etykieta-gora', latlng, popupContent, feature, etykietyOpady24h, false, getEx(props.Precip_24h, 'Precip_24h'), 'Precip_24h');
            
            addDataToParamGroup(hourlyPrecip, ' mm', 'opad-10min', 'etykieta-gora', latlng, popupContent, feature, etykietyOpady10min, false, getEx(hourlyPrecip, 'Precip_10min'), 'Precip');

            addDataToParamGroup(wAvgKmh, ' km/h', 'wiatr-avg', 'etykieta-gora', latlng, popupContent, feature, etykietyWindAvg, false, getEx(wAvgKmh, 'Wind_avg'), 'Wind_avg');
            addDataToParamGroup(wMaxKmh, ' km/h', 'wiatr-max', 'etykieta-gora', latlng, popupContent, feature, etykietyWindMax, false, getEx(wMaxKmh, 'Wind_max'), 'Wind_max');
            addDataToParamGroup(props.Elevation, ' m n.p.m.', 'wysokosc', 'etykieta-gora', latlng, popupContent, feature, etykietyElevation, true, '');
            addDataToParamGroup(props.Station_name, '', 'nazwa-stacji', 'etykieta-gora', latlng, popupContent, feature, etykietyStationName, false, '');
            
            return null;
        }
    });

    const overlayMaps = {
        "Nazwa stacji (Station_name)": etykietyStationName, "Wysokość (Elevation)": etykietyElevation, "Temperatura aktualna (Ta)": etykietyTa, "Temperatura minimalna (Tmin)": etykietyTmin, "Temperatura maksymalna (Tmax)": etykietyTmax, "Temperatura min. godzinowa (Tmin_hour)": etykietyTminHour, "Temperatura max. godzinowa (Tmax_hour)": etykietyTmaxHour, "Temperatura przy gruncie (Tg)": etykietyTg, "Suma opadów (Precip_24h)": etykietyOpady24h, "Opad wybranej godziny (Precip_hour)": etykietyOpady10min, "Średnia prędkość wiatru (Wind_avg)": etykietyWindAvg, "Maksymalny poryw wiatru (Wind_max)": etykietyWindMax };

    if (!layersControl) {
        buildUnifiedLayerControl();
    }

    map.on('layeradd layerremove', updateLegendVisibility);
    updateLegendVisibility();
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
}

function getStationChartTimestampHour(timestamp) {
    if (typeof timestamp !== 'string' || !timestamp) return null;
    const date = new Date(timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return null;
    return date.getHours() + date.getMinutes() / 60;
}

function formatStationPopupTime(timestamp) {
    const hour = getStationChartTimestampHour(timestamp);
    return hour === null ? '' : formatStationChartHour(hour);
}

function getStationChartData(properties, parameter) {
    const hourly = properties.Hourly;
    const points = Object.entries(hourly && typeof hourly === 'object' ? hourly : {})
        .map(([hourKey, values]) => {
            const hour = Number(hourKey);
            const rawValue = getRoundedNumericValue(values?.[parameter.hourlyKey]);
            if (!Number.isInteger(hour) || hour < 0 || hour > 23 || rawValue === null) return null;
            const value = parameter.convertWindSpeed
                ? convertMetersPerSecondToKilometersPerHour(rawValue)
                : rawValue;
            return { hour, value: getRoundedNumericValue(value) };
        })
        .filter(point => point && point.value !== null)
        .sort((first, second) => first.hour - second.hour);
    return { points };
}

function formatStationChartHour(hour) {
    const totalMinutes = Math.round(hour * 60);
    const hourPart = Math.floor(totalMinutes / 60) % 24;
    const minutePart = totalMinutes % 60;
    return `${String(hourPart).padStart(2, '0')}:${String(minutePart).padStart(2, '0')}`;
}

function getStationChartRange(groupSeries) {
    const values = groupSeries.flatMap(item => item.chartData.points.map(point => point.value));
    if (!values.length || values.some(value => !Number.isFinite(value))) return null;
    const min = Math.floor(Math.min(...values) - 3);
    const max = Math.ceil(Math.max(...values) + 3);
    return Number.isSafeInteger(min) && Number.isSafeInteger(max) && Number.isSafeInteger(max - min)
        ? { min, max } : null;
}

function renderStationChart(series) {
    if (!series.length) return '';

    const width = 900;
    const height = 540;
    const left = 55;
    const right = 20;
    const top = 60;
    const bottom = 34;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const xForHour = hour => left + (hour / 23) * plotWidth;
    const xTicks = Array.from({ length: 24 }, (_, hour) => hour);
    const hourGrid = xTicks.map(hour => {
        const x = xForHour(hour);
        return `<line x1="${x}" y1="${top}" x2="${x}" y2="${top + plotHeight}" class="station-chart-hour-gridline"/>`;
    }).join('');
    const xLabels = xTicks.map(hour => {
        const x = xForHour(hour);
        return `<text x="${x}" y="${height - 8}" class="station-chart-x-label" text-anchor="middle">${formatStationChartHour(hour)}</text>`;
    }).join('');
    const charts = [
        { unit: '°C', title: 'Temperatura aktualna' },
        { unit: 'mm', title: 'Opad godzinowy' },
        { unit: 'km/h', title: 'Wiatr godzinowy' }
    ].map((group, groupIndex) => {
        const groupSeries = series.filter(item => item.parameter.unit === group.unit);
        if (!groupSeries.length) return '';
        const range = getStationChartRange(groupSeries);
        const title = `${group.title} [${group.unit}]`;
        if (!range) return `<section class="station-chart-group"><div class="station-chart-title"><strong>${escapeHtml(title)}</strong></div><p class="station-charts-empty">Nie można wyświetlić zakresu danych na wykresie.</p></section>`;
        const yForValue = value => top + ((range.max - value) / (range.max - range.min)) * plotHeight;
        const unitHeight = plotHeight / (range.max - range.min);
        const firstMajorOffset = ((range.max % 5) + 5) % 5;
        const patternId = `station-chart-grid-${groupIndex}`;
        const minorLines = [1, 2, 3, 4].map(step =>
            `<line x1="0" y1="${step * unitHeight}" x2="${plotWidth}" y2="${step * unitHeight}" class="station-chart-gridline-minor"/>`
        ).join('');
        const grid = `<defs><pattern id="${patternId}" x="${left}" y="${top + firstMajorOffset * unitHeight}" width="${plotWidth}" height="${5 * unitHeight}" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="${plotWidth}" y2="0" class="station-chart-gridline"/>${minorLines}
        </pattern></defs><rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" fill="url(#${patternId})"/>`;
        const labelStep = unitHeight >= 18 ? 1 : Math.max(5, Math.ceil(18 / unitHeight / 5) * 5);
        const axisLabels = [];
        for (let value = Math.ceil(range.min / labelStep) * labelStep; value <= range.max; value += labelStep) {
            const y = yForValue(value);
            axisLabels.push(`<text x="${left - 7}" y="${y + 4}" class="station-chart-y-label" text-anchor="end">${value.toFixed(1)}</text>`);
        }
        const labelPositions = new Map();
        const plottedSeries = groupSeries.map(({ parameter, chartData }) => {
            const points = chartData.points;
            const segments = [];
            points.forEach(point => {
                let segment = segments[segments.length - 1];
                if (!segment || point.hour - segment[segment.length - 1].hour > 1) {
                    segment = [];
                    segments.push(segment);
                }
                segment.push(point);
            });
            const lines = segments
                .filter(segment => segment.length > 1)
                .map(segment => `<polyline points="${segment.map(point => `${xForHour(point.hour)},${yForValue(point.value)}`).join(' ')}" class="station-chart-line" style="stroke:${parameter.color}"/>`)
                .join('');
            const markers = points.map(point => {
                const x = xForHour(point.hour);
                const y = yForValue(point.value);
                const title = `${escapeHtml(parameter.label)} ${formatStationChartHour(point.hour)}: ${point.value.toFixed(1)} ${escapeHtml(parameter.unit)}`;
                return `<circle cx="${x}" cy="${y}" r="3.5" class="station-chart-point" style="fill:${parameter.color}"><title>${title}</title></circle>`;
            }).join('');
            const labels = points.map(point => {
                const x = xForHour(point.hour);
                let labelY = yForValue(point.value) - 10;
                const occupied = labelPositions.get(point.hour) || [];
                while (occupied.some(position => Math.abs(position - labelY) < 13)) labelY -= 13;
                occupied.push(labelY);
                labelPositions.set(point.hour, occupied);
                const anchor = point.hour === 0 ? 'start' : point.hour === 23 ? 'end' : 'middle';
                return `<text x="${x}" y="${labelY}" class="station-chart-value-label" text-anchor="${anchor}" style="fill:${parameter.color}">${point.value.toFixed(1)}</text>`;
            }).join('');
            return { lines, markers, labels };
        });
        return `<section class="station-chart-group">
            <div class="station-chart-title"><strong>${escapeHtml(title)}</strong></div>
            <div class="station-chart-plot"><svg class="station-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
                ${hourGrid}${grid}${axisLabels.join('')}
                <line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" class="station-chart-axis"/>
                ${plottedSeries.map(item => item.lines).join('')}
                ${plottedSeries.map(item => item.markers).join('')}
                ${plottedSeries.map(item => item.labels).join('')}${xLabels}
            </svg></div>
        </section>`;
    }).join('');
    const tableSeries = series.map(({ parameter, chartData }) => ({
        parameter,
        valuesByHour: new Map(chartData.points.map(point => [point.hour, point.value]))
    }));
    const tableHeaders = tableSeries.map(({ parameter }) =>
        `<th scope="col" title="${escapeHtml(parameter.label)}"><span class="station-chart-legend-dot" style="background:${parameter.color}"></span>${escapeHtml(parameter.key)}</th>`
    ).join('');
    const tableRows = xTicks.map(hour => {
        const cells = tableSeries.map(({ parameter, valuesByHour }) => {
            const value = valuesByHour.get(hour);
            return `<td>${value === undefined ? 'Brak danych' : `${value.toFixed(1)} ${escapeHtml(parameter.unit)}`}</td>`;
        }).join('');
        return `<tr><th scope="row">${formatStationChartHour(hour)}</th>${cells}</tr>`;
    }).join('');

    return `<article class="station-chart-card">
        ${charts}
        <div class="station-chart-table-wrap">
            <table class="station-chart-table" aria-label="Wartości godzinowe">
                <thead><tr><th scope="col">Godzina</th>${tableHeaders}</tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>
    </article>`;
}

function openStationCharts(properties) {
    const dialog = document.getElementById('stationChartsDialog');
    const parameterList = document.getElementById('stationChartParameters');
    const chartContainer = document.getElementById('stationChartsContent');
    if (!dialog || !parameterList || !chartContainer) return;

    const selectedDate = document.getElementById('datePicker')?.value || '';
    document.getElementById('stationChartsTitle').textContent = properties.Station_name || properties.Station_id || 'Stacja';
    document.getElementById('stationChartsDate').textContent = selectedDate
        ? `Data: ${selectedDate} · czas lokalny`
        : 'Czas lokalny';

    parameterList.innerHTML = stationChartParameters.map(parameter => {
        const hasData = getStationChartData(properties, parameter).points.length > 0;
        return `<label><input type="checkbox" data-chart-parameter="${parameter.key}"${hasData ? ' checked' : ''}${hasData ? '' : ' disabled'}><span class="station-chart-legend-dot" style="background:${parameter.color}"></span>${escapeHtml(parameter.label)}</label>`;
    }).join('');

    const renderSelectedCharts = () => {
        const selectedParameters = new Set(
            [...parameterList.querySelectorAll('[data-chart-parameter]:checked')]
                .map(checkbox => checkbox.dataset.chartParameter)
        );
        const series = stationChartParameters
            .filter(parameter => selectedParameters.has(parameter.key))
            .map(parameter => ({ parameter, chartData: getStationChartData(properties, parameter) }))
            .filter(item => item.chartData.points.length);
        chartContainer.innerHTML = renderStationChart(series) || '<p class="station-charts-empty">Zaznacz zmienną, aby wyświetlić wykres.</p>';
    };
    parameterList.querySelectorAll('[data-chart-parameter]').forEach(checkbox => {
        checkbox.addEventListener('change', renderSelectedCharts);
    });
    renderSelectedCharts();
    if (!dialog.open) dialog.showModal();
}

function initStationChartsDialog() {
    const dialog = document.getElementById('stationChartsDialog');
    const closeButton = document.getElementById('stationChartsClose');
    if (!dialog || !closeButton) return;
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.close();
    });
}

function buildRankingsControl() {
    if (rankingsControl) return;

    rankingsControl = L.control({ position: 'topright' });
    rankingsControl.onAdd = function () {
        const div = L.DomUtil.create('div', 'leaflet-control compact-panel rankings-control');
        const rankingTable = name => {
            const valueHeader = name === 'temperature'
                ? `<div class="ranking-parameter-header">
                    <select class="ranking-parameter-select" data-ranking-parameter aria-label="Parametr zestawienia">
                        ${rankingParameterDefinitions.map(parameter => `<option value="${parameter.key}">${parameter.shortName}</option>`).join('')}
                    </select>
                    <button type="button" data-ranking-column="value" aria-label="Sortuj według parametru"></button>
                </div>`
                : `<button type="button" data-ranking-column="value">Wartość</button>`;
            return `
            <div class="ranking-table-wrap"><table data-ranking-table="${name}"><thead><tr>
                <th scope="col" data-sort-column="value"${name === 'temperature' ? ' class="ranking-parameter-column"' : ''}>${valueHeader}</th>
                <th scope="col" data-sort-column="alphabetical"><button type="button" data-ranking-column="alphabetical">Nazwa stacji</button></th>
                <th scope="col" data-sort-column="elevation"><button type="button" data-ranking-column="elevation"><span class="ranking-elevation-title">Wys.</span><br><span>[m n.p.m.]</span></button></th>
            </tr></thead><tbody data-ranking="${name}"></tbody></table></div>`;
        };
        div.innerHTML = `
            <div class="panel-global-header rankings-header">
                <div class="panel-main-title">Dane</div>
                <button type="button" class="panel-toggle-btn rankings-toggle" aria-label="Zwiń rankingi" title="Zwiń rankingi">▾</button>
            </div>
            <div class="rankings-content">
                <section class="ranking-section">
                    ${rankingTable('temperature')}
                </section>
                <section class="ranking-section">
                    <h3>Najwyższe dobowe sumy opadów:</h3>
                    ${rankingTable('precipitation')}
                </section>
                <section class="ranking-section">
                    <h3>Najwyższe dobowe prędkości wiatru:</h3>
                    ${rankingTable('wind')}
                </section>
            </div>
        `;

        const rankingParameterSelect = div.querySelector('[data-ranking-parameter]');
        rankingParameterSelect.addEventListener('change', () => {
            rankingParameterOverride = rankingParameterSelect.value;
            updateRankingsPanel(currentHourStr);
        });

        const toggle = div.querySelector('.rankings-toggle');
        toggle.addEventListener('click', () => {
            const collapsed = div.classList.toggle('collapsed');
            toggle.textContent = collapsed ? '◂' : '▸';
            toggle.setAttribute('aria-label', collapsed ? 'Pokaż rankingi' : 'Zwiń rankingi');
            toggle.setAttribute('title', collapsed ? 'Pokaż rankingi' : 'Zwiń rankingi');
        });

        const saveRankingPreferences = () => {
            const preferences = loadMapPreferences();
            saveMapPreferences(
                preferences.baseLayer,
                preferences.opacity,
                preferences.parameters,
                temperatureRankingDirection,
                temperatureRankingSort
            );
        };
        div.querySelectorAll('[data-ranking-table]').forEach(table => {
            const name = table.dataset.rankingTable;
            table.querySelectorAll('[data-ranking-column]').forEach(button => {
                button.addEventListener('click', () => {
                    const column = button.dataset.rankingColumn;
                    const state = name === 'temperature'
                        ? { sort: temperatureRankingSort, direction: temperatureRankingDirection }
                        : secondaryRankingSorts[name];
                    if (column === 'value') {
                        state.direction = state.sort === 'value' && state.direction === 'highest' ? 'lowest' : 'highest';
                        state.sort = 'value';
                    } else {
                        state.sort = state.sort === `${column}-asc` ? `${column}-desc` : `${column}-asc`;
                    }
                    if (name === 'temperature') {
                        temperatureRankingSort = state.sort;
                        temperatureRankingDirection = state.direction;
                        saveRankingPreferences();
                    }
                    updateRankingsPanel(currentHourStr);
                });
            });
        });

        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
    };
    rankingsControl.addTo(map);
}

function updateRankingsPanel(hourStr) {
    if (hourStr !== undefined) {
        currentHourStr = String(hourStr).padStart(2, '0');
    }
    const hStr = currentHourStr;
    if (!rankingsControl) buildRankingsControl();
    const container = rankingsControl.getContainer();
    if (!container) return;

    const selectedTemp = getSelectedTempParam();
    const selectedTempLayer = tempLayerMapping.find(parameter => map.hasLayer(parameter.group));
    const selectedMeasurements = tempLayerMapping
        .filter(parameter => map.hasLayer(parameter.group))
        .map(parameter => ({
            key: parameter.key,
            layer: parameter.group,
            shortName: parameter.shortName,
            unit: '°C',
            getValue: props => getFeatureTempValue(props, parameter.key, hStr)
        }));
    selectedMeasurements.push(
        {
            key: 'Precip_24h',
            layer: etykietyOpady24h,
            shortName: 'Precip_24h',
            unit: 'mm',
            getValue: props => props.Precip_24h == null ? null : Number(props.Precip_24h)
        },
        {
            key: 'Precip_hour',
            layer: etykietyOpady10min,
            shortName: 'Precip_hour',
            unit: 'mm',
            getValue: props => {
                const value = props.Hourly?.[hStr]?.Precip ?? props.Precip_10min;
                return value == null ? null : Number(value);
            }
        },
        {
            key: 'Wind_avg',
            layer: etykietyWindAvg,
            shortName: 'Wind_avg',
            unit: 'km/h',
            getValue: props => {
                const value = props.Hourly?.[hStr]?.Wind_avg;
                return value == null ? null : Number(convertMetersPerSecondToKilometersPerHour(value));
            }
        },
        {
            key: 'Wind_max',
            layer: etykietyWindMax,
            shortName: 'Wind_max',
            unit: 'km/h',
            getValue: props => props.Wind_max == null
                ? null
                : Number(convertMetersPerSecondToKilometersPerHour(props.Wind_max))
        }
    );
    const singleMeasurement = selectedMeasurements.filter(parameter => map.hasLayer(parameter.layer));
    const primaryMeasurement = singleMeasurement.length === 1
        ? singleMeasurement[0]
        : selectedTempLayer
            ? {
                key: selectedTemp.key,
                shortName: selectedTemp.shortName,
                unit: '°C',
                getValue: props => getFeatureTempValue(props, selectedTemp.key, hStr)
            }
            : null;
    const selectedRankingKey = rankingParameterOverride
        || primaryMeasurement?.key
        || selectedTemp.key;
    const selectedRankingParameter = rankingParameterDefinitions.find(
        parameter => parameter.key === selectedRankingKey
    ) || rankingParameterDefinitions[0];
    const rankingParameterSelect = container.querySelector('[data-ranking-parameter]');
    if (rankingParameterSelect) {
        rankingParameterSelect.value = selectedRankingParameter.key;
    }
    const temperatureSection = container.querySelector('[data-ranking="temperature"]').closest('.ranking-section');
    const precipitationSection = container.querySelector('[data-ranking="precipitation"]').closest('.ranking-section');
    const windSection = container.querySelector('[data-ranking="wind"]').closest('.ranking-section');
    temperatureSection.hidden = false;
    precipitationSection.hidden = singleMeasurement.length === 1 || !map.hasLayer(etykietyOpady24h);
    windSection.hidden = singleMeasurement.length === 1
        || (!map.hasLayer(etykietyWindAvg) && !map.hasLayer(etykietyWindMax));

    const entries = [];
    if (globalGeoJsonData && Array.isArray(globalGeoJsonData.features)) {
        globalGeoJsonData.features.forEach(feature => {
            const props = feature && feature.properties;
            if (!props || props.Status !== 'ACTIVE') return;
            const precipitation = props.Precip_24h !== undefined && props.Precip_24h !== null ? Number(props.Precip_24h) : null;
            const wind = props.Wind_max !== undefined && props.Wind_max !== null ? Number(convertMetersPerSecondToKilometersPerHour(props.Wind_max)) : null;
            const station = props.Station_name || props.Station_id || 'Brak nazwy';
            entries.push({
                station,
                stationId: getStationHighlightKey(props) || station,
                elevation: typeof props.Elevation === 'string' && !props.Elevation.trim()
                    ? null
                    : getRoundedNumericValue(props.Elevation, 0),
                precipitation,
                wind,
                selectedMeasurement: getRankingParameterValue(props, selectedRankingParameter, hStr)
            });
        });
    }

    const sortValues = (key, direction) => {
        return entries
            .filter(entry => entry[key] !== null && Number.isFinite(entry[key]))
            .sort((first, second) => direction * (second[key] - first[key]));
    };
    const primaryRankingKey = 'selectedMeasurement';
    const primaryRankingValues = sortValues(primaryRankingKey, temperatureRankingDirection === 'highest' ? 1 : -1);
    const primaryBoundaryValue = primaryRankingValues[0]?.[primaryRankingKey];
    const oppositePrimaryBoundaryValue = primaryRankingValues[primaryRankingValues.length - 1]?.[primaryRankingKey];
    const rankings = {
        temperature: {
            values: primaryRankingValues,
            unit: selectedRankingParameter.unit,
            shortName: selectedRankingParameter.shortName,
            category: selectedRankingParameter.category,
            key: primaryRankingKey,
            sort: temperatureRankingSort,
            direction: temperatureRankingDirection,
            highlight: true,
            boundaryValue: temperatureRankingDirection === 'lowest'
                ? oppositePrimaryBoundaryValue
                : primaryBoundaryValue
        },
        precipitation: { values: sortValues('precipitation', 1), unit: 'mm', shortName: 'Precip_24h', category: 'precipitation', key: 'precipitation', highlight: true, ...secondaryRankingSorts.precipitation },
        wind: { values: sortValues('wind', 1), unit: 'km/h', shortName: 'Wind_max', category: 'wind', key: 'wind', highlight: true, ...secondaryRankingSorts.wind }
    };

    Object.entries(rankings).forEach(([name, ranking]) => {
        const body = container.querySelector(`[data-ranking="${name}"]`);
        if (!body) return;
        body.onmouseover = event => {
            const row = event.target.closest('tr[data-station-id]');
            if (row) setHoveredRankingStation(row.dataset.stationId, row);
        };
        body.onmouseleave = () => setHoveredRankingStation(null);
        let boundaryValue = ranking.boundaryValue;
        if (boundaryValue === undefined) {
            boundaryValue = ranking.highlight
                ? ranking.values[0]?.[ranking.key]
                : null;
        }
        const sortColumn = ranking.sort === 'value' ? 'value' : ranking.sort.split('-')[0];
        const ascending = ranking.sort === 'value'
            ? ranking.direction === 'lowest'
            : ranking.sort.endsWith('-asc');
        ranking.values.sort((first, second) => {
            if (sortColumn === 'alphabetical') {
                return (ascending ? 1 : -1) * first.station.localeCompare(second.station, 'pl', { sensitivity: 'base' });
            }
            if (sortColumn === 'elevation') {
                if (first.elevation === null) return second.elevation === null ? 0 : 1;
                if (second.elevation === null) return -1;
                return (ascending ? 1 : -1) * (first.elevation - second.elevation);
            }
            return (ascending ? 1 : -1) * (first[ranking.key] - second[ranking.key]);
        });
        const tableSelector = `[data-ranking-table="${name}"]`;
        if (name !== 'temperature') {
            container.querySelector(`${tableSelector} [data-ranking-column="value"]`).textContent = ranking.shortName;
        }
        ['value', 'alphabetical', 'elevation'].forEach(column => {
            container.querySelector(`${tableSelector} [data-sort-column="${column}"]`).setAttribute(
                'aria-sort',
                column === sortColumn ? (ascending ? 'ascending' : 'descending') : 'none'
            );
        });
        body.innerHTML = ranking.values.length
            ? ranking.values.map(entry => {
                const isBoundaryValue = boundaryValue !== null && entry[ranking.key] === boundaryValue;
                const highlightClass = ranking.highlight && isBoundaryValue
                    ? ' ranking-value-highlight'
                    : '';
                const unitSpacing = ranking.unit === '°C' ? '' : ' ';
                const elevation = entry.elevation === null ? '—' : formatValue(entry.elevation, 0);
                const temperatureClass = ranking.unit === '°C' ? ' ranking-value-temperature' : '';
                const rowHighlightColor = ranking.category === 'temperature'
                    ? getTemperatureStyle(entry[ranking.key]).bg
                    : getLabelScaleColor(
                        entry[ranking.key],
                        ranking.category === 'precipitation' ? precipLabelScale : windLabelScale
                    );
                return `<tr data-station-id="${escapeHtml(entry.stationId)}" data-highlight-color="${escapeHtml(rowHighlightColor)}"><td class="ranking-value${temperatureClass}${highlightClass}">${formatValue(entry[ranking.key], 1)}${unitSpacing}${ranking.unit}</td><td class="ranking-station${highlightClass}">${escapeHtml(entry.station)}</td><td class="ranking-elevation${highlightClass}">${elevation}</td></tr>`;
            }).join('')
            : '<tr><td class="ranking-empty" colspan="3">Brak danych</td></tr>';
    });
}

function showNoDataState(dateStr) {
    clearMapData();
    globalGeoJsonData = null;
    updateRankingsPanel(currentHourStr);

    const currentTimeLabel = document.getElementById('currentTimeLabel');
    const span = currentTimeLabel ? currentTimeLabel.querySelector('span') : null;
    if (span) {
        span.textContent = 'brak danych';
        span.style.color = '#e74c3c';
    }

    const datePicker = document.getElementById('datePicker');
    if (datePicker) {
        datePicker.title = `Brak danych dla ${dateStr}`;
        datePicker.setCustomValidity('Brak danych dla tej daty');
    }
}

function loadDataForDate(dateStr, selectedHour) {
    const request = ++dateLoadRequest;
    clearMapData();
    if (!dateStr) return;
    const path = `imgw_data/${dateStr}.geojson`;
    const previousDate = new Date(Date.parse(`${dateStr}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const previousPath = `imgw_data/${previousDate}.geojson`;
    const fetchData = filePath => fetch(`${filePath}?t=${Date.now()}`, { cache: 'no-store' })
        .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        });
    const previousData = fetchData(previousPath)
        .then(data => ({ data, error: null }))
        .catch(error => ({ data: null, error }));
    if (!stationActivityRequest) {
        stationActivityRequest = fetchData('imgw_data/station_activity.json').then(index => {
            if (index?.version !== 3 || !index.days || typeof index.days !== 'object' ||
                !index.parameters || typeof index.parameters !== 'object') {
                throw new Error('Nieprawidłowy indeks aktywności stacji.');
            }
            return index;
        }).catch(error => {
            console.error('Nie udało się wczytać historii aktywności stacji:', error);
            return null;
        });
    }
    Promise.all([fetchData(path), previousData, stationActivityRequest])
        .then(([data, previous, activityIndex]) => {
            if (request !== dateLoadRequest) return;
            stationActivityIndex = activityIndex;
            if (previous.error) console.warn('Nie udało się wczytać danych poprzedniego dnia:', previousPath, previous.error);
            processData(data, selectedHour, dateStr, previous.data);
            const incompleteHistory = !activityIndex || data.features.some(feature =>
                feature?.geometry && (feature?.properties?.Activity_check_failed || getStationActivity(feature) === 'unknown'));
            const currentTimeLabel = document.getElementById('currentTimeLabel');
            const span = currentTimeLabel ? currentTimeLabel.querySelector('span') : null;
            if (span) span.style.color = '#2ecc71';
            const datePicker = document.getElementById('datePicker');
            if (datePicker) {
                datePicker.setCustomValidity('');
                const warnings = [];
                if (incompleteHistory) warnings.push('Historia aktywności części stacji jest niepełna; ich status może być niepotwierdzony.');
                if (previous.error) {
                    warnings.push(`Nie udało się wczytać danych z ${previousDate}; kompletność doby jest niepotwierdzona.`);
                }
                const end = Date.parse(meteorologicalHourlySlots[meteorologicalHourlySlots.length - 1].utc);
                if (latestMeteorologicalHour !== null && latestMeteorologicalHour < end) {
                    warnings.push('Kompletność sprawdzono do ostatnich dostępnych pomiarów; późniejsze godziny nie zostały ocenione.');
                }
                const repeatedSlots = meteorologicalHourlySlots.filter(slot => slot.repeated);
                if (repeatedSlots.length && data.features.some(feature => {
                    if (feature?.properties?.Status !== 'ACTIVE') return false;
                    if (!Object.values(feature.properties.Hourly || {}).some(hour =>
                        ['Ta', 'Precip', 'Wind_avg', 'Wind_max'].some(key => hour?.[key] != null)
                    )) return false;
                    return repeatedSlots.some(slot => {
                        const properties = slot.date === meteorologicalDate
                            ? feature.properties
                            : previousDayStations.get(String(feature.properties.Station_id));
                        return !properties?.Hourly?.[slot.hour]?.UTC?.[slot.utc];
                    });
                })) {
                    warnings.push('Dla części stacji nie ma danych UTC do sprawdzenia powtórzonej godziny.');
                }
                datePicker.title = warnings.join(' ');
            }
        })
        .catch(err => {
            if (request !== dateLoadRequest) return;
            console.error('Could not load', path, err);
            showNoDataState(dateStr);
        });
}

function buildStationStatusControl() {
    const control = L.control({ position: 'bottomleft' });
    control.onAdd = function () {
        const div = L.DomUtil.create('div', 'leaflet-control station-status-control');
        const statuses = [
            ['active', '#2ecc71', 'Stacje aktywne'],
            ['incomplete', '#ffff00', 'Stacje z niepełnymi danymi'],
            ['missing', '#e74c3c', 'Stacje z brakiem danych'],
            ['closed', '#b0b0b0', 'Stacje nieczynne / zamknięte']
        ];
        div.innerHTML = `<strong>Status stacji</strong>${statuses.map(([key, color, label]) =>
            `<label><input type="checkbox" data-station-status="${key}" checked><span class="station-status-dot" style="background:${color}"></span>${label}</label>`
        ).join('')}`;
        div.querySelectorAll('input[data-station-status]').forEach(input => {
            input.addEventListener('change', () => {
                visibleStationStatuses[input.dataset.stationStatus] = input.checked;
                renderDataForHour(currentHourStr);
            });
        });
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
    };
    control.addTo(map);
}

function buildUnifiedLayerControl() {
    if (layersControl) return;
    const savedPreferences = loadMapPreferences();
    const overlayMaps = {
        "Nazwa stacji (Station_name)": etykietyStationName,
        "Wysokość (Elevation)": etykietyElevation,
        "Temperatura aktualna (Ta)": etykietyTa,
        "Temperatura minimalna (Tmin)": etykietyTmin,
        "Temperatura maksymalna (Tmax)": etykietyTmax,
        "Temperatura min. godzinowa (Tmin_hour)": etykietyTminHour,
        "Temperatura max. godzinowa (Tmax_hour)": etykietyTmaxHour,
        "Temperatura przy gruncie (Tg)": etykietyTg,
        "Suma opadów (Precip_24h)": etykietyOpady24h,
        "Opad wybranej godziny (Precip_hour)": etykietyOpady10min,
        "Średnia prędkość wiatru (Wind_avg)": etykietyWindAvg,
        "Maksymalny poryw wiatru (Wind_max)": etykietyWindMax
    };

    layersControl = L.control({ position: 'topleft' });
    layersControl.onAdd = function () {
        const div = L.DomUtil.create('div', 'leaflet-control compact-panel main-control-panel');
        const reversedScale = [...tempScale].reverse();
        const precipLegendScale = precipLabelScale.map(([mm, r, g, b]) => ({ mm, r, g, b }));
        const precipReversedScale = [...precipLegendScale].reverse();
        const precipTickScale = precipLegendScale.filter(item => item.mm % 10 === 0);
        const precipReversedTickScale = [...precipTickScale].reverse();
        const windColorStops = [
            { kmh: 0, r: 255, g: 255, b: 255 },
            { kmh: 10, r: 197, g: 213, b: 224 },
            { kmh: 20, r: 79, g: 145, b: 200 },
            { kmh: 30, r: 61, g: 175, b: 160 },
            { kmh: 40, r: 84, g: 174, b: 88 },
            { kmh: 50, r: 143, g: 214, b: 163 },
            { kmh: 60, r: 241, g: 220, b: 69 },
            { kmh: 70, r: 243, g: 154, b: 54 },
            { kmh: 80, r: 216, g: 107, b: 38 },
            { kmh: 90, r: 222, g: 55, b: 61 },
            { kmh: 100, r: 151, g: 27, b: 40 },
            { kmh: 110, r: 93, g: 16, b: 28 },
            { kmh: 120, r: 116, g: 29, b: 49 },
            { kmh: 130, r: 132, g: 62, b: 76 },
            { kmh: 140, r: 148, g: 96, b: 106 },
            { kmh: 150, r: 163, g: 126, b: 133 },
            { kmh: 160, r: 178, g: 153, b: 158 },
            { kmh: 170, r: 193, g: 177, b: 181 },
            { kmh: 180, r: 208, g: 199, b: 201 },
            { kmh: 190, r: 227, g: 223, b: 224 },
            { kmh: 200, r: 245, g: 245, b: 245 }
        ];
        const windReversedScale = [...windColorStops].reverse();
        const tempHeight = 250;
        const precipHeight = 250;
        const windHeight = 250;

        div.innerHTML = `
            <div class="panel-global-header">
                <div class="panel-main-title">Ustawienia</div>
                <button type="button" class="panel-toggle-btn panel-global-toggle" aria-label="Zwiń okno" title="Zwiń okno">▾</button>
            </div>
            <div class="panel-section">
                <div class="panel-header">
                    <div class="panel-title">Podkład mapy:</div>
                </div>
                <div class="basemap-body">
                    <label><input type="radio" name="customBaseLayer" value="osm">Standardowy (OSM)</label>
                    <label><input type="radio" name="customBaseLayer" value="esri">Satelita (Esri)</label>
                    <label><input type="radio" name="customBaseLayer" value="carto">Ciemny z granicami (Esri)</label>
                    <label><input type="radio" name="customBaseLayer" value="topo" checked>Topograficzny</label>
                </div>
                <div class="basemap-footer">
                    <div class="basemap-range-group">
                        <label for="opacitySlider">Widoczność podkładu: <span id="opacityVal" class="setting-value-field">100%</span></label>
                        <input type="range" id="opacitySlider" min="0" max="1" step="0.1" value="1">
                    </div>
                    <div class="basemap-range-group basemap-range-group--zoom">
                        <label for="zoomSlider">Powiększenie mapy: <span id="zoomVal" class="setting-value-field">6.7x</span></label>
                        <input type="range" id="zoomSlider" min="4" max="18" step="0.1" value="6.7">
                    </div>
                </div>
            </div>

            <div class="panel-section parameters-section">
                <div class="panel-header">
                    <div class="panel-title">Parametry:</div>
                </div>
                <div class="panel-body leaflet-control-layers-list" id="unified-parameter-list"></div>
            </div>

            <div class="panel-section legend-section">
                <div class="panel-header">
                    <div class="panel-title">Legenda:</div>
                </div>
                <div class="map-legend-container" style="width:auto; max-width:none; min-width:0; padding:8px 0 0 0; margin:0; background:transparent; box-shadow:none; border-radius:0;">
                    <div style="display:flex; align-items:flex-start; gap:2px; padding-bottom: 12px; margin-bottom: 0;">
                        <div class="legend-temperature-column" style="flex:1; min-width:0; position:relative;">
                            <div class="legend-subtitle legend-vertical-title">Temperatura [°C]:</div>
                            <div class="legend-body" style="display:flex; align-items:stretch; height: ${tempHeight}px; position:relative; padding-left:18px;">
                                <div class="legend-bar" style="width: 6px; margin-right: 6px; border: 1px solid #999; background: linear-gradient(to bottom, ${reversedScale.map(i => `rgb(${i.r},${i.g},${i.b})`).join(', ')}); position: relative;">
                                    <div style="position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none;">
                                        ${reversedScale.map((i, idx) => {
                                            const percent = (idx / (reversedScale.length - 1)) * 100;
                                            return `<div style="position:absolute; top:${percent}%; left:50%; width:10px; height:1px; background:#aaa; opacity:0.7; transform:translate(-50%, -50%);"></div>`;
                                        }).join('')}
                                    </div>
                                </div>
                                <div class="legend-labels" style="position:relative; flex:1; min-width:0;">
                                    ${reversedScale.map((i, idx) => {
                                        const percent = (idx / (reversedScale.length - 1)) * 100;
                                        return `<div class="legend-label-row" style="position:absolute; top:${percent}%; left:0; transform:translateY(-50%); font-size:9.1px; line-height:1; letter-spacing:-0.03em; white-space:nowrap;"> <span class="legend-value" style="font-weight:400; color:#374151; opacity:0.8;">${i.t}</span></div>`;
                                    }).join('')}
                                </div>
                            </div>
                        </div>
                        <div class="legend-precipitation-column" style="flex:1; min-width:0; position:relative;">
                            <div class="legend-subtitle legend-vertical-title">Opady [mm]:</div>
                            <div class="legend-body" style="display:flex; align-items:stretch; height: ${precipHeight}px; position:relative; padding-left:18px;">
                                <div class="legend-bar" style="width: 6px; margin-right: 6px; border: 1px solid #999; background: linear-gradient(to bottom, ${precipReversedScale.map(i => `rgb(${i.r},${i.g},${i.b})`).join(', ')}); position: relative;">
                                    <div style="position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none;">
                                        ${precipReversedTickScale.map((i, idx) => {
                                            const percent = (idx / (precipReversedTickScale.length - 1)) * 100;
                                            return `<div style="position:absolute; top:${percent}%; left:50%; width:10px; height:1px; background:#aaa; opacity:0.7; transform:translate(-50%, -50%);"></div>`;
                                        }).join('')}
                                    </div>
                                </div>
                                <div class="legend-labels" style="position:relative; flex:1; min-width:0;">
                                    ${precipReversedTickScale.map((i, idx) => {
                                        const percent = (idx / (precipReversedTickScale.length - 1)) * 100;
                                        return `<div class="legend-label-row" style="position:absolute; top:${percent}%; left:0; transform:translateY(-50%); font-size:9.1px; line-height:1; letter-spacing:-0.03em; white-space:nowrap;"> <span class="legend-value" style="font-weight:400; color:#374151; opacity:0.8;">${i.mm}</span></div>`;
                                    }).join('')}
                                </div>
                            </div>
                        </div>
                        <div class="legend-wind-column" style="flex:1; min-width:0; position:relative;">
                            <div class="legend-subtitle legend-vertical-title">Wiatr [km/h]:</div>
                            <div class="legend-body" style="display:flex; align-items:stretch; height: ${windHeight}px; position:relative; padding-left:18px;">
                                <div class="legend-bar" style="width: 6px; margin-right: 6px; border: 1px solid #999; background: linear-gradient(to bottom, ${windReversedScale.map(i => `rgb(${i.r},${i.g},${i.b})`).join(', ')}); position: relative;">
                                    <div style="position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none;">
                                        ${windReversedScale.map((i, idx) => {
                                            const percent = (idx / (windReversedScale.length - 1)) * 100;
                                            return `<div style="position:absolute; top:${percent}%; left:50%; width:10px; height:1px; background:#aaa; opacity:0.7; transform:translate(-50%, -50%);"></div>`;
                                        }).join('')}
                                    </div>
                                </div>
                                <div class="legend-labels" style="position:relative; flex:1; min-width:0;">
                                    ${windReversedScale.map((i, idx) => {
                                        const percent = (idx / (windReversedScale.length - 1)) * 100;
                                        return `<div class="legend-label-row" style="position:absolute; top:${percent}%; left:0; transform:translateY(-50%); font-size:9.1px; line-height:1; letter-spacing:-0.03em; white-space:nowrap;"> <span class="legend-value" style="font-weight:400; color:#374151; opacity:0.8;">${i.kmh}</span></div>`;
                                    }).join('')}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const parameterList = div.querySelector('#unified-parameter-list');
        Object.entries(overlayMaps).forEach(([label, layerGroup]) => {
            const row = document.createElement('label');
            row.className = 'leaflet-control-layers-overlays-label';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.overlayLabel = label;
            input.checked = savedPreferences.parameters.includes(label);
            row.appendChild(input);
            row.appendChild(document.createTextNode(label));
            row.addEventListener('change', () => {
                rankingParameterOverride = null;
                if (input.checked) {
                    map.addLayer(layerGroup);
                    const tempItem = tempLayerMapping.find(t => t.group === layerGroup);
                    if (tempItem) {
                        activeTempParam = tempItem.key;
                    }
                } else {
                    map.removeLayer(layerGroup);
                    const tempItem = tempLayerMapping.find(t => t.group === layerGroup);
                    if (tempItem && activeTempParam === tempItem.key) {
                        const nextActive = tempLayerMapping.find(t => map.hasLayer(t.group));
                        if (nextActive) {
                            activeTempParam = nextActive.key;
                        }
                    }
                }
                updateLegendVisibility();
                updateRankingsPanel(currentHourStr);
                saveCurrentMapPreferences();
            });
            parameterList.appendChild(row);
        });

        const radios = div.querySelectorAll('input[name="customBaseLayer"]');
        const slider = div.querySelector('#opacitySlider');
        const valLabel = div.querySelector('#opacityVal');
        const zoomSlider = div.querySelector('#zoomSlider');
        const zoomValLabel = div.querySelector('#zoomVal');

        const saveCurrentMapPreferences = () => {
            const selectedBaseLayer = div.querySelector('input[name="customBaseLayer"]:checked')?.value || 'topo';
            const selectedParameters = [...parameterList.querySelectorAll('input[type="checkbox"]:checked')]
                .map(input => input.dataset.overlayLabel);
            saveMapPreferences(
                selectedBaseLayer,
                parseFloat(slider?.value || '1'),
                selectedParameters,
                temperatureRankingDirection,
                temperatureRankingSort
            );
        };

        const applyBaseLayer = selectedVal => {
            map.removeLayer(activeBaseLayer);
            map.removeLayer(darkMapReference);
            if (selectedVal === 'osm') activeBaseLayer = osmLayer;
            if (selectedVal === 'esri') activeBaseLayer = esriSatelite;
            if (selectedVal === 'carto') activeBaseLayer = cartoDbDark;
            if (selectedVal === 'topo') activeBaseLayer = openTopo;
            const opacity = slider ? parseFloat(slider.value || '1') : 1;
            activeBaseLayer.setOpacity(opacity);
            map.addLayer(activeBaseLayer);
            activeBaseLayer.bringToBack();
            if (selectedVal === 'carto') {
                darkMapReference.setOpacity(opacity * 0.7);
                map.addLayer(darkMapReference);
            }
        };

        radios.forEach(radio => {
            radio.checked = radio.value === savedPreferences.baseLayer;
        });
        if (slider) {
            slider.value = String(savedPreferences.opacity);
            if (valLabel) valLabel.textContent = Math.round(savedPreferences.opacity * 100) + '%';
        }
        Object.entries(overlayMaps).forEach(([label, layerGroup]) => {
            if (savedPreferences.parameters.includes(label)) {
                map.addLayer(layerGroup);
            } else {
                map.removeLayer(layerGroup);
            }
        });
        const selectedTemperature = tempLayerMapping.find(item => map.hasLayer(item.group));
        if (selectedTemperature) activeTempParam = selectedTemperature.key;
        applyBaseLayer(savedPreferences.baseLayer);

        radios.forEach(radio => {
            radio.addEventListener('change', function (e) {
                const selectedVal = e.target.value;
                applyBaseLayer(selectedVal);
                saveCurrentMapPreferences();
            });
        });

        if (slider) {
            slider.addEventListener('input', function (e) {
                const alpha = parseFloat(e.target.value);
                if (activeBaseLayer && activeBaseLayer.setOpacity) activeBaseLayer.setOpacity(alpha);
                if (map.hasLayer(darkMapReference)) darkMapReference.setOpacity(alpha * 0.7);
                if (valLabel) valLabel.textContent = Math.round(alpha * 100) + '%';
                saveCurrentMapPreferences();
            });
        }

        if (zoomSlider) {
            const syncZoomLabel = () => {
                if (zoomSlider) zoomSlider.value = String(map.getZoom());
                if (zoomValLabel) zoomValLabel.textContent = `${Number(map.getZoom()).toFixed(1)}x`;
            };
            zoomSlider.addEventListener('input', function (e) {
                const nextZoom = parseFloat(e.target.value);
                map.setZoom(nextZoom);
                if (zoomValLabel) zoomValLabel.textContent = `${nextZoom.toFixed(1)}x`;
            });
            syncZoomLabel();
            map.on('zoomend', syncZoomLabel);
        }

        const globalToggle = div.querySelector('.panel-global-toggle');
        globalToggle.addEventListener('click', () => {
            const collapsed = div.classList.toggle('collapsed');
            globalToggle.textContent = collapsed ? '▸' : '▾';
            globalToggle.setAttribute('aria-label', collapsed ? 'Pokaż okno' : 'Zwiń okno');
            globalToggle.setAttribute('title', collapsed ? 'Pokaż okno' : 'Zwiń okno');
        });

        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
    };

    layersControl.addTo(map);
}

function updateLegendVisibility() {
    const el = document.querySelector('.map-legend-container');
    if (!el) return;
    if (el.dataset.manualHidden === 'true') {
        el.style.display = 'none';
        return;
    }
    el.style.display = 'block';
}

function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark-theme', isDark);

    const lightBtn = document.getElementById('themeLightBtn');
    const darkBtn = document.getElementById('themeDarkBtn');

    [lightBtn, darkBtn].forEach(btn => {
        if (!btn) return;
        const isActive = btn.dataset.theme === theme;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
    });

    try {
        localStorage.setItem('imgw_theme', theme);
    } catch (e) {
        console.warn('Nie udało się zapisać motywu:', e);
    }
}

function initThemeToggle() {
    const savedTheme = (() => {
        try {
            return localStorage.getItem('imgw_theme') || 'light';
        } catch (e) {
            return 'light';
        }
    })();

    const lightBtn = document.getElementById('themeLightBtn');
    const darkBtn = document.getElementById('themeDarkBtn');

    if (lightBtn) lightBtn.addEventListener('click', () => applyTheme('light'));
    if (darkBtn) darkBtn.addEventListener('click', () => applyTheme('dark'));

    applyTheme(savedTheme === 'dark' ? 'dark' : 'light');
}

function initTimelineUI() {
    const datePicker = document.getElementById('datePicker');
    const datePickerDisplay = document.getElementById('datePickerDisplay');
    const hourSlider = document.getElementById('hourSlider');
    const ticksContainer = document.getElementById('ticksContainer');
    const currentTimeLabel = document.getElementById('currentTimeLabel');
    let availableDates = [];
    initStationChartsDialog();
    initThemeToggle();

    if (ticksContainer) {
        ticksContainer.innerHTML = '';
        for (let h = 0; h < 24; h++) {
            const d = document.createElement('div');
            d.className = 'timeline-tick-label';
            d.textContent = (h < 10 ? '0' + h : h) + ':00';
            ticksContainer.appendChild(d);
        }
    }

    function updateTimeLabel(val) {
        const span = currentTimeLabel ? currentTimeLabel.querySelector('span') : null;
        if (span) span.textContent = (val < 10 ? '0' + val : val) + ':00';
    }

    function updateDatePickerDisplay() {
        if (!datePicker || !datePickerDisplay) return;
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePicker.value);
        datePickerDisplay.textContent = match ? `${match[3]}.${match[2]}.${match[1]}` : '';
    }

    function setDatePickerValue(value) {
        if (!datePicker) return;
        datePicker.value = value;
        updateDatePickerDisplay();
    }

    const now = new Date();
    const todayStr = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
    ].join('-');

    if (hourSlider) {
        hourSlider.addEventListener('input', (e) => {
            const val = e.target.value;
            updateTimeLabel(val);
            const hourStr = String(val).padStart(2, '0');
            renderDataForHour(hourStr);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                const currentHour = parseInt(hourSlider.value);
                if (currentHour === 0 && datePicker) {
                    const currentDateIndex = availableDates.indexOf(datePicker.value);
                    const previousDate = availableDates[currentDateIndex + 1];
                    if (previousDate) {
                        setDatePickerValue(previousDate);
                        loadDataForDate(previousDate, 23);
                    }
                    return;
                }
                const newVal = Math.max(0, currentHour - 1);
                hourSlider.value = newVal;
                hourSlider.dispatchEvent(new Event('input'));
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                const currentHour = parseInt(hourSlider.value);
                if (currentHour === 23 && datePicker) {
                    const currentDateIndex = availableDates.indexOf(datePicker.value);
                    const nextDate = availableDates[currentDateIndex - 1];
                    if (nextDate) {
                        setDatePickerValue(nextDate);
                        loadDataForDate(nextDate, 0);
                    }
                    return;
                }
                const newVal = Math.min(23, currentHour + 1);
                hourSlider.value = newVal;
                hourSlider.dispatchEvent(new Event('input'));
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                if (!datePicker || !datePicker.value) return;
                const [year, month, day] = datePicker.value.split('-').map(Number);
                const selectedDate = new Date(year, month - 1, day);
                selectedDate.setDate(selectedDate.getDate() + (e.key === 'ArrowUp' ? 1 : -1));
                const nextDate = [
                    selectedDate.getFullYear(),
                    String(selectedDate.getMonth() + 1).padStart(2, '0'),
                    String(selectedDate.getDate()).padStart(2, '0')
                ].join('-');
                setDatePickerValue(nextDate);
                datePicker.dispatchEvent(new Event('change'));
            }
        });
    }

    buildUnifiedLayerControl();
    buildStationStatusControl();
    buildRankingsControl();

    if (datePicker) {
        setDatePickerValue(todayStr);

        fetch(`imgw_data/dates.json?t=${Date.now()}`, { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .then(dates => {
                if (Array.isArray(dates)) {
                    availableDates = dates;
                    latestAvailableDate = dates.reduce((latest, date) =>
                        typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && (!latest || date > latest)
                            ? date
                            : latest, null);
                }
                setDatePickerValue(todayStr);
                loadDataForDate(todayStr);
            })
            .catch(() => {
                setDatePickerValue(todayStr);
                loadDataForDate(todayStr);
            });

        datePicker.addEventListener('change', () => {
            updateDatePickerDisplay();
            const selectedHour = hourSlider ? Number(hourSlider.value) : undefined;
            loadDataForDate(datePicker.value, selectedHour);
        });
    } else {
        loadDataForDate(todayStr);
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTimelineUI); else initTimelineUI();