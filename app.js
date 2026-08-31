const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
});

const esriSatelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
});

const cartoDbDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
});

const openTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: 'Map data &copy; OpenStreetMap contributors'
});

let activeBaseLayer = openTopo;

const map = L.map('map', {
    center: [52.068811, 19.479699],
    zoom: 6.5,
    layers: [openTopo],
    zoomControl: false
});

L.control.zoom({ position: 'topright' }).addTo(map);

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

etykietyTa.addTo(map);

let globalGeoJsonData = null;

function getMarkerStyle(feature) {
    return {
        radius: 3,
        fillColor: '#2ecc71',
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

function convertMetersPerSecondToKilometersPerHour(value) {
    if (value !== undefined && value !== null && value !== "") {
        if (!isNaN(value)) {
            return Number(value) * 3.6;
        }
    }
    return null;
}

const tempScale = [
    { t: -40, r: 245, g: 242, b: 245 }, { t: -35, r: 212, g: 185, b: 204 }, { t: -30, r: 125, g: 90,  b: 110 },
    { t: -25, r: 214, g: 110, b: 247 }, { t: -20, r: 135, g: 45,  b: 230 }, { t: -15, r: 40,  g: 30,  b: 215 },
    { t: -10, r: 50,  g: 100, b: 230 }, { t: -5,  r: 120, g: 190, b: 245 }, { t: 0,   r: 195, g: 255, b: 250 },
    { t: 5,   r: 120, g: 235, b: 160 }, { t: 10,  r: 55,  g: 160, b: 50  }, { t: 15,  r: 175, g: 215, b: 65  },
    { t: 20,  r: 255, g: 245, b: 50  }, { t: 25,  r: 255, g: 165, b: 40  }, { t: 30,  r: 255, g: 50,  b: 40  },
    { t: 35,  r: 180, g: 25,  b: 45  }, { t: 40,  r: 245, g: 150, b: 180 }
];

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

function addDataToParamGroup(rawValue, suffix, className, positionClass, latlng, popupContent, feature, group, isElevation = false, extremeType = '') {
    const decimals = isElevation ? 0 : 1;
    const formatted = formatValue(rawValue, decimals);
    if (formatted !== null) {
        const marker = L.circleMarker(latlng, getMarkerStyle(feature));
        marker.bindPopup(popupContent);
        const direction = positionClass === 'etykieta-dol' ? 'bottom' : 'top';

        let extraClass = '';
        if (extremeType === 'max') extraClass = ' ramka-max';
        if (extremeType === 'min') extraClass = ' ramka-min';

        const fullClassName = 'stacja-etykieta ' + className + ' ' + positionClass + extraClass;
        const isTemperatureLayer = ['temp-aktualna', 'temp-min', 'temp-min-hour', 'temp-max', 'temp-max-hour', 'temp-grunt'].includes(className);

        let tooltipContent;
        if (isTemperatureLayer) {
            let borderStyle = '1px solid #666';
            if (extremeType === 'max') borderStyle = '2px solid #ff0000';
            if (extremeType === 'min') borderStyle = '2px solid #0000ff';
            const tStyle = getTemperatureStyle(rawValue);
            tooltipContent = `<div style="background: ${tStyle.bg} !important; border: ${borderStyle} !important; width: 100%; height: 100%; display: inline-flex; align-items: center; justify-content: center; margin: -1px -3px; padding: 1px 3px; border-radius: 2px;">${formatted}${suffix}</div>`;
        } else {
            tooltipContent = `${formatted}${suffix}`;
        }

        const lbl = L.tooltip({ permanent: true, direction: direction, offset: [0, 0], className: fullClassName }).setContent(tooltipContent).setLatLng(latlng);
        group.addLayer(marker);
        group.addLayer(lbl);
    }
}

function clearMapData() {
    [etykietyTa, etykietyTmin, etykietyTmax, etykietyTminHour, etykietyTmaxHour, etykietyTg, etykietyOpady24h, etykietyOpady10min, etykietyWindAvg, etykietyWindMax, etykietyElevation, etykietyStationName].forEach(g => { try { g.clearLayers(); } catch (e){} });
}

let layersControl = null;

function getLastAvailableHourFromData(data) {
    if (!data || !Array.isArray(data.features)) return 23;

    let maxHour = -1;
    data.features.forEach(feature => {
        const props = feature && feature.properties ? feature.properties : null;
        if (!props || props.Status !== 'ACTIVE' || !props.Hourly) return;

        Object.keys(props.Hourly).forEach(hourKey => {
            const hourValue = props.Hourly[hourKey];
            if (!hourValue) return;
            const hourNum = Number(hourKey);
            if (!Number.isNaN(hourNum)) {
                const hasMeasurement = Object.keys(hourValue).some(key => hourValue[key] !== undefined && hourValue[key] !== null && hourValue[key] !== '');
                if (hasMeasurement) maxHour = Math.max(maxHour, hourNum);
            }
        });
    });

    return maxHour >= 0 ? maxHour : 23;
}

function processData(data) {
    globalGeoJsonData = data; 
    const hourSlider = document.getElementById('hourSlider');
    const hourStr = hourSlider ? String(getLastAvailableHourFromData(data)).padStart(2, '0') : '12';
    if (hourSlider) {
        hourSlider.value = String(getLastAvailableHourFromData(data));
        const currentTimeLabel = document.getElementById('currentTimeLabel');
        const span = currentTimeLabel ? currentTimeLabel.querySelector('span') : null;
        if (span) span.textContent = hourStr + ':00';
    }
    renderDataForHour(hourStr);
}

function renderDataForHour(hourStr) {
    clearMapData();
    if (!globalGeoJsonData) return;

    let extremes = { Ta: { min: Infinity, max: -Infinity }, Tmin: { min: Infinity, max: -Infinity }, Tmax: { min: Infinity, max: -Infinity }, Tmin_hour: { min: Infinity, max: -Infinity }, Tmax_hour: { min: Infinity, max: -Infinity }, Tg: { min: Infinity, max: -Infinity }, Wind_avg: { min: Infinity, max: -Infinity }, Wind_max: { min: Infinity, max: -Infinity }, Precip_24h: { max: -Infinity }, Precip_10min: { max: -Infinity } };

    globalGeoJsonData.features.forEach(f => {
        const p = f.properties;
        if (p.Status === 'ACTIVE') {
            const wAvg = convertMetersPerSecondToKilometersPerHour(p.Wind_avg), wMax = convertMetersPerSecondToKilometersPerHour(p.Wind_max);
            const hourlyTa = p.Hourly && p.Hourly[hourStr] && p.Hourly[hourStr].Ta !== undefined ? p.Hourly[hourStr].Ta : null;
            const hourlyPrecip = p.Hourly && p.Hourly[hourStr] && p.Hourly[hourStr].Precip !== undefined ? p.Hourly[hourStr].Precip : null;

            if (hourlyTa != null) { extremes.Ta.min = Math.min(extremes.Ta.min, hourlyTa); extremes.Ta.max = Math.max(extremes.Ta.max, hourlyTa); }
            if (p.Tmin != null) { extremes.Tmin.min = Math.min(extremes.Tmin.min, p.Tmin); extremes.Tmin.max = Math.max(extremes.Tmin.max, p.Tmin); }
            if (p.Tmax != null) { extremes.Tmax.min = Math.min(extremes.Tmax.min, p.Tmax); extremes.Tmax.max = Math.max(extremes.Tmax.max, p.Tmax); }
            if (p.Tmin_hour != null) { extremes.Tmin_hour.min = Math.min(extremes.Tmin_hour.min, p.Tmin_hour); extremes.Tmin_hour.max = Math.max(extremes.Tmin_hour.max, p.Tmin_hour); }
            if (p.Tmax_hour != null) { extremes.Tmax_hour.min = Math.min(extremes.Tmax_hour.min, p.Tmax_hour); extremes.Tmax_hour.max = Math.max(extremes.Tmax_hour.max, p.Tmax_hour); }
            if (p.Tg != null) { extremes.Tg.min = Math.min(extremes.Tg.min, p.Tg); extremes.Tg.max = Math.max(extremes.Tg.max, p.Tg); }
            if (wAvg != null) { extremes.Wind_avg.min = Math.min(extremes.Wind_avg.min, wAvg); extremes.Wind_avg.max = Math.max(extremes.Wind_avg.max, wAvg); }
            if (wMax != null) { extremes.Wind_max.min = Math.min(extremes.Wind_max.min, wMax); extremes.Wind_max.max = Math.max(extremes.Wind_max.max, wMax); }
            if (p.Precip_24h != null) extremes.Precip_24h.max = Math.max(extremes.Precip_24h.max, p.Precip_24h);
            if (hourlyPrecip != null) extremes.Precip_10min.max = Math.max(extremes.Precip_10min.max, hourlyPrecip);
        }
    });

    L.geoJSON(globalGeoJsonData, {
        pointToLayer: function (feature, latlng) {
            const props = feature.properties;
            if (props.Status !== 'ACTIVE') return null;

            const wAvgKmh = convertMetersPerSecondToKilometersPerHour(props.Wind_avg), wMaxKmh = convertMetersPerSecondToKilometersPerHour(props.Wind_max);
            
            let hourlyTa = props.Hourly && props.Hourly[hourStr] && props.Hourly[hourStr].Ta !== undefined ? props.Hourly[hourStr].Ta : null;
            let hourlyPrecip = props.Hourly && props.Hourly[hourStr] && props.Hourly[hourStr].Precip !== undefined ? props.Hourly[hourStr].Precip : null;

            const fTa = formatValue(hourlyTa, 1), 
                  fTmin = formatValue(props.Tmin, 1), 
                  fTmax = formatValue(props.Tmax, 1), 
                  fTminHour = formatValue(props.Tmin_hour, 1), 
                  fTmaxHour = formatValue(props.Tmax_hour, 1), 
                  fTg = formatValue(props.Tg, 1), 
                  fPrecip24h = formatValue(props.Precip_24h, 1), 
                  fPrecip10min = formatValue(props.Precip_10min, 1), 
                  fWindAvg = formatValue(wAvgKmh, 1), 
                  fWindMax = formatValue(wMaxKmh, 1), 
                  fElevation = formatValue(props.Elevation, 0);

            let popupContent = `<h3>${props.Station_name || 'Stacja pomiarowa'}</h3><hr><p><strong>ID:</strong> ${props.Station_id}</p><p><strong>Status:</strong> <span style="color:#2ecc71; font-weight:bold;">Aktywna</span></p>`;
            if (fElevation !== null) popupContent += `<p><strong>Wysokość:</strong> ${fElevation} m n.p.m.</p>`;
            if (fTa !== null) popupContent += `<p><strong>Temperatura (${hourStr}:00):</strong> ${fTa}°C</p>`;
            if (hourlyPrecip !== null) popupContent += `<p><strong>Opad godzinowy:</strong> ${formatValue(hourlyPrecip, 1)} mm</p>`;
            if (fTmin !== null) popupContent += `<p><strong>Tmin (dobowe):</strong> ${fTmin}°C</p>`;
            if (fTmax !== null) popupContent += `<p><strong>Tmax (dobowe):</strong> ${fTmax}°C</p>`;
            if (fPrecip24h !== null) popupContent += `<p><strong>Opad dobowy (24h):</strong> ${fPrecip24h} mm</p>`;
            if (fWindAvg !== null) popupContent += `<p><strong>Wiatr średni:</strong> ${fWindAvg} km/h</p>`;

            const getEx = (val, field) => {
                if (val == null || isNaN(val)) return '';
                const parsed = parseFloat(val);
                const tolerance = 1e-8;
                if (extremes[field].max !== undefined && Math.abs(parsed - extremes[field].max) <= tolerance) return 'max';
                if (extremes[field].min !== undefined && Math.abs(parsed - extremes[field].min) <= tolerance) return 'min';
                return '';
            };

            if (hourlyTa !== null) {
                addDataToParamGroup(hourlyTa, '°C', 'temp-aktualna', 'etykieta-gora', latlng, popupContent, feature, etykietyTa, false, getEx(hourlyTa, 'Ta'));
            }
            addDataToParamGroup(props.Tmin, '°C', 'temp-min', 'etykieta-dol', latlng, popupContent, feature, etykietyTmin, false, getEx(props.Tmin, 'Tmin'));
            addDataToParamGroup(props.Tmin_hour, '°C', 'temp-min-hour', 'etykieta-dol', latlng, popupContent, feature, etykietyTminHour, false, getEx(props.Tmin_hour, 'Tmin_hour'));
            addDataToParamGroup(props.Tmax, '°C', 'temp-max', 'etykieta-gora', latlng, popupContent, feature, etykietyTmax, false, getEx(props.Tmax, 'Tmax'));
            addDataToParamGroup(props.Tmax_hour, '°C', 'temp-max-hour', 'etykieta-gora', latlng, popupContent, feature, etykietyTmaxHour, false, getEx(props.Tmax_hour, 'Tmax_hour'));
            addDataToParamGroup(props.Tg, '°C', 'temp-grunt', 'etykieta-gora', latlng, popupContent, feature, etykietyTg, false, getEx(props.Tg, 'Tg'));
            addDataToParamGroup(props.Precip_24h, ' mm', 'opad-dobowy', 'etykieta-gora', latlng, popupContent, feature, etykietyOpady24h, false, getEx(props.Precip_24h, 'Precip_24h'));
            
            if (hourlyPrecip !== null) {
                addDataToParamGroup(hourlyPrecip, ' mm', 'opad-10min', 'etykieta-gora', latlng, popupContent, feature, etykietyOpady10min, false, getEx(hourlyPrecip, 'Precip_10min'));
            } else {
                addDataToParamGroup(props.Precip_10min, ' mm', 'opad-10min', 'etykieta-gora', latlng, popupContent, feature, etykietyOpady10min, false, getEx(props.Precip_10min, 'Precip_10min'));
            }

            addDataToParamGroup(wAvgKmh, ' km/h', 'wiatr-avg', 'etykieta-gora', latlng, popupContent, feature, etykietyWindAvg, false, getEx(wAvgKmh, 'Wind_avg'));
            addDataToParamGroup(wMaxKmh, ' km/h', 'wiatr-max', 'etykieta-gora', latlng, popupContent, feature, etykietyWindMax, false, getEx(wMaxKmh, 'Wind_max'));
            addDataToParamGroup(props.Elevation, ' m n.p.m.', 'wysokosc', 'etykieta-gora', latlng, popupContent, feature, etykietyElevation, true, '');
            addDataToParamGroup(props.Station_name, '', 'nazwa-stacji', 'etykieta-gora', latlng, popupContent, feature, etykietyStationName, false, '');
            
            return null;
        }
    });

    const overlayMaps = {
        "Nazwa stacji (Station_name)": etykietyStationName, "Wysokość (Elevation)": etykietyElevation, "Temperatura aktualna (Ta)": etykietyTa, "Temperatura minimalna (Tmin)": etykietyTmin, "Temperatura maksymalna (Tmax)": etykietyTmax, "Temperatura min. godzinowa (Tmin_hour)": etykietyTminHour, "Temperatura max. godzinowa (Tmax_hour)": etykietyTmaxHour, "Temperatura przy gruncie (Tg)": etykietyTg, "Suma opadów (Precip_24h)": etykietyOpady24h, "Opad wybranej godziny (Precip_hour)": etykietyOpady10min, "Średni wiatr (Wind_avg)": etykietyWindAvg, "Porywy wiatru (Wind_max)": etykietyWindMax
    };

    if (!layersControl) {
        layersControl = L.control.layers(null, overlayMaps, { position: 'topleft', collapsed: false }).addTo(map);
        const root = layersControl.getContainer();
        if (root && !root.dataset.compactReady) {
            root.dataset.compactReady = 'true';
            root.classList.add('compact-panel');

            const header = document.createElement('div');
            header.className = 'panel-header';

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'panel-toggle-btn';
            toggle.title = 'Zwiń/rozwiń okno parametrów';
            toggle.setAttribute('aria-label', 'Zwiń/rozwiń okno parametrów');
            toggle.textContent = '▾';

            const title = document.createElement('div');
            title.className = 'panel-title';
            title.textContent = 'Parametry:';

            header.appendChild(toggle);
            header.appendChild(title);

            const list = root.querySelector('.leaflet-control-layers-list');
            if (list) {
                root.insertBefore(header, list);
                list.classList.add('panel-body');
            } else {
                root.insertBefore(header, root.firstChild);
            }

            toggle.addEventListener('click', () => {
                const collapsed = root.classList.toggle('collapsed');
                toggle.textContent = collapsed ? '▸' : '▾';
            });
        }

        setTimeout(() => {
            document.querySelectorAll('.leaflet-control-layers-overlays label').forEach(label => {
                if (label.innerHTML.includes('leaflet-menu-section-title')) { const cb = label.querySelector('input'); if (cb) cb.remove(); }
            });
        }, 200);
    }

    map.on('layeradd layerremove', updateLegendVisibility);
    updateLegendVisibility();
}

function showNoDataState(dateStr) {
    clearMapData();
    globalGeoJsonData = null;

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

function loadDataForDate(dateStr) {
    clearMapData();
    if (!dateStr) return;
    const path = `imgw_data/${dateStr}.geojson`;
    fetch(path).then(r => { if (!r.ok) throw new Error('no file'); return r.json(); }).then(j => {
        globalGeoJsonData = j;
        processData(j);
        const currentTimeLabel = document.getElementById('currentTimeLabel');
        const span = currentTimeLabel ? currentTimeLabel.querySelector('span') : null;
        if (span) span.style.color = '#2ecc71';
        const datePicker = document.getElementById('datePicker');
        if (datePicker) datePicker.setCustomValidity('');
    }).catch(err => {
        console.error('Could not load', path, err);
        showNoDataState(dateStr);
    });
}

const baseMapControl = L.control({ position: 'topleft' });
baseMapControl.onAdd = function() {
    const div = L.DomUtil.create('div', 'leaflet-control-layers leaflet-control-layers-expanded custom-basemap-control compact-panel');

    div.innerHTML = `
        <div class="panel-header">
            <button type="button" class="panel-toggle-btn" aria-label="Zwiń/rozwiń okno podkładu" title="Zwiń/rozwiń okno podkładu">▾</button>
            <div class="panel-title">Podkład mapy:</div>
        </div>
        <div class="basemap-body">
            <label><input type="radio" name="customBaseLayer" value="osm">Standardowy (OSM)</label>
            <label><input type="radio" name="customBaseLayer" value="esri">Satelita (Esri)</label>
            <label><input type="radio" name="customBaseLayer" value="carto">Ciemny (CartoDB)</label>
            <label><input type="radio" name="customBaseLayer" value="topo" checked>Topograficzny</label>
        </div>
        <div class="basemap-footer">
            <label for="opacitySlider">
                Przezroczystość: <span id="opacityVal" style="font-weight:bold; color:#2ecc71; margin-left:2px;">90%</span>
            </label>
            <input type="range" id="opacitySlider" min="0" max="1" step="0.1" value="0.9" style="width: 100%; display: block; margin: 0; cursor: pointer;">
        </div>
    `;

    const toggle = div.querySelector('.panel-toggle-btn');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const collapsed = div.classList.toggle('collapsed');
            toggle.textContent = collapsed ? '▸' : '▾';
        });
    }

    L.DomEvent.disableClickPropagation(div); 
    L.DomEvent.disableScrollPropagation(div);
    
    setTimeout(() => {
        const radios = div.querySelectorAll('input[name="customBaseLayer"]');
        const slider = div.querySelector('#opacitySlider');
        const valLabel = div.querySelector('#opacityVal');
        
        activeBaseLayer.setOpacity(0.9);
        
        function updateLayer(selectedVal) {
            map.removeLayer(activeBaseLayer);
            if (selectedVal === 'osm') activeBaseLayer = osmLayer;
            if (selectedVal === 'esri') activeBaseLayer = esriSatelite;
            if (selectedVal === 'carto') activeBaseLayer = cartoDbDark;
            if (selectedVal === 'topo') activeBaseLayer = openTopo;
            
            const currentOpacity = parseFloat(slider.value);
            activeBaseLayer.setOpacity(currentOpacity);
            map.addLayer(activeBaseLayer);
            activeBaseLayer.bringToBack();
        }
        
        radios.forEach(radio => {
            radio.addEventListener('change', function(e) {
                updateLayer(e.target.value);
            });
        });
        
        if (slider) {
            slider.addEventListener('input', function(e) {
                const alpha = parseFloat(e.target.value);
                if (activeBaseLayer && activeBaseLayer.setOpacity) {
                    activeBaseLayer.setOpacity(alpha);
                }
                if (valLabel) {
                    valLabel.textContent = Math.round(alpha * 100) + '%';
                }
            });
        }
    }, 100);
    
    return div;
};
baseMapControl.addTo(map);

