/* Geologic Map of Arizona: map, legend and identify logic.
 * Settings live in js/config.js. Unit names, colors and descriptions live in data/mapunits.json. */
(function () {
  "use strict";
  const C = window.GEOMAP_CONFIG;
  const MODE = C.dataSource;
  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let units = [];
  const unitByLabel = new Map();
  let unitFillLayers = [];   // layers that draw unit polygons
  let lineLayers = [];       // layers that draw contacts and faults
  const esriLayerUnit = {};  // arcgis-live mode: style layer id -> unit label
  let selected = null;
  let unitOpacity = C.unitOpacity;
  let symbology = null;      // line symbols from data/symbology.json (built from the Symbology table)
  let lineStrokeLayers = []; // line layers used for identify (ornament layers excluded)
  const PX = 96 / 72;        // ArcGIS Pro sizes are in points; the web uses CSS pixels

  function showError(msg) {
    const el = $("map-error");
    el.innerHTML = msg;
    el.hidden = false;
  }

  if (location.protocol === "file:") {
    showError("<strong>This page must be opened through a web server.</strong> Browsers block map data when a page is opened by double-clicking the file. See README.md for a one-line way to start a local server.");
    return;
  }

  // ---------------------------------------------------------------- map setup
  const baseSources = {}, baseLayers = [];
  for (const [id, b] of Object.entries(C.basemaps)) {
    baseSources["base-" + id] = { type: "raster", tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
    baseLayers.push({ id: "base-" + id, type: "raster", source: "base-" + id, layout: { visibility: id === "usgsTopo" ? "visible" : "none" } });
  }

  const map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: baseSources, layers: baseLayers },
    bounds: C.bounds,
    fitBoundsOptions: { padding: 24 },
    maxBounds: C.maxBounds,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false
  });
  map.touchZoomRotate.disableRotation();
  window.geomap = map; // handy for troubleshooting from the browser console
  map.getCanvas().setAttribute("aria-label",
    "Geologic map. Arrow keys pan, plus and minus zoom, Enter identifies the unit at the center crosshair, Escape closes the details.");
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

  class HomeControl {
    onAdd() {
      const div = document.createElement("div");
      div.className = "maplibregl-ctrl maplibregl-ctrl-group";
      div.innerHTML = '<button type="button" class="home-btn" aria-label="Zoom to all of Arizona" title="Zoom to all of Arizona">' +
        '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M5 3h8l2 3v11H9l-4-3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>';
      div.querySelector("button").addEventListener("click", () => map.fitBounds(C.bounds, { padding: 24, animate: !reduceMotion }));
      return div;
    }
    onRemove() {}
  }
  map.addControl(new HomeControl(), "top-left");

  // Pan buttons: a way to move the map without dragging (WCAG 2.2, 2.5.7 Dragging Movements)
  class PanControl {
    onAdd() {
      const div = document.createElement("div");
      div.className = "maplibregl-ctrl maplibregl-ctrl-group pan-ctrl";
      const dirs = [["north", 0, -1, "M10 5l-5 6h10z"], ["west", -1, 0, "M5 10l6-5v10z"],
                    ["east", 1, 0, "M15 10l-6-5v10z"], ["south", 0, 1, "M10 15l-5-6h10z"]];
      for (const [name, dx, dy, d] of dirs) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pan-ctrl__" + name;
        b.setAttribute("aria-label", "Pan map " + name);
        b.title = "Pan " + name;
        b.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
        b.addEventListener("click", () => {
          const c = map.getContainer();
          map.panBy([dx * c.clientWidth * 0.3, dy * c.clientHeight * 0.3], { animate: !reduceMotion });
        });
        div.appendChild(b);
      }
      return div;
    }
    onRemove() {}
  }
  map.addControl(new PanControl(), "top-left");

  // Layers button (top right), like the original site's layer switcher
  class LayersControl {
    onAdd() {
      const div = document.createElement("div");
      div.className = "maplibregl-ctrl maplibregl-ctrl-group layers-ctrl";
      div.appendChild(document.getElementById("layers-template").content.cloneNode(true));
      const btn = div.querySelector(".layers-ctrl__toggle"), panel = div.querySelector(".layers-ctrl__panel");
      const setOpen = (open) => { panel.hidden = !open; btn.setAttribute("aria-expanded", String(open)); div.classList.toggle("is-open", open); };
      btn.addEventListener("click", () => setOpen(panel.hidden));
      document.addEventListener("click", (e) => { if (!div.contains(e.target)) setOpen(false); });
      div.addEventListener("keydown", (e) => { if (e.key === "Escape") { setOpen(false); btn.focus(); } });
      return div;
    }
    onRemove() {}
  }
  map.addControl(new LayersControl(), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
  const popup = new maplibregl.Popup({ maxWidth: "340px", focusAfterOpen: false, className: "unit-popup" });
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  // ---------------------------------------------------------------- unit data
  function indexUnits(list) {
    units = list;
    unitByLabel.clear();
    units.forEach((u) => unitByLabel.set(String(u.mapunit), u));
  }

  async function loadUnitsPmtiles() {
    const r = await fetch(C.pmtiles.units, { cache: "no-cache" });
    if (!r.ok) throw new Error(`Couldn't load ${C.pmtiles.units} (${r.status}).`);
    const json = await r.json();
    indexUnits(json.units || []);
    try {
      const r2 = await fetch(C.pmtiles.symbology, { cache: "no-cache" });
      if (r2.ok) symbology = await r2.json();
    } catch (e) { symbology = null; }
    if (json.notice) $("data-status").insertAdjacentHTML("beforeend", `<strong>${esc(json.notice)}</strong> `);
  }

  function loadUnitsArcgis() {
    // The live site keeps unit info in a script that defines window.MupsJson.
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = C["arcgis-live"].unitsScript;
      s.onload = () => {
        const raw = Object.values(window.MupsJson || {});
        const list = raw.map((u) => ({
          mapunit: u.mapunit, name: u.name, fullName: u.nameDMU, age: u.age,
          description: u.description, rgb: u.rgb, b_age: u.b_age, t_age: u.t_age
        }));
        list.sort((a, b) => (a.b_age ?? 1e9) - (b.b_age ?? 1e9) || (a.t_age ?? 0) - (b.t_age ?? 0));
        indexUnits(list);
        resolve();
      };
      s.onerror = () => { indexUnits([]); resolve(); };
      document.head.appendChild(s);
    });
  }

  // ---------------------------------------------------------------- layers: pmtiles
  function addPmtilesLayers() {
    const P = C.pmtiles, L = C.lines;
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
    map.addSource("geology", {
      type: "vector",
      url: "pmtiles://" + new URL(P.tiles, location.href).href,
      attribution: "Arizona Geological Survey"
    });

    const pairs = [];
    units.forEach((u) => pairs.push(String(u.mapunit), u.rgb));
    const color = pairs.length ? ["match", ["to-string", ["get", P.unitField]], ...pairs, "#dcdcdc"] : "#dcdcdc";

    map.addLayer({ id: "units-fill", type: "fill", source: "geology", "source-layer": P.unitsLayer,
      paint: { "fill-color": color, "fill-opacity": unitOpacity } });
    map.addLayer({ id: "units-selected", type: "line", source: "geology", "source-layer": P.unitsLayer,
      filter: ["==", ["get", P.unitField], "__none__"],
      paint: { "line-color": "#0C234B", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 12, 2.5] } });
    unitFillLayers = ["units-fill"];

    const S = (symbology && symbology.symbols) || {};
    const field = L.symbolField;
    const code = ["to-string", ["get", field]];
    const keys = Object.keys(S).sort();          // 001 contacts first, 002 faults drawn on top
    const minzoomFor = (key) => L.minzoomByCode[key.split(".")[0]] ?? 0;
    const add = (layer, isStroke) => {
      map.addLayer(layer, "units-selected");
      lineLayers.push(layer.id);
      if (isStroke) lineStrokeLayers.push(layer.id);
    };

    // Lines whose Symbol code isn't in the Symbology table
    add({ id: "line-fallback", type: "line", source: "geology", "source-layer": P.linesLayer,
      filter: keys.length ? ["!", ["in", code, ["literal", keys]]] : true,
      paint: { "line-color": L.fallback.color, "line-width": L.fallback.width } }, true);

    for (const key of keys) {
      S[key].layers.forEach((ly, i) => {
        const id = `line-${key}-${i}`;
        const filter = ["==", code, key];
        if (ly.type === "stroke") {
          const paint = { "line-color": ly.color, "line-opacity": ly.opacity ?? 1,
            "line-width": Math.max(0.4, ly.width * PX * L.widthScale) };
          // MapLibre dash lengths are multiples of the line width
          if (ly.dash) paint["line-dasharray"] = ly.dash.map((d) => Math.max(d / ly.width, 0.01));
          add({ id, type: "line", source: "geology", "source-layer": P.linesLayer, filter, paint,
            minzoom: minzoomFor(key), layout: { "line-cap": "butt", "line-join": "round" } }, true);
        } else if (ly.type === "marker" && ly.graphics.length) {
          map.addImage(id, markerImage(ly), { pixelRatio: 2 });
          add({ id, type: "symbol", source: "geology", "source-layer": P.linesLayer, filter,
            minzoom: Math.max(minzoomFor(key), L.ornamentMinzoom),
            layout: {
              // "center" ornaments (ball-and-bar) repeat at singleOrnamentSpacing unless it's 0.
              // Lines shorter than the spacing still get one ornament at their middle.
              "symbol-placement": ly.placement === "center" && !L.singleOrnamentSpacing ? "line-center" : "line",
              "symbol-spacing": Math.max(1, (ly.placement === "center" ? L.singleOrnamentSpacing
                : (ly.interval || 40) * PX) * L.ornamentSpacingScale),
              "icon-image": id,
              // Keep ornaments turned with the line, never flipped, so they stay on the side
              // the line direction puts them (the same rule ArcGIS Pro uses).
              "icon-rotation-alignment": "map", "icon-pitch-alignment": "map", "icon-keep-upright": false,
              "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-padding": 0
            } }, false);
        }
      });
    }
  }

  // Draws one ornament (sawtooth, hachure, tick, ball-and-bar) into an image, centered on the
  // point where it touches the line. Coordinates are points; +y is the right side of the line.
  function markerImage(m) {
    const r = 2, [x0, y0, x1, y1] = m.bbox;
    const hw = Math.max(Math.abs(x0), Math.abs(x1)) * PX + 1, hh = Math.max(Math.abs(y0), Math.abs(y1)) * PX + 1;
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(hw * 2 * r); cv.height = Math.ceil(hh * 2 * r);
    const ctx = cv.getContext("2d");
    ctx.translate(cv.width / 2, cv.height / 2);
    ctx.scale(PX * r, PX * r);
    for (const g of m.graphics) {
      const path = new Path2D(g.d);
      if (g.fill) { ctx.fillStyle = g.fill; ctx.fill(path); }
      if (g.stroke) { ctx.strokeStyle = g.stroke; ctx.lineWidth = g.strokeWidth || 1; ctx.stroke(path); }
    }
    return ctx.getImageData(0, 0, cv.width, cv.height);
  }

  // ---------------------------------------------------------------- layers: arcgis-live
  async function addArcgisLayers() {
    const A = C["arcgis-live"];
    const svc = A.unitsVectorTiles.replace(/\/$/, "");
    const [meta, esriStyle] = await Promise.all([
      fetch(svc + "?f=json").then((r) => r.json()),
      fetch(svc + "/resources/styles/root.json").then((r) => r.json())
    ]);
    const tilePath = (meta.tiles && meta.tiles[0]) || "tile/{z}/{y}/{x}.pbf";
    const maxzoom = meta.maxzoom ?? meta.maxLOD ?? (meta.tileInfo && meta.tileInfo.lods ? meta.tileInfo.lods.length - 1 : 15);
    map.addSource("geology-esri", { type: "vector", tiles: [svc + "/" + tilePath], maxzoom: Math.min(maxzoom, 16),
      attribution: "Arizona Geological Survey" });

    for (const l of esriStyle.layers || []) {
      if (l.type !== "fill" && l.type !== "line") continue;
      const layer = { id: "esri:" + l.id, type: l.type, source: "geology-esri", "source-layer": l["source-layer"],
        paint: { ...(l.paint || {}) }, layout: { ...(l.layout || {}) } };
      if (l.filter) layer.filter = l.filter;
      if (l.minzoom != null) layer.minzoom = l.minzoom;
      if (l.maxzoom != null) layer.maxzoom = l.maxzoom;
      if (layer.paint["fill-pattern"]) { delete layer.paint["fill-pattern"]; layer.paint["fill-color"] = layer.paint["fill-color"] || "#dcdcdc"; }
      if (l.type === "fill") layer.paint["fill-opacity"] = unitOpacity;
      map.addLayer(layer);
      const seg = String(l.id).split("/").find((s) => unitByLabel.has(s.trim()));
      esriLayerUnit[layer.id] = seg ? seg.trim() : null;
      if (l.type === "fill") unitFillLayers.push(layer.id);
    }

    map.addSource("lines-raster", { type: "raster", tiles: [A.linesRasterTiles], tileSize: 256, maxzoom: 16,
      attribution: "Arizona Geological Survey" });
    map.addLayer({ id: "lines-raster", type: "raster", source: "lines-raster" });
    lineLayers = ["lines-raster"];
  }

  // ---------------------------------------------------------------- identify
  function unitOf(f) {
    if (MODE === "pmtiles") return f.properties[C.pmtiles.unitField];
    for (const k of C["arcgis-live"].unitFieldCandidates) if (f.properties[k] != null) return f.properties[k];
    return esriLayerUnit[f.layer.id];
  }

  function identify(lngLat, fromKeyboard = false) {
    const pt = map.project(lngLat);
    const box = [[pt.x - 4, pt.y - 4], [pt.x + 4, pt.y + 4]];
    const visibleFills = unitFillLayers.filter((id) => map.getLayoutProperty(id, "visibility") !== "none");
    const fills = map.queryRenderedFeatures(pt, { layers: visibleFills });
    const vectorLines = MODE === "pmtiles" && $("lyr-lines").checked ? lineStrokeLayers : [];
    const lines = vectorLines.length ? map.queryRenderedFeatures(box, { layers: vectorLines }) : [];
    const label = fills.length ? unitOf(fills[0]) : null;
    const u = label != null ? unitByLabel.get(String(label)) : null;

    let html = "";
    if (u) {
      html += `<div class="card">
        <span class="card__swatch" style="background:${esc(u.rgb)}"></span>
        <div><h2 class="card__title">${esc(u.name || u.mapunit)}</h2>
        <p class="card__meta">Map unit ${esc(u.mapunit)}${u.age ? ", " + esc(u.age) : ""}</p></div></div>
        ${u.description ? `<p class="card__desc">${esc(u.description)}</p>` : ""}
        <button type="button" class="text-btn" data-highlight="${esc(u.mapunit)}">${selected === String(u.mapunit) ? "Show all units" : "Highlight this unit on the map"}</button>`;
    } else if (label != null) {
      html += `<h2 class="card__title">Map unit ${esc(label)}</h2><p class="card__desc">No description is available for this unit.</p>`;
    } else if (fills.length) {
      html += `<p class="card__desc">A geologic unit is mapped here, but its label isn't included in the map service.</p>`;
    } else {
      html += `<p class="card__desc">No geologic unit is mapped at this spot. Geology is shown for Arizona only.</p>`;
    }
    const f0 = lines[0];
    if (f0) {
      const key = String(f0.properties[C.lines.symbolField] ?? "");
      const sym = symbology && symbology.symbols[key];
      const label = C.lines.labels[key] || (sym ? sym.label : f0.properties[C.lines.typeField] || "Line");
      html += `<p class="card__line"><strong>Nearby line:</strong> ${esc(label)}${sym && sym.note ? ". " + esc(sym.note) : ""}</p>`;
    }
    html += `<p class="card__coords">${lngLat.lat.toFixed(4)}° N, ${Math.abs(lngLat.lng).toFixed(4)}° W</p>`;

    popup.setLngLat(lngLat).setHTML(`<div class="popup-card" role="group" aria-label="Map location details">${html}</div>`).addTo(map);
    hideHover();
    // Keyboard users go into the popup; Escape brings them back to the map.
    if (fromKeyboard) {
      const btn = popup.getElement().querySelector("[data-highlight]") || popup.getElement().querySelector(".maplibregl-popup-close-button");
      if (btn) btn.focus();
    }
    $("sr-live").textContent = u ? `${u.name || u.mapunit}, map unit ${u.mapunit}${u.age ? ", " + u.age : ""}.` : "No geologic unit mapped here.";
  }

  // "Highlight this unit" button inside the popup
  map.getContainer().addEventListener("click", (e) => {
    const h = e.target.closest(".unit-popup [data-highlight]");
    if (!h) return;
    const label = h.dataset.highlight;
    selectUnit(selected === label ? null : label);
    h.textContent = selected === label ? "Show all units" : "Highlight this unit on the map";
  });

  // ---------------------------------------------------------------- highlight
  function applyUnitStyle() {
    if (MODE === "pmtiles") {
      const f = C.pmtiles.unitField;
      map.setPaintProperty("units-fill", "fill-opacity", selected
        ? ["case", ["==", ["to-string", ["get", f]], selected], Math.max(unitOpacity, 0.9), unitOpacity * 0.15]
        : unitOpacity);
      map.setFilter("units-selected", ["==", ["to-string", ["get", f]], selected ?? "__none__"]);
    } else {
      for (const id of unitFillLayers) {
        const match = esriLayerUnit[id] === selected;
        map.setPaintProperty(id, "fill-opacity", !selected ? unitOpacity : match ? Math.max(unitOpacity, 0.9) : unitOpacity * 0.15);
      }
    }
  }

  function selectUnit(label) {
    selected = label;
    document.querySelectorAll("#legend .show-btn").forEach((b) => {
      const on = b.dataset.unit === label;
      b.setAttribute("aria-pressed", String(on));
    });
    const u = label ? unitByLabel.get(label) : null;
    $("highlight-chip").hidden = !label;
    if (label) {
      $("highlight-name").textContent = u ? `${u.name || label} (${label})` : label;
      document.querySelector(".highlight-chip__swatch").style.background = u ? u.rgb : "transparent";
    }
    $("sr-live").textContent = label ? `Highlighting ${u ? u.name || label : label} on the map.` : "Showing all units.";
    applyUnitStyle();
  }
  $("highlight-clear").addEventListener("click", () => selectUnit(null));

  // ---------------------------------------------------------------- legend
  function buildLegend() {
    const tbody = $("legend");
    if (!units.length) {
      tbody.innerHTML = "";
      $("legend-empty").textContent = "Unit descriptions couldn't be loaded, so the legend is empty.";
      $("legend-empty").hidden = false;
      return;
    }
    const canHighlight = MODE === "pmtiles" || Object.values(esriLayerUnit).some(Boolean);
    tbody.innerHTML = units.map((u) => `<tr>
      <td><span class="unit-table__swatch" style="background:${esc(u.rgb)}"></span></td>
      <td class="unit-table__label">${esc(u.mapunit)}</td>
      <td><span class="unit-table__name">${esc(u.name || u.mapunit)}</span>${u.description ? `<span class="unit-table__desc">${esc(u.description)}</span>` : ""}</td>
      <td class="unit-table__age">${esc(u.age || "")}</td>
      <td>${canHighlight ? `<button type="button" class="show-btn" data-unit="${esc(u.mapunit)}" aria-pressed="false">Show on map</button>` : ""}</td>
    </tr>`).join("");
    tbody.addEventListener("click", (e) => {
      const b = e.target.closest(".show-btn");
      if (!b) return;
      const turningOn = selected !== b.dataset.unit;
      selectUnit(turningOn ? b.dataset.unit : null);
      if (turningOn) {                          // go straight to the map to see it
        $("dlg-units").close();
        const mapEl = $("map");
        mapEl.setAttribute("tabindex", "-1");
        mapEl.focus({ preventScroll: true });
        document.querySelector(".map-frame").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }
    });
    if (!canHighlight) $("units-hint").textContent =
      "Youngest at top. Highlighting isn't available with the live ArcGIS service; it works with the PMTiles data.";
  }

  $("legend-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll("#legend tr").forEach((tr, i) => {
      const u = units[i];
      const hit = !q || [u.mapunit, u.name, u.fullName, u.age, u.description].some((v) => String(v ?? "").toLowerCase().includes(q));
      tr.hidden = !hit;
      if (hit) shown++;
    });
    $("legend-empty").textContent = "No units match that filter.";
    $("legend-empty").hidden = shown > 0;
    $("legend-count").textContent = q ? `${shown} of ${units.length} units shown.` : "";
  });

  // Legend dialogs
  document.querySelectorAll("[data-open]").forEach((btn) => btn.addEventListener("click", () => {
    const dlg = $(btn.dataset.open);
    dlg.showModal();
    dlg.dataset.opener = btn.dataset.open;
  }));
  document.querySelectorAll("dialog.dlg").forEach((dlg) => {
    dlg.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]") || e.target === dlg) dlg.close();  // close button or backdrop
    });
  });

  // Legend swatch drawn from the same symbol definition as the map
  function lineSwatch(sym) {
    const W = 64, L = C.lines;
    const markers = sym.layers.filter((l) => l.type === "marker");
    const above = Math.max(1, ...markers.map((m) => -m.bbox[1] * PX));
    const below = Math.max(1, ...markers.map((m) => m.bbox[3] * PX));
    const y = above + 2, H = Math.ceil(y + below + 2);
    let body = "";
    for (const ly of sym.layers) {
      if (ly.type === "stroke") {
        const w = Math.max(0.4, ly.width * PX * L.widthScale);
        const dash = ly.dash ? ` stroke-dasharray="${ly.dash.map((d) => (d * PX * L.widthScale).toFixed(2)).join(" ")}"` : "";
        body += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${ly.color}" stroke-width="${w}"${dash}/>`;
      } else {
        const xs = ly.placement === "center" ? [W / 2] : [W * 0.3, W * 0.72];
        for (const x of xs) for (const g of ly.graphics)
          body += `<path transform="translate(${x} ${y}) scale(${PX})" d="${g.d}" fill="${g.fill || "none"}"${g.stroke ? ` stroke="${g.stroke}" stroke-width="${g.strokeWidth || 1}"` : ""}/>`;
      }
    }
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${body}</svg>`;
  }

  function buildLineLegend() {
    const S = (symbology && symbology.symbols) || {};
    // Faults first, then contacts
    const keys = Object.keys(S).sort((a, b) => (b.startsWith("002") - a.startsWith("002")) || a.localeCompare(b));
    const rows = keys.map((k) => {
      const sym = S[k], label = C.lines.labels[k] || sym.label;
      return `<li>${lineSwatch(sym)}<span>${esc(label)}${sym.note ? `<small>${esc(sym.note)}</small>` : ""}</span></li>`;
    });
    if (!rows.length) rows.push(`<li><svg width="64" height="8" aria-hidden="true"><line x1="0" y1="4" x2="64" y2="4" stroke="${C.lines.fallback.color}" stroke-width="${C.lines.fallback.width}"/></svg><span>Contact or fault</span></li>`);
    $("line-legend").innerHTML = rows.join("");
    if (MODE === "pmtiles") $("line-legend").insertAdjacentHTML("afterend",
      '<p class="hint lines-note">Contacts and fault symbols such as sawteeth and ticks appear as you zoom in.</p>');
  }

  // ---------------------------------------------------------------- controls
  const setVis = (ids, on) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
  $("lyr-units").addEventListener("change", (e) => {
    setVis(unitFillLayers, e.target.checked);
    setVis(["units-selected"], e.target.checked);
    if (MODE !== "pmtiles") setVis(Object.keys(esriLayerUnit).filter((id) => !unitFillLayers.includes(id)), e.target.checked);
  });
  $("lyr-lines").addEventListener("change", (e) => setVis(lineLayers, e.target.checked));
  $("op-units").addEventListener("input", (e) => {
    unitOpacity = e.target.value / 100;
    $("op-units-val").textContent = e.target.value + "%";
    applyUnitStyle();
  });
  document.querySelectorAll('input[name="basemap"]').forEach((r) => r.addEventListener("change", () => {
    for (const id of Object.keys(C.basemaps)) map.setLayoutProperty("base-" + id, "visibility", r.value === id && r.checked ? "visible" : "none");
  }));

  // Keyboard identify: Enter while the map has focus identifies the unit under the center crosshair.
  map.getCanvas().addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); identify(map.getCenter(), true); }
  });
  map.on("click", (e) => identify(e.lngLat));

  // Escape dismisses the hover box and the popup (WCAG 1.4.13 Content on Hover or Focus)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
    hideHover();
    if (popup.isOpen()) {
      const inside = popup.getElement().contains(document.activeElement);
      popup.remove();
      if (inside) map.getCanvas().focus();
    }
  });
  // Hover box: follows the mouse and names the unit (and any line) under it.
  // Only on devices with a mouse; on touch screens, tapping shows the details instead.
  const hoverBox = $("hover-box");
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  let hoverFrame = null, lastHover = "";
  function hideHover() { hoverBox.hidden = true; lastHover = ""; }

  function updateHover(point) {
    const visibleFills = unitFillLayers.filter((id) => map.getLayoutProperty(id, "visibility") !== "none");
    const fills = visibleFills.length ? map.queryRenderedFeatures(point, { layers: visibleFills }) : [];
    const box = [[point.x - 4, point.y - 4], [point.x + 4, point.y + 4]];
    const strokes = MODE === "pmtiles" && $("lyr-lines").checked ? lineStrokeLayers : [];
    const lines = strokes.length ? map.queryRenderedFeatures(box, { layers: strokes }) : [];
    map.getCanvas().style.cursor = fills.length || lines.length ? "pointer" : "";
    if (!canHover) return;

    let html = "";
    const label = fills.length ? unitOf(fills[0]) : null;
    const u = label != null ? unitByLabel.get(String(label)) : null;
    if (u) {
      html += `<div class="hover-box__unit"><span class="hover-box__swatch" style="background:${esc(u.rgb)}"></span>
        <span><strong>${esc(u.name || u.mapunit)}</strong><span class="hover-box__meta">${esc(u.mapunit)}${u.age ? ", " + esc(u.age) : ""}</span></span></div>`;
    } else if (label != null) {
      html += `<div class="hover-box__unit"><span><strong>Map unit ${esc(label)}</strong></span></div>`;
    }
    // Prefer a fault over a contact when both are under the cursor
    const f = lines.find((l) => String(l.properties[C.lines.symbolField] || "").startsWith("002")) || lines[0];
    if (f) {
      const key = String(f.properties[C.lines.symbolField] ?? "");
      const sym = symbology && symbology.symbols[key];
      const text = C.lines.labels[key] || (sym ? sym.label : f.properties[C.lines.typeField] || "Line");
      const swatch = sym ? lineSwatch(sym).replace('width="64"', 'width="40"') : "";
      html += `<div class="hover-box__line">${swatch}<span>${esc(text)}</span></div>`;
    }
    if (!html) { hideHover(); return; }
    if (html !== lastHover) { hoverBox.innerHTML = html; lastHover = html; }
    hoverBox.hidden = false;

    // Place beside the cursor, flipping sides near the map edges
    const wrap = map.getContainer().getBoundingClientRect();
    const bw = hoverBox.offsetWidth, bh = hoverBox.offsetHeight;
    let x = point.x + 16, y = point.y + 16;
    if (x + bw > wrap.width - 8) x = point.x - bw - 16;
    if (y + bh > wrap.height - 8) y = point.y - bh - 16;
    hoverBox.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }

  map.on("mousemove", (e) => {
    if (hoverFrame) cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => updateHover(e.point));
  });
  map.getCanvas().addEventListener("mouseleave", hideHover);
  map.on("dragstart", hideHover);
  map.on("zoomstart", hideHover);

  let reported = false;
  map.on("error", (e) => {
    const src = e.sourceId || (e.source && e.source.id) || "";
    if (reported || src.startsWith("base-")) return;
    if (src === "geology") {
      reported = true;
      showError(`<strong>The geology tiles didn't load.</strong> Check that <code>${esc(C.pmtiles.tiles)}</code> exists (run tools/build_data.py) and that the web server supports range requests. See README.md.`);
    }
  });

  // ---------------------------------------------------------------- start
  // Start as soon as the style is ready, without waiting for basemap tiles, so a slow
  // basemap server never delays the geology.
  let started = false;
  async function start() {
    if (started) return;
    started = true;
    try {
      if (MODE === "pmtiles") {
        await loadUnitsPmtiles();
        addPmtilesLayers();
        $("data-status").insertAdjacentText("beforeend", "Data is served from this website's own files.");
      } else {
        await loadUnitsArcgis();
        await addArcgisLayers();
        $("data-status").insertAdjacentText("beforeend", "Testing mode: data is loaded from the live ArcGIS Online services.");
      }
    } catch (err) {
      console.error(err);
      showError(`<strong>The map data couldn't be loaded.</strong> ${esc(err.message)}`);
    }
    buildLegend();
    buildLineLegend();
  }
  if (map.isStyleLoaded()) start(); else map.once("style.load", start);
  map.once("load", start);
})();
