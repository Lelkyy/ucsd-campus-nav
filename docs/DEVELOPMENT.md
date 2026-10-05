# Development guide

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at http://localhost:5173 |
| `npm run build` | Production build to `apps/web/dist` |
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

## Directions, doors and floors

- `instructions.ts` turns a route into steps. Turns are only announced at
  junctions (3+ paths meet) or where the path name changes, using OSM names like
  Library Walk. Stairs and "walk your bike" stretches over 25 m are called out.
- `nav.ts` (`RouteTracker`) snaps GPS fixes to the route. Off the route by 35 m
  twice in a row re-routes from where you are; within 15 m of the end is arrival.
  In dev, **Simulate** walks the route without GPS.
- `indoor.ts`: routes skip emergency exits, step-free routes prefer doors tagged
  `wheelchair=yes`, and a room mapped indoors pulls the route to the nearest door.
  Floors come from mapped rooms (`indoor=room` + `level`) when available,
  otherwise from the room number (first digit; `B…` is basement), labelled as a guess.
- **Floor plans:** where OSM has indoor rooms/corridors (`indoor=room|corridor|area`
  with `level`), the map draws that floor and highlights the destination room,
  with a floor switcher. OSM's level 0 is the ground floor, shown as "Floor 1".
  Today that's the CSE building (EBU3B, ~370 spaces) and the Cala residence.
- **Indoor routes** (`indoorRoute.ts`): A* on a 0.5 m grid over each floor,
  from the door the outdoor route uses to the room. Walkable: corridors, areas,
  lobbies, stairwells/elevators (`stairs=yes`, `room=stairs`, `highway=elevator`,
  `room=elevator` with a multi-floor `level`, which also join floors), and the
  target room; other rooms are walls. Step-free trips use elevators only. It
  returns null (and the app shows no inside view or map floor plan) when the room
  has no outline, its floor has no mapped corridor, the door is more than 6 m from
  mapped space, or nothing connects them. In CSE, floors 2–4 have rooms but no
  corridors, so only ground-floor and basement rooms get a route.
- **Inside view** (`BuildingView.tsx`): draws the floor plan to scale with the
  route; a dot walks it and the view switches floors at the stairs/elevator
  ("Take the stairs down to basement"), with Replay. During navigation it opens
  once when you're within 60 m of the end (or step to the last instruction).
- **Room pins:** for every other building, students can "Pin this room": tap its
  spot, pick the floor. It's saved on their device right away and emailed to the
  map team as an entry for `data/room-locations.json` (`"CODE ROOM": { at, level }`),
  which the build adds for everyone.
- Getting exact rooms everywhere needs either indoor mapping in OSM (from
  sources OSM allows) or UCSD's floor plans, which sit behind the Facilities
  Information System and need Facilities' permission. Entrances (`entrance=main`,
  `wheelchair=yes`) and elevators in OSM also help; good ticket material.

## Student place names

`data/places.json` holds names students use ("Revelle bus stop", "GTC"). Each
entry points at shuttle stops by their exact timetable name and/or `[lon, lat]`
points; a route goes to the closest. `tips` adds notes for a building code or
`"CODE ROOM"`. People save their own names in the app, and "Suggest it for
everyone" emails the name and location to add here. Every shuttle stop is also
searchable by its own name.

## Building codes and classrooms

`data/building-codes.json` maps schedule building codes (`WLH`, `PCYNH`, …) to
OSM building names (`"Prefix*"` matches several buildings). It also lists codes
that aren't places (`notPlaces`) and real places not on the map yet
(`unplaced`, with the reason). The build prints any code that's in neither, plus
name-based guesses to check. Guesses are never applied automatically, because a
wrong one sends students to the wrong building. `npm test` fails if a code with
classes isn't accounted for.

Rooms come from `data/rooms.json` (2025–26, public schedule) plus the private
Fall 2026 file. Routing goes to the building's door; inside, only buildings with
mapped corridors get a route to the room (see Floor plans above).

## Fixing the map

Users report problems from the app's **Report** tab. Each report is an email to
the address in `apps/web/src/config.ts` (or `VITE_REPORT_EMAIL`), with the
category, the tapped location (coordinates and an OpenStreetMap link) and
their description. Turn reports into tickets, then fix them one of two ways:

1. **In OpenStreetMap (preferred)** for real, public things: missing paths,
   building entrances (`entrance=*`), ramps, wrong building names. Use the iD
   editor or JOSM with Esri World Imagery, which OSM is allowed to trace. Then
   `npm run fetch:osm` pulls the change in and everyone benefits. Don't trace
   from Google Maps or UCSD's own map.
2. **In this repo** for things OSM shouldn't have (temporary detours,
   shortcuts through buildings):
   - Add a LineString to `data/custom-paths.geojson` (draw it at
     [geojson.io](https://geojson.io) and paste it in). `"kind": "steps"` marks
     stairs. Vertices within 4 m of an existing path node join it.
   - Add a Point with `"name"` and `"aliases"` for a building OSM is missing.
     Put its schedule code in the aliases, then remove the code from `unplaced`.
   - Add an OSM way id to `data/blocked-ways.json` to drop a path that doesn't
     exist.

   Then run `npm run build:graph`.

### Known data gaps

- Unplaced codes: Social Sciences Building (`SSB`), Halicioglu Data Science
  Institute (`HDSI`), Triton Administrative Services Building (`TASB`), Seventh
  College West 2 (`SEVW2`), and `CCC` (unidentified).
- Few buildings have mapped entrances (45 of 346). Adding `entrance=*` nodes in
  OSM makes routes end at real doors. Good ticket material.

## Transit

Transit mode routes on two GTFS timetables (the `FEEDS` list in
`scripts/build-graph.ts`):

- **Triton Transit** campus shuttles (free).
- **San Diego MTS**: buses and the Blue Line trolley. The feed is county-wide,
  so the build keeps only stops in our area and the trips through them (the
  Blue Line, buses 30, 41, 201/202, 237, 921, 985).

Transit works like Google Maps' transit tab (`transitOptions.ts`):

- Several searches with different trade-offs (fastest; less walking; much less
  walking; fewest transfers via a high boarding penalty), plus the next
  departures (or earlier ones, when arriving by a time).
- Walking is one of the options when it's competitive (judged by arrival time,
  since a short ride can mean a long wait).
- Options another option beats on time, transfers and walking all at once are
  dropped; the rest are sorted by the preference: Best route (arrival, then
  transfers, then walking), Fewer transfers, or Less walking. Up to 5 are shown.
- Each card shows departure/arrival, lines, walking minutes, transfers, how
  often the first line runs ("every 15 min"), the fare and "Leave in N min".
- Leave now / Depart at / Arrive by applies to every mode; routing to a class
  sets Arrive by automatically. "Wheelchair accessible" uses step-free walking.
- While walking, the app suggests transit when it's 3+ minutes faster.

**Fares** come from `data/fares.json`, because the MTS feed's fare tables lag
behind fare changes. A one-way MTS fare ($3 since Oct 1, 2026) covers transfers
within 2 hours; Triton shuttles are free; the UCSD U-Pass (in student fees)
makes MTS free, and the app assumes you have one unless you untick it. Update
`data/fares.json` when MTS changes prices.

## Data & licenses

- Paths and buildings: © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
  Derived databases you publish must stay under ODbL.
- Basemap: [OpenFreeMap](https://openfreemap.org).
- Transit schedules: UC San Diego Triton Transit and San Diego MTS (GTFS; MTS's
  terms forbid using its trademarks or implying endorsement).
- Satellite imagery: Esri World Imagery, used for development/tracing. A public
  release should use a provider whose terms cover end-user display.
