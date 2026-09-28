#!/usr/bin/env python3
"""
Build the website's data files from a GeMS-style file geodatabase.

    python build_data.py --inspect  path/to/Geology.gdb      # list layers and fields
    python build_data.py            path/to/Geology.gdb      # build data/ for the site

Outputs (written to ../data by default):
    geology.pmtiles   vector tiles with two layers: "mapunits" and "contacts_faults"
    mapunits.json     unit names, ages, descriptions and colors, from DescriptionOfMapUnits
    symbology.json    line symbols (strokes, dashes, ornaments) from the Symbology table

Requirements: Python 3.8+ and the GDAL command-line tools, version 3.8 or newer
(ogr2ogr and ogrinfo). The easiest source on Windows is QGIS 3.34 or newer:
run this script from the "OSGeo4W Shell" that installs with QGIS.
Nothing else needs to be installed; the script uses only the Python standard library.

If your geodatabase uses different layer or field names, edit the CONFIG block below.
"""
import argparse, json, math, os, re, shutil, subprocess, sys, tempfile

# ----------------------------------------------------------------------------- CONFIG
CONFIG = {
    # Layer names inside the geodatabase (a feature dataset path like "GeologicMap/MapUnitPolys" is not needed;
    # GDAL finds feature classes by name).
    "polys_layer": "MapUnitPolys",
    "lines_layer": "ContactsAndFaults",
    "dmu_table":   "DescriptionOfMapUnits",
    "symbology_table": "Symbology",   # GeMS-style table of ArcGIS Pro (CIM) symbols, keyed by FGDC code

    # Fields copied into the web tiles. Keep this short: every field makes the tiles bigger.
    "polys_fields": ["MapUnit"],
    "lines_fields": ["Symbol", "Type", "IsConcealed", "ExistenceConfidence", "LocationConfidenceMeters"],

    # Fields read from DescriptionOfMapUnits. Set any to None if your table doesn't have it.
    "dmu_fields": {
        "mapunit":     "MapUnit",
        "name":        "Name",
        "fullName":    "FullName",
        "age":         "Age",
        "description": "Description",
        "rgb":         "AreaFillRGB",     # GeMS style "255;255;190"; "255,255,190" also works
        "order":       "HierarchyKey",    # controls legend order
        "label":       "Label",
    },

    # Zoom range for the tiles. 5 = whole state, 14 = street-level detail. The map can still
    # zoom in past max_zoom; it just stops adding detail. Higher = larger file.
    "min_zoom": 5,
    "max_zoom": 12,        # 12 suits statewide ~1:1,000,000 data; raise for more detailed maps
    "lines_min_zoom": 5,   # lines are stored from this zoom; the site decides when each type appears

    # Ages like "Holocene-Holocene" become "Holocene" and "Pliocene-Holocene" becomes
    # "Pliocene to Holocene" on the website. Set to False to show the Age field exactly as stored.
    "tidy_ages": True,

    # ExistenceConfidence values drawn as dashed lines. Everything else is drawn solid.
    "questionable_values": ["questionable", "low confidence", "low"],
}
# -----------------------------------------------------------------------------------


