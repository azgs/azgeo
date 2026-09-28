# Geologic Map of Arizona: web map

Interactive geologic map of Arizona from the Arizona Geological Survey (AZGS). A plain folder of static files with no map server, database, or ArcGIS Online dependency, so it can be hosted on any ordinary web server.

Repository: https://github.com/azgs/azgeo

The full maintenance guide is in `docs/`. This README is the short technical summary.


This copy contains data built from `StatewidePolarityFix.gdb`: 50 map units, 4,841 unit polygons, and 15,563 contacts and faults. To update it, rerun the conversion script on the edited geodatabase (steps below).

## What's in the folder

| Path | What it is | Edit it? |
|---|---|---|
| `index.html` | The page: header, map, Information section, legend dialogs, footer | For page text, links and headings |
| `img/azgs.png` | AZGS logo | Replace to change the logo |
| `css/styles.css` | Colors, fonts, layout | For design changes |
| `js/config.js` | Settings: data source, basemaps, starting view, line colors | Yes, this is the main settings file |
| `js/app.js` | Map, legend and identify logic | Only for new features |
| `data/mapunits.json` | Unit names, ages, descriptions, colors | Yes, generated from your geodatabase; small fixes by hand are fine |
| `data/symbology.json` | Line symbols converted from the geodatabase Symbology table | Rebuild with the script |
| `data/geology.pmtiles` | Unit polygons, contacts and faults as vector tiles | Rebuild with the script, don't edit |
| `tools/build_data.py` | Converts your geodatabase into the two data files | Edit the CONFIG block if your names differ |
| `tools/serve.py` | Local preview server | No |
| `vendor/` | MapLibre GL JS 4.7.1 and PMTiles 3.2.1, stored locally so the site never breaks because of an outside CDN | Only when upgrading |
| `web.config` | Needed only on Microsoft IIS servers | No |

## Preview it on your computer

You need Python 3 (already on most Macs, and included with ArcGIS Pro and QGIS on Windows).

```
cd path/to/site
python tools/serve.py
```

On Windows, if `python` isn't recognized, use `py tools\serve.py` instead.

Then open http://localhost:8000. Don't double-click `index.html`: browsers block map data on pages opened directly from disk.

## Put your geodatabase in

You need the GDAL command-line tools, version 3.8 or newer. On Windows, install **QGIS 3.34 or newer** and use the **OSGeo4W Shell** it adds to the Start menu; it has everything. The script doesn't need ArcGIS Pro or any admin tools.

1. Check that the script can read your geodatabase and finds the expected layers:
   ```
   python tools/build_data.py --inspect "C:\path\to\YourGeology.gdb"
   ```
   It expects GeMS names: `MapUnitPolys`, `ContactsAndFaults`, `DescriptionOfMapUnits`. If yours differ, edit the CONFIG block at the top of `tools/build_data.py`.

2. Build the data files:
   ```
   python tools/build_data.py "C:\path\to\YourGeology.gdb"
   ```
   This replaces `data/geology.pmtiles`, `data/mapunits.json`, and `data/symbology.json`. It warns you about polygons whose MapUnit has no row in DescriptionOfMapUnits, and units with no color.

3. Refresh the browser.

The statewide geodatabase takes about a minute and a half and produces a 12 MB tiles file. `max_zoom` in the CONFIG block is set to 12, which suits a statewide map at about 1:1,000,000. The map still zooms in further; it just stops adding detail. Raise it only for more detailed maps (each step roughly doubles the file size).

## Everyday edits

**Fix a unit's name, description, age or color.** Best: change DescriptionOfMapUnits in the geodatabase and rerun step 2, so the geodatabase stays the official source. Quick fix: edit `data/mapunits.json` in any text editor. Colors are written as `rgb(125,255,209)`. The legend and map colors update on refresh.

**Change legend order.** The legend follows `HierarchyKey` in DescriptionOfMapUnits (the `order` value in `mapunits.json`).

**Change how faults and contacts look.** Line symbols come from the geodatabase itself: each line's `Symbol` code (for example `002.008.001`, thrust fault) is looked up in the `Symbology` table, and the ArcGIS Pro symbol stored there is converted into `data/symbology.json`. That gives the same line weights, dash patterns, and ornaments as ArcGIS Pro: sawteeth, hachures, ticks, and ball-and-bar. So the normal way to change a line's symbol is to change its `Symbol` code in the geodatabase (or the symbol in the Symbology table) and rerun the script.

Ornaments are placed on the side the line's direction puts them, following the same rule as ArcGIS Pro. A fault whose ornaments are on the wrong side needs its line direction flipped in the geodatabase.

`lines` in `js/config.js` only adjusts the web display: `widthScale` for thicker or thinner lines, `ornamentSpacingScale` for fewer or more ornaments, the zoom levels where contacts and ornaments appear, and `labels` for custom legend wording.

**Age wording.** The script turns "Holocene-Holocene" into "Holocene" and "Pliocene-Holocene" into "Pliocene to Holocene". To show the Age field exactly as stored, set `tidy_ages` to False in the script's CONFIG block.

**Change geometry.** Edit in ArcGIS Pro, then rerun step 2.

## Testing against the current live data

In `js/config.js`, set `dataSource: "arcgis-live"`. The new interface will then load geology from the ArcGIS Online services the current site uses, with unit descriptions from the current site. This is only for comparison. Highlighting may not be available in this mode, and faults are shown as images, as on the current site.

## Hosting

Copy the whole folder to the web server. Two requirements:

- **Range requests.** The server must support HTTP range requests, which Apache, nginx, IIS, and most static hosts do by default.
- **The `.pmtiles` file type.** On IIS, the included `web.config` registers it. Otherwise IIS returns "404 not found" for the tiles.

## Not yet done in this test version

- The "Geologic Maps" layer from the AZGS Document Repository (data.azgs.arizona.edu) still needs to be wired in.
- Check the footer's "University Information Security and Privacy" link points to the right page.
- Check that the USGS basemaps display on your server. They couldn't be tested from the build environment.

## Accessibility

The site targets **WCAG 2.1 Level AA**, the standard required for state government websites by the U.S. Department of Justice's 2024 ADA Title II rule. It also meets the WCAG 2.2 AA additions. What's built in:

- Keyboard access to everything: skip links, all map controls, the layers panel, legend dialogs, and the map itself. On the map, arrow keys pan, + and − zoom, Enter identifies the unit under the center crosshair, and Escape closes the details.
- Pan buttons next to the zoom buttons, so the map can be moved without dragging (WCAG 2.2, 2.5.7).
- Screen reader announcements when a unit is identified or highlighted, and when the legend filter changes the number of units shown.
- Text alternatives for the map: the Geologic Units legend lists every unit with its name, age, and description, and every line symbol has a text label.
- Color contrast of at least 4.5:1 for text and 3:1 for form field edges, visible focus outlines, and click targets of at least 24 by 24 pixels.
- The hover box can be dismissed with Escape, and everything in it is also available by clicking or pressing Enter.
- Reduced motion is respected; map movements don't animate when the operating system asks for less motion.

An automated check with axe-core (WCAG 2.0, 2.1, and 2.2 A and AA rules) found no issues on the page, the layers panel, the popup, or any legend dialog. Automated tools catch only part of accessibility, so before launch:

- Test with a screen reader: NVDA (free) on Windows, or VoiceOver on Mac.
- Run a free checker such as WAVE (wave.webaim.org) on the hosted page.
- Coordinate with your agency's ADA or IT accessibility contact.

When editing, keep new text colors dark enough, give new images alt text, and use real buttons and links for anything clickable.

## Third-party software

The `vendor/` folder contains unmodified copies of open-source libraries, each with its license file:

- MapLibre GL JS 4.7.1, BSD 3-Clause license (`vendor/maplibre-gl-4.7.1/LICENSE.txt`)
- PMTiles 3.2.1, BSD 3-Clause license (`vendor/pmtiles-3.2.1/LICENSE`)

Basemap tiles are provided by the U.S. Geological Survey National Map and by OpenStreetMap contributors; both are credited on the map.
