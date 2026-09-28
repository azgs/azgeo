/*
 * Site settings. This is the only JavaScript file most edits should need.
 *
 * dataSource:
 *   "pmtiles"     Use the files in data/ built by tools/build_data.py from your geodatabase.
 *                 This is the target setup: everything is served from your own web server.
 *   "arcgis-live" Use the ArcGIS Online services the current site uses. Handy for testing the
 *                 new interface before your data is converted. Needs internet access.
 */
window.GEOMAP_CONFIG = {
  dataSource: "pmtiles",

  pmtiles: {
    tiles: "data/geology.pmtiles",     // built by tools/build_data.py
    units: "data/mapunits.json",       // built by tools/build_data.py; safe to edit by hand
    symbology: "data/symbology.json",  // line symbols, built from the geodatabase Symbology table
    unitsLayer: "mapunits",
    linesLayer: "contacts_faults",
    unitField: "MapUnit"
  },

  "arcgis-live": {
    unitsVectorTiles: "https://vectortileservices1.arcgis.com/Ezk9fcjSUkeadg6u/arcgis/rest/services/MapUnitPolysFixedDMU/VectorTileServer",
    linesRasterTiles: "https://tiles.arcgis.com/tiles/Ezk9fcjSUkeadg6u/arcgis/rest/services/ContactsAndFaultsFixedDMU/MapServer/tile/{z}/{y}/{x}",
    // The current site's unit descriptions, loaded so popups and the legend have content during testing.
    unitsScript: "https://geomapaz.azgs.arizona.edu/js/MupJson.js",
    unitFieldCandidates: ["MapUnit", "mapunit", "MAPUNIT", "Mapunit"]
  },

  // Starting view: all of Arizona
  bounds: [[-114.9, 31.2], [-108.9, 37.1]],
  maxBounds: [[-125, 25], [-100, 43]],

  unitOpacity: 0.75,

  basemaps: {
    usgsTopo: {
      tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"],
      attribution: "U.S. Geological Survey", maxzoom: 16
    },
    usgsImagery: {
      tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}"],
      attribution: "U.S. Geological Survey", maxzoom: 16
    },
    usgsRelief: {
      tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}"],
      attribution: "U.S. Geological Survey", maxzoom: 16
    },
    osm: {
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors", maxzoom: 19
    }
  },

  // Lines are drawn from data/symbology.json, which tools/build_data.py builds from the
  // Symbology table in the geodatabase (the same symbols ArcGIS Pro uses). These settings
  // only adjust how that symbology is shown on the web.
  lines: {
    symbolField: "Symbol",               // FGDC code on each line, e.g. "002.008.001"
    typeField: "Type",
    widthScale: 1,                       // 1 = same line widths as ArcGIS Pro; 1.3 = 30% thicker
    ornamentSpacingScale: 1,             // 1 = ArcGIS Pro spacing of sawteeth, ticks, etc.; 2 = half as many
    ornamentMinzoom: 8,                  // ornaments appear from this zoom (fewer clutters the state view)
    // Ornaments ArcGIS Pro places only once per line (ball-and-bar on normal faults) repeat
    // every this many pixels instead. Smaller = more frequent. 0 = once per line, as in ArcGIS Pro.
    singleOrnamentSpacing: 80,
    // Zoom level where lines start showing, by the first part of the FGDC code
    // (001 = contacts, 002 = faults). Codes not listed show at all zooms.
    minzoomByCode: { "001": 6, "002": 0 },
    // Optional legend wording, by FGDC code. Otherwise the wording comes from the Symbology table.
    // Example: "002.001.001": "Fault, sense of slip unknown"
    labels: {},
    // Used only for lines whose Symbol code isn't in the Symbology table
    fallback: { color: "#333333", width: 1 }
  }
};
