# Development guide

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at http://localhost:5173, including the **Edit map** tab |
| `npm run build` | Production build to `apps/web/dist` (editor not included) |
| `npm test` | Routing, schedule and data-coverage tests (includes the real campus data) |
| `npm run typecheck` | TypeScript across all packages |
| `npm run build:graph` | Rebuild the map data from cached downloads + edits + private schedule |
| `npm run fetch:osm` | Re-download OpenStreetMap data and the shuttle timetable, then rebuild |
| `npm run fetch:rooms` | Re-scrape building/room lists from the old public Schedule of Classes (terms up to Summer 2026) |

## How it fits together

```
OpenStreetMap (Overpass) ──┐
Triton Transit GTFS ───────┤
data/custom-paths.geojson ─┤
data/blocked-ways.json ────┼─► scripts/build-graph.ts ─► apps/web/public/data/
data/building-codes.json ──┤                               graph · buildings · transit · sections*
data/rooms.json ───────────┤                               │
data/private/* (TSS) ──────┘                               ▼
                                     packages/core  routing, schedule, sections, search
                                                           │
                                     apps/web       React + MapLibre GL JS
```
\* `sections.json` only exists when the private schedule data is present.

- **`packages/core`**: TypeScript with no browser or Node APIs, so a future
  phone (Expo) or desktop (Tauri) app can reuse it as-is.
  - `route.ts`: time-dependent A*. A **profile** gives a speed for each kind of
    path (walking 1.3 m/s; riding about 5 m/s; walking a bike 1.2 m/s where riding
    isn't allowed) plus preferences, and `MODES` maps the app's four options
    (Walk, No stairs, Bike, Bus) to profiles. Bus mode adds shuttle rides from
    the timetable. Routes can start at any exit of a building.
  - `schedule.ts`: meetings (weekly or one-off, like exams) and "next class".
  - `sections.ts`: course sections from the schedule, grouped into choices
    (lecture group + one discussion/lab), and course search.
- **`apps/web`**: Vite + React + MapLibre. Routing runs in the browser; there's
  no server. The schedule is saved in `localStorage`.
- **`scripts/build-graph.ts`** builds the map data:
  - **Edge kinds:** footpaths, stairs, bike paths, shared paths (bikes allowed
    but not designated), connector roads, and bike-only roads.
  - **Walking** uses roads only where they're the sole link to a campus building
    or shuttle stop (~6% of road segments). Path pieces that lead to neither
    are dropped.
  - **Riding** can also use every other road in the area that bikes are allowed on.
  - Only buildings inside the OSM campus boundary are included. Each building
    gets route targets: mapped entrances when OSM has them, otherwise path
    points along its walls.

## Course sections (private)

Fall 2026 sections come from TSS (Triton Student System), which needs a UCSD
login, so the data is **not** in git (`data/private/` is ignored). To use it,
put these files in `data/private/` and run `npm run build:graph`:

- `fa26-meetings.tsv`: one row per meeting:
  `course, section, type, kind (C/F/M), days, date, start, end, mode, building, room`
- `fa26-courses.tsv`: `course, title`

Ask Leonid for the files. Don't commit them or the generated
`apps/web/public/data/sections.json` until we've confirmed sharing is OK.

## Building codes and classrooms

`data/building-codes.json` maps schedule building codes (`WLH`, `PCYNH`, …) to
OSM building names (`"Prefix*"` matches several buildings). It also lists codes
that aren't places (`notPlaces`) and real places not on the map yet
(`unplaced`, with the reason). The build prints any code that's in neither, plus
name-based guesses to check. Guesses are never applied automatically, because a
wrong one sends students to the wrong building. `npm test` fails if a code with
classes isn't accounted for.

Rooms come from `data/rooms.json` (2025–26, public schedule) plus the private
Fall 2026 file. Routing goes to the building's door; indoor (floor/room)
navigation isn't mapped.

## Mapping paths from satellite view

1. `npm run dev`, open **Edit map**. Satellite and the path network turn on.
2. Zoom in: white dots are existing path nodes. Pick **Path** or **Stairs**,
   click along the path in the imagery, starting and ending on existing dots so
   it connects (clicks within 5 m snap to them).
3. **Save line**. It's written to `data/custom-paths.geojson` and the map data
   rebuilds immediately.
4. **Building** adds a named point for a building OSM is missing. Put schedule
   codes like `SSB` in its aliases, then remove the code from `unplaced`.

To remove a wrong OSM path, add its way id to `data/blocked-ways.json`.

**OSM or local edit?** Real, public paths and building entrances are better
added to OpenStreetMap itself (iD editor or JOSM, with Esri World Imagery, which
OSM is allowed to trace). The next `npm run fetch:osm` pulls them in and everyone
benefits. Keep local edits for things OSM shouldn't have (shortcuts through
buildings, temporary detours). Don't trace from Google Maps or UCSD's own map.

### Known data gaps

- Unplaced codes: Social Sciences Building (`SSB`), Halicioglu Data Science
  Institute (`HDSI`), Triton Administrative Services Building (`TASB`), Seventh
  College West 2 (`SEVW2`), and `CCC` (unidentified).
- Few buildings have mapped entrances (45 of 346). Adding `entrance=*` nodes in
  OSM makes routes end at real doors. Good ticket material.

## Shuttles

Bus mode routes on [Triton Transit](https://transportation.ucsd.edu/campus/shuttles/gtfs.html)'s
published timetable (GTFS): walk to a stop, ride, walk on. For a class, it plans
backwards from the start time. Times are scheduled, not live, and MTS buses and
the trolley aren't included yet (their GTFS feed would plug into the `FEEDS` list).

## Data & licenses

- Paths and buildings: © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
  Derived databases you publish must stay under ODbL.
- Basemap: [OpenFreeMap](https://openfreemap.org).
- Satellite imagery: Esri World Imagery, used for development/tracing. A public
  release should use a provider whose terms cover end-user display.