def run(cmd):
    print("  $", " ".join(f'"{c}"' if " " in c else c for c in cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"\nCommand failed:\n{r.stderr.strip()}")
    return r.stdout


def check_gdal():
    if not shutil.which("ogr2ogr"):
        sys.exit("ogr2ogr was not found. On Windows, run this script from the OSGeo4W Shell that comes with QGIS.")
    ver = run(["ogrinfo", "--version"])
    m = re.search(r"GDAL (\d+)\.(\d+)", ver)
    if m and (int(m[1]), int(m[2])) < (3, 8):
        sys.exit(f"{ver.strip()} is too old. GDAL 3.8 or newer is needed to write PMTiles (QGIS 3.34+ includes it).")
    if "PMTiles" not in run(["ogrinfo", "--formats"]):
        sys.exit("This GDAL build has no PMTiles driver. Install QGIS 3.34+ or GDAL 3.8+.")


def inspect(gdb):
    print(run(["ogrinfo", "-ro", "-so", gdb]))
    for layer in (CONFIG["polys_layer"], CONFIG["lines_layer"], CONFIG["dmu_table"]):
        print(f"--- {layer}")
        r = subprocess.run(["ogrinfo", "-ro", "-so", gdb, layer], capture_output=True, text=True)
        print(r.stdout if r.returncode == 0 else f"  not found (edit CONFIG if it has another name)\n")


def parse_rgb(value):
    nums = re.findall(r"\d+(?:\.\d+)?", value or "")
    if len(nums) < 3:
        return None
    r, g, b = (max(0, min(255, round(float(n)))) for n in nums[:3])
    return f"rgb({r},{g},{b})"


def tidy_age(age):
    if not age or not CONFIG["tidy_ages"]:
        return age
    parts = [p.strip() for p in age.split("-")]
    if len(parts) != 2 or not all(parts):
        return age
    older, younger = parts
    return older if older.lower() == younger.lower() else f"{older} to {younger}"


def line_summary(gdb):
    """Which line types and styles occur, so the legend lists only what's on the map."""
    L = CONFIG["lines_layer"]
    raw = run(["ogr2ogr", "-f", "GeoJSON", "/vsistdout/", gdb, "-dialect", "SQLite", "-sql",
               f"SELECT Type, IsConcealed, ExistenceConfidence, COUNT(*) AS n FROM {L} GROUP BY 1, 2, 3"])
    rows = [f["properties"] for f in json.loads(raw)["features"]]
    q = [v.lower() for v in CONFIG["questionable_values"]]
    types = {}
    for r in rows:
        t = (r.get("Type") or "unspecified").strip()
        d = types.setdefault(t, {"type": t, "count": 0, "concealed": False, "questionable": False})
        d["count"] += r["n"]
        d["concealed"] |= str(r.get("IsConcealed") or "").upper() == "Y"
        d["questionable"] |= str(r.get("ExistenceConfidence") or "").strip().lower() in q
    out = sorted(types.values(), key=lambda d: -d["count"])
    for d in out:
        extra = [k for k in ("concealed", "questionable") if d[k]]
        print(f"  {d['type']}: {d['count']} lines" + (f" (some {', '.join(extra)})" if extra else ""))
    return out


def build_mapunits(gdb, out_path, lines):
    raw = run(["ogr2ogr", "-f", "GeoJSON", "/vsistdout/", gdb, CONFIG["dmu_table"]])
    rows = [f["properties"] for f in json.loads(raw)["features"]]
    fmap = {k: v for k, v in CONFIG["dmu_fields"].items() if v}
    units, headings, missing_color = [], 0, []
    for row in rows:
        rec = {k: (row.get(src) if row.get(src) not in ("", None) else None) for k, src in fmap.items()}
        if not rec.get("mapunit"):          # heading rows in a DMU have no MapUnit
            headings += 1
            continue
        rec["age"] = tidy_age(rec.get("age"))
        rec["rgb"] = parse_rgb(rec.get("rgb"))
        if not rec["rgb"]:
            missing_color.append(rec["mapunit"])
            rec["rgb"] = "rgb(220,220,220)"
        units.append({k: v for k, v in rec.items() if v is not None})
    units.sort(key=lambda u: (str(u.get("order", "")), u["mapunit"]))
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"units": units, "lines": {"types": lines, "questionableValues": CONFIG["questionable_values"]}},
                  f, ensure_ascii=False, indent=1)
    print(f"  {len(units)} map units written ({headings} heading rows skipped)")
    if missing_color:
        print(f"  warning: no AreaFillRGB for {', '.join(missing_color)}; shown in light gray")
    return {u["mapunit"] for u in units}


# ------------------------------------------------------------------ line symbology
# Converts the ArcGIS Pro (CIM) line symbols in the Symbology table into a simple description
# the website can draw: solid or dashed strokes, plus ornaments (sawteeth, hachures, ticks,
# ball-and-bar) placed along the line. Sizes are in points, as in ArcGIS Pro.

def cim_color(c):
    if not c:
        return "rgb(0,0,0)", 1.0
    v, t = c.get("values", [0, 0, 0, 100]), c.get("type", "")
    if t == "CIMCMYKColor":
        cc, m, y, k = (x / 100 for x in v[:4])
        rgb = [round(255 * (1 - a) * (1 - k)) for a in (cc, m, y)]
        alpha = v[4] / 100 if len(v) > 4 else 1
    elif t == "CIMGrayColor":
        rgb, alpha = [round(v[0])] * 3, (v[1] / 100 if len(v) > 1 else 1)
    else:  # CIMRGBColor and anything else with RGB-like values
        rgb, alpha = [round(x) for x in v[:3]], (v[3] / 100 if len(v) > 3 else 1)
    return f"rgb({rgb[0]},{rgb[1]},{rgb[2]})", alpha


def cim_dashes(layer):
    for e in layer.get("effects") or []:
        if e.get("type") == "CIMGeometricEffectDashes" and e.get("dashTemplate"):
            return [round(x, 4) for x in e["dashTemplate"]]
    return None


def cim_path(geom, T):
    """CIM geometry (rings, paths, curveRings, curvePaths) to an SVG path string."""
    out = []
    for key, closed in (("rings", True), ("paths", False), ("curveRings", True), ("curvePaths", False)):
        for part in geom.get(key, []):
            cmds, cur = [], None
            for i, seg in enumerate(part):
                if isinstance(seg, dict):
                    if "b" in seg:   # cubic bezier: [end, control1, control2]
                        e, c1, c2 = seg["b"]
                        cmds.append("C %s %s %s" % (T(*c1[:2]), T(*c2[:2]), T(*e[:2])))
                        cur = e
                    else:            # circular or elliptic arc: approximated by a straight segment
                        e = (seg.get("c") or seg.get("a"))[0]
                        cmds.append("L %s" % T(*e[:2])); cur = e
                else:
                    cmds.append(("M %s" if i == 0 else "L %s") % T(*seg[:2])); cur = seg
            if cmds:
                out.append(" ".join(cmds) + (" Z" if closed else ""))
    return " ".join(out)


def cim_marker(L):
    f = L["frame"]
    w, h = f["xmax"] - f["xmin"], f["ymax"] - f["ymin"]
    a = L.get("anchorPoint") or {"x": 0, "y": 0}
    if L.get("anchorPointUnits", "Relative") == "Relative":
        ax, ay = (f["xmin"] + f["xmax"]) / 2 + a["x"] * w, (f["ymin"] + f["ymax"]) / 2 + a["y"] * h
    else:
        ax, ay = a["x"], a["y"]
    s = L.get("size", 10) / (h or 1)
    rot = math.radians(L.get("rotation") or 0)
    ox, oy = L.get("offsetX") or 0, L.get("offsetY") or 0
    xs, ys = [], []

    def T(x, y):
        # Marker units to points, anchor at the origin, then rotation and offset.
        # y is flipped so +y points to the RIGHT of the line direction, as on screen.
        px, py = (x - ax) * s, (y - ay) * s
        px, py = px * math.cos(rot) - py * math.sin(rot) + ox, px * math.sin(rot) + py * math.cos(rot) + oy
        px, py = round(px, 3), round(-py, 3)
        xs.append(px); ys.append(py)
        return f"{px} {py}"

    graphics = []
    for g in L.get("markerGraphics", []):
        d = cim_path(g.get("geometry", {}), T)
        if not d:
            continue
        g_out = {"d": d}
        for sl in (g.get("symbol") or {}).get("symbolLayers", []):
            if not sl.get("enable", True):
                continue
            if sl["type"] == "CIMSolidFill":
                g_out["fill"] = cim_color(sl.get("color"))[0]
            elif sl["type"] == "CIMSolidStroke":
                g_out["stroke"] = cim_color(sl.get("color"))[0]
                g_out["strokeWidth"] = round(sl.get("width", 1) * s if g.get("symbol", {}).get("type") == "CIMPolygonSymbol" else sl.get("width", 1), 3)
        if "fill" not in g_out and "stroke" not in g_out:
            g_out["fill"] = "rgb(0,0,0)"
        graphics.append(g_out)
    mp = L.get("markerPlacement") or {}
    t = mp.get("type", "")
    if t.startswith("CIMMarkerPlacementAlongLine") or t == "CIMMarkerPlacementOnLine":
        placement, interval = "along", sum(mp.get("placementTemplate") or [20])
    else:  # OnVertices (e.g. ball-and-bar on control points), AtRatioPositions, AtExtremities: one per line
        placement, interval = "center", None
    return {"type": "marker", "graphics": graphics, "placement": placement, "interval": interval,
            "bbox": [min(xs), min(ys), max(xs), max(ys)] if xs else [0, 0, 0, 0]}


def cim_line_symbol(cim):
    sym = cim.get("symbol", cim)
    layers = []
    # CIM lists the top layer first; the website draws bottom-up, so reverse.
    for L in reversed(sym.get("symbolLayers", [])):
        if not L.get("enable", True):
            continue
        if L["type"] == "CIMSolidStroke":
            color, alpha = cim_color(L.get("color"))
            layers.append({"type": "stroke", "width": round(L.get("width", 1), 4), "color": color,
                           "opacity": alpha, "dash": cim_dashes(L)})
        elif L["type"] == "CIMVectorMarker":
            layers.append(cim_marker(L))
    return layers


def short_label(desc):
    """'Thrust fault (1st option)-Identity and existence certain, location concealed. Sawteeth on
    upper plate' -> ('Thrust fault, concealed', 'Sawteeth on upper plate')"""
    name, _, rest = (desc or "").partition("-Identity")
    name = re.sub(r"\s*\([^)]*\)", "", name).strip() or desc
    quals = []
    if "location concealed" in rest: quals.append("concealed")
    elif "location approximate" in rest: quals.append("approximately located")
    if "questionable" in rest: quals.append("existence questionable")
    note = ""
    m = re.search(r"\.\s*(.+?(?:plate|block|side))\b", rest)
    if m:
        note = re.sub(r"\s*\([^)]*\)", "", m.group(1)).strip()
    return name + (", " + ", ".join(quals) if quals else ""), note


def build_symbology(gdb, out_path):
    L = CONFIG["lines_layer"]
    raw = run(["ogr2ogr", "-f", "GeoJSON", "/vsistdout/", gdb, "-dialect", "SQLite", "-sql",
               f"SELECT Symbol, COUNT(*) AS n FROM {L} GROUP BY 1"])
    used = {f["properties"]["Symbol"]: f["properties"]["n"] for f in json.loads(raw)["features"]
            if f["properties"].get("Symbol")}
    keys = ",".join("'%s'" % k.replace("'", "''") for k in used) or "''"
    raw = run(["ogr2ogr", "-f", "GeoJSON", "/vsistdout/", gdb, "-dialect", "SQLite", "-sql",
               f"SELECT Key, Description, Symbol FROM {CONFIG['symbology_table']} "
               f"WHERE SymbolType = 'Line' AND Key IN ({keys})"])
    symbols = {}
    for f in json.loads(raw)["features"]:
        p = f["properties"]
        cim = p["Symbol"] if isinstance(p["Symbol"], dict) else json.loads(p["Symbol"])
        label, note = short_label(p.get("Description"))
        symbols[p["Key"]] = {"label": label, "note": note, "description": p.get("Description"),
                             "count": used.get(p["Key"], 0), "layers": cim_line_symbol(cim)}
        kinds = [l["type"] + ("/" + l["placement"] if l["type"] == "marker" else "") + ("/dashed" if l.get("dash") else "")
                 for l in symbols[p["Key"]]["layers"]]
        print(f"  {p['Key']}  {label:<48} {used.get(p['Key'], 0):>6} lines  [{', '.join(kinds)}]")
    missing = sorted(set(used) - set(symbols))
    if missing:
        print(f"  warning: no Symbology row for {', '.join(missing)}; those lines use a plain default style")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"field": "Symbol", "symbols": dict(sorted(symbols.items()))}, fh, ensure_ascii=False, indent=1)


def build_tiles(gdb, out_path, workdir):
    stage = os.path.join(workdir, "stage.gpkg")
    # 1. Copy only the needed fields into a staging GeoPackage in web coordinates, fixing any invalid geometry.
    run(["ogr2ogr", "-f", "GPKG", stage, gdb, CONFIG["polys_layer"], "-nln", "mapunits",
         "-select", ",".join(CONFIG["polys_fields"]), "-t_srs", "EPSG:4326",
         "-nlt", "PROMOTE_TO_MULTI", "-makevalid"])
    run(["ogr2ogr", "-f", "GPKG", "-update", stage, gdb, CONFIG["lines_layer"], "-nln", "contacts_faults",
         "-select", ",".join(CONFIG["lines_fields"]), "-t_srs", "EPSG:4326", "-nlt", "PROMOTE_TO_MULTI"])
    # 2. Cut both layers into one PMTiles file.
    conf = {"mapunits": {"minzoom": CONFIG["min_zoom"], "maxzoom": CONFIG["max_zoom"]},
            "contacts_faults": {"minzoom": CONFIG["lines_min_zoom"], "maxzoom": CONFIG["max_zoom"]}}
    if os.path.exists(out_path):
        os.remove(out_path)
    run(["ogr2ogr", "-f", "PMTiles", out_path, stage,
         "-dsco", f"MINZOOM={CONFIG['min_zoom']}", "-dsco", f"MAXZOOM={CONFIG['max_zoom']}",
         "-dsco", f"CONF={json.dumps(conf)}", "-dsco", "NAME=Geologic Map of Arizona",
         "-dsco", "MAX_SIZE=1000000"])
    print(f"  {out_path}  ({os.path.getsize(out_path) / 1e6:.1f} MB)")


def check_units(gdb, dmu_units):
    raw = run(["ogrinfo", "-ro", "-q", gdb, "-sql",
               f"SELECT DISTINCT MapUnit FROM {CONFIG['polys_layer']}"])
    used = set(re.findall(r"MapUnit \(String\) = (.+)", raw))
    orphans = sorted(u.strip() for u in used if u.strip() not in dmu_units)
    if orphans:
        print(f"  warning: polygons use units missing from {CONFIG['dmu_table']}: {', '.join(orphans)}")
    else:
        print(f"  every polygon MapUnit has a matching {CONFIG['dmu_table']} row")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("gdb", help="path to the .gdb folder")
    p.add_argument("--inspect", action="store_true", help="list layers and fields, then stop")
    p.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    a = p.parse_args()
    check_gdal()
    if a.inspect:
        return inspect(a.gdb)
    os.makedirs(a.out, exist_ok=True)
    print("\n1/4  Reading unit descriptions, colors and line types")
    lines = line_summary(a.gdb)
    units = build_mapunits(a.gdb, os.path.join(a.out, "mapunits.json"), lines)
    print("\n2/4  Checking polygons against the unit table")
    check_units(a.gdb, units)
    print("\n3/4  Converting line symbols from the Symbology table")
    build_symbology(a.gdb, os.path.join(a.out, "symbology.json"))
    print("\n4/4  Building vector tiles (this can take several minutes for statewide data)")
    with tempfile.TemporaryDirectory() as tmp:
        build_tiles(a.gdb, os.path.join(a.out, "geology.pmtiles"), tmp)
    print("\nDone. In site/js/config.js, set dataSource to \"pmtiles\" to use these files.")


if __name__ == "__main__":
    main()