const legendControl = L.control({ position: 'bottomleft' });
legendControl.onAdd = function() {
    const div = L.DomUtil.create('div', 'map-legend-container compact-panel');
    const reversedScale = [...tempScale].reverse();
    const stepsCount = reversedScale.length;
    const stepPercent = 100 / stepsCount;

    div.innerHTML = `
        <div class="panel-header">
            <button type="button" class="panel-toggle-btn" aria-label="Zwiń/rozwiń okno legendy" title="Zwiń/rozwiń okno legendy">▾</button>
            <div class="panel-title">Legenda:</div>
        </div>
        <div class="legend-subtitle" style="font-size:11px; color:#374151; font-weight:700; margin: 5px 0 10px 0;">Temperatura:</div>
        <div class="legend-body" style="display:flex; align-items:stretch; height: 242px;">
            <div class="legend-bar" style="
                width: 7px;
                margin-right: 6px;
                border: 1px solid #999;
                background:
                    repeating-linear-gradient(to bottom, transparent, transparent calc(${stepPercent}% - 1px), rgba(255,255,255,0.6) calc(${stepPercent}% - 1px), rgba(255,255,255,0.6) ${stepPercent}%),
                    linear-gradient(to bottom, ${reversedScale.map(i => `rgb(${i.r},${i.g},${i.b})`).join(', ')});
            "></div>
            <div class="legend-labels" style="display:flex; flex-direction:column; justify-content:space-between; gap: 0; min-width: 0;">
                ${reversedScale.map(i => `<div class="legend-label-row" style="height: calc(242px / ${stepsCount}); display:flex; align-items:center; font-size:9.1px; line-height:1; letter-spacing:-0.03em;"> <span class="legend-value" style="font-weight:400; color:#374151; opacity:0.8; display:inline-block; min-width:0; white-space:nowrap;">${i.t}°C</span></div>`).join('')}
            </div>
        </div>
    `;

    const toggle = div.querySelector('.panel-toggle-btn');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const collapsed = div.classList.toggle('collapsed');
            toggle.textContent = collapsed ? '▸' : '▾';
        });
    }

    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    return div;
};
legendControl.addTo(map);

function updateLegendVisibility() {
    const isVisible = [etykietyTa, etykietyTmin, etykietyTmax, etykietyTminHour, etykietyTmaxHour, etykietyTg].some(l => map.hasLayer(l));
    const el = document.querySelector('.map-legend-container');
    if (el) el.style.display = isVisible ? 'block' : 'none';
}

function initTimelineUI() {
    const datePicker = document.getElementById('datePicker');
    const hourSlider = document.getElementById('hourSlider');
    const ticksContainer = document.getElementById('ticksContainer');
    const currentTimeLabel = document.getElementById('currentTimeLabel');

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

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    if (hourSlider) {
        hourSlider.addEventListener('input', (e) => {
            const val = e.target.value;
            updateTimeLabel(val);
            const hourStr = String(val).padStart(2, '0');
            renderDataForHour(hourStr);
        });
    }

    if (datePicker) {
        datePicker.value = todayStr;
        loadDataForDate(todayStr);

        datePicker.addEventListener('change', () => {
            loadDataForDate(datePicker.value);
        });
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTimelineUI); else initTimelineUI();