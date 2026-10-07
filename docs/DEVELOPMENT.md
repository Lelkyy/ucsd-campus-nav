# Development guide

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at http://localhost:5173 |
| `npm run build` | Production build to `apps/web/dist` |
| `npm test` | Routing, schedule and data-coverage tests (includes the real campus data) |
| `npm run typecheck` | TypeScript across all packages |
| `npm run build:graph` | Rebuild the map data from cached downloads + edits + private schedule |
| `npm run fetch:osm` | Re-download OpenStreetMap data, the shuttle timetable and UCSD's ground plan, then rebuild |
| `npm run fetch:places` | Re-download UCSD's campus places (restrooms, food, water, bike racks...) into `apps/web/public/data/campus-places.json` |
| `npm run fetch:rooms` | Re-scrape building/room lists from the old public Schedule of Classes (terms up to Summer 2026) |

## How it fits together

```
OpenStreetMap (Overpass) ──┐
Triton Transit GTFS ───────┤
UCSD ground plan ──────────┤
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
    but not designated), roads with sidewalks, connector roads, and bike-only
    roads.
  - **Bike paths** are walkable whatever their `foot` tag says (pedestrians
    use them here), but walkers keep off them unless it's worth it: a bike path
    counts as 1.5x its walking time, so it's taken only when it saves about a
    third or more on that stretch.
  - **Roads with sidewalks** (`hasSidewalk`) are walked like footpaths
    (a 5% preference for paths) and ridden like roads. A road's OSM `sidewalk`
    tags decide first: `sidewalk`, `sidewalk:both|left|right` = both/left/right/yes
    count; `separate` (the sidewalk is its own footway, already in the graph)
    and `no` don't. Untagged roads on campus are checked against UCSD's ground
    plan (below), stretch by stretch: a sidewalk or walkway within 14 m on either
    side for at least half the stretch. Parking aisles and driveways never count.
    Untagged roads off the plan fall back to their type: residential, living,
    unclassified, tertiary and secondary roads, which around here almost always
    have one.
  - **Roads without a sidewalk** aren't for walking: one is kept (at 10x its
    walking time) only where it's the sole way to a campus building or shuttle
    stop (111 short stretches, mostly service roads to loading docks and
    outbuildings). Path pieces that lead to neither are dropped.
  - **UCSD's ground plan** (`scripts/ground.ts`): the "Ground Level Basemap" of
    the public Campus Map's vector tiles, which outlines every sidewalk, walking
    path, bike path, street and building at ground level (cached in
    `data/raw/ucsd-ground.json`, refreshed with `--refresh`). It's rasterized at
    0.5 m and used three ways:
    - **Missing walkways:** walkable ground (walking paths, sidewalks, bike
      paths) with no mapped path within 3.5 m is thinned to centre lines
      (Zhang-Suen), and the lines are added as footpaths (or bike paths, if
      mostly on bike path), joined onto the paths they run into (within 6 m).
      Short dead-end spurs (under 15 m) and lines that run beside a mapped path
      the whole way (within 9 m: the same path, where OSM and the survey
      disagree by a few meters, mostly on trails) are dropped. About 36 km of
      walkways come in this way: courtyards, building-side walks, plazas,
      sidewalks and trails OSM doesn't have.
    - **Bike paths:** OSM footpath segments lying on a surveyed bike path become
      bike paths.
    - **Sidewalks** along untagged roads (above).
    Only ground-level paths count: a tunnel or bridge doesn't cover the
    walkway above or below it, and no traced walkway joins one. A passage
    through a building (`tunnel=building_passage`) is at ground level. Where the
    plan shows a walkway under a roof, it's an open passage at ground level and
    is kept. The plan is newer than the illustrated map (it has the new Sixth
    College), so check it against satellite imagery, not the drawing.
  - **Stepping across** (`addStepAcross`): footpaths that come within 5 m of
    each other without meeting in OSM (a path ending just short of another,
    two paths side by side) get a short walking link, unless the walk between
    them along the paths is already under 25 m (or 4x the gap). Only points
    on footpaths alone (not road junctions or stairs), never between levels
    (`levelKey`: bridge, tunnel, indoors), never through a building wall.
  - **Riding** can also use every other road in the area that bikes are allowed on.
  - **Cyclists keep right** (`bikeDirection`, `BikeDir` flags per edge, `edgeTravel`
    in the router):
    - **One-ways:** one-way roads and paths are ridden only with the traffic (`oneway`,
      roundabouts, `oneway:bicycle`; `oneway:bicycle=no` and `cycleway=opposite*`
      allow contraflow). A divided road is mapped as two one-way carriageways, so
      each direction rides the carriageway on its right.
    - **Going against a one-way:** no riding. You get off and walk the bike, where
      there's a sidewalk or path to do it on ("Get off and walk your bike on the
      sidewalk ... (one-way the other way)").
    - **Bike lanes:** a lane counts only in the direction it serves. With traffic on
      the right, `cycleway:right` is for riding forward and `cycleway:left` for
      riding back; on a one-way, both go with the traffic. A road with a lane in
      your direction loses the road's 15-20% penalty.
    - **On the map:** rides along roads are drawn on the right-hand side of the
      road (about 3.5 m off the centre line), where you actually ride.
    - **Buildings:** each also gets `rideTargets`, ride-only road nodes within 15 m,
      so a bike can pull up beside a building on a road that has no sidewalk to
      walk.
  - Only buildings inside the OSM campus boundary are included. Each building
    gets route targets: mapped entrances when OSM has them, otherwise path
    points along its walls.
  - **UC San Diego's building list** (the public Campus Map's
    `Buildings_Public` layers, used with the campus GIS team's OK; cached in
    `data/raw/ucsd-building*.geojson`, refreshed with `--refresh`) adds official
    names and codes ("CSE", "HDSI") to the OSM building that is the same one
    (matched one-to-one: same name within 80 m, else the same shape at a similar
    size), and adds the buildings OSM is missing or hasn't named, from UCSD's
    footprint or, failing that, its point. OSM names stay unless listed under
    `renames` in `data/building-codes.json` (e.g. Literature -> HDSI, which
    replaced it). `VERBOSE=1 npm run build:graph` lists shape matches whose names
    differ, for review.

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
  **Simulate** walks the route on screen (6x speed); it shows in dev and whenever
  there's no GPS fix.
- `indoor.ts`: routes skip emergency exits, step-free routes prefer doors tagged
  `wheelchair=yes`, and a room mapped indoors pulls the route to the nearest door.
  Floors come from mapped rooms (`indoor=room` + `level`) when available,
  otherwise from the room number (first digit; `B…` is basement), labelled as a guess.
- **Room pointers:** no floor drawings; the app says roughly where a room is:
  "It's on the second floor" (`floorPhrase`, US floors: OSM level 0 is the first
  floor, negative levels are the basement). The floor comes from OSM indoor
  mapping (CSE, Cala) or a student's pin, else the room number, marked "going by
  the room number". It's shown in the arrival card, the day view and search.
- **Room pins:** the build still reads `data/room-locations.json`
  (`"CODE ROOM": { at, level }`) for rooms placed by hand; the in-app pinning
  flow was removed.
- Getting exact rooms everywhere needs either indoor mapping in OSM (from
  sources OSM allows) or UCSD's floor plans, which sit behind the Facilities
  Information System and need Facilities' permission. Entrances (`entrance=main`,
  `wheelchair=yes`) and elevators in OSM also help; good ticket material.

## Student place names

**Home** is a saved place (`saved-home` in `campus-nav:places`): set it by
tapping the map, with your location, or "Set this as your home" on any
destination; it's offered first in both search boxes and found by "home".

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
Fall 2026 file. Routing goes to the building's door, and the room gets a floor
pointer (see Room pointers above).

## Your day

The Schedule tab opens on **Day** (`DayView.tsx`, from `dayClasses` in
`schedule.ts`): any day's classes and that day's exams in order, with a week
strip to jump between days. Between two classes it shows how long getting from
one building to the next takes (walking, or by bike / step-free in those modes)
against the gap, flagged when it's tight. Every class has **Directions**, from
your location, and every change has **Directions from** the previous class's
room, both arriving by that day's start (`startOn`) less `CLASS_BUFFER_MIN`. The
Next class card links to the whole day.

With a home saved, the day starts with **Leave home by** (the trip to the first
class you're going to, arriving by its start less `CLASS_BUFFER_MIN`) and ends
with **Home by** (leaving when the last class ends), each with directions
(`estimateHome` in `App.tsx`: by shuttle or bus in Transit mode, else in your
mode). On the map, home gets an "H" pin and both trips are drawn. Without a
home, the day offers "Set your home".

Classes that overlap (`groupOverlaps`; no end time counts as 50 minutes) show
as a conflict to choose from: an exam, else the earliest, until you pick, and
the pick is kept per day in `localStorage` (`campus-nav:conflict-choices`). An
exam held in several rooms at once (same course, type and time, e.g. split by
last name) is the same kind of choice, labelled "pick your room" rather than a
conflict, and doesn't count as an overlap. The
walks between classes follow your picks, and while the Day view is open the map
shows them (dotted, in the next class's color) with a numbered pin per building
("1, 4" when two classes share one) instead of the current route.

## Design

One light theme (no dark mode) on the Triton Trails logo's backdrop, pale lime
#F2F8B6, with its forest greens for text and actions (#17301B, #2F5A2E) and the
Evergreen palette's clay, blush and sage for accents: CSS custom properties in
`styles.css`, and `palette.ts` for the map and course colors. Walking routes
get a white underlay so they read over green. Type: DM Sans (the wordmark is DM Sans bold),
Fraunces for a few headings. The logo files are in `apps/web/public/`
(`logo.png`, `logo-mark.png`, `favicon.png`, `apple-touch-icon.png`).

## Map stops

The map shows only the stops a route boards or leaves at.

## Off the paths

A start or end that isn't on a path (your location, a dropped pin) joins the
network at the closest point on the nearest usable path or road
(`CampusGraph.nearestEdgePoint`), not its nearest node, so the dotted line is
the short way onto it. The router may then go either way along that edge: it
gets the time from that point to each end (`approachCosts` -> `startCost` /
`targetCost`), and the route is extended to the exact point (`attachEnds`), its
distance and time included.

## Your location

When the browser already allows location (`navigator.permissions`), the app
follows you (`watchPosition`) and keeps your dot on the map, starting as soon
as permission is given; it never asks by itself (the locate buttons do). The
position moves only after ~10 m, so GPS jitter doesn't re-plan everything that
starts from it.

You're drawn as one marker, a dot with a cone for the way you face (MapLibre's
own locate dot is off). The cone follows the compass when the phone has one
(`deviceorientationabsolute`, or iOS's `webkitCompassHeading` after the locate
tap asks), else the way you're moving (GPS heading), else the way the route
sets off. When the trip starts from "My location", the dot stands in for the
start pin, and the start follows you as you move, without re-framing the map.

## Map styles and places

The **Map** button picks one of two campus maps (kept in `localStorage`,
`campus-nav:base-map`); the app's layers stay on top of both:

- **Campus:** what the official ArcGIS campus map
  (experience.arcgis.com/experience/c97d6e2efd7947d38738d5184b2debc7) is drawn
  on: Esri World Topographic, with UCSD's own campus boundary and district names
  from its campus vector tiles (`UCSD_LAYERS`, fonts swapped to Noto Sans).
  The tiles are muted toward gray (`raster-saturation`), and campus is drawn
  on them from UCSD's own ground-level layer in the same vector tiles
  (`UCSD_GROUND`, by `_symbol`): sage lawns, cream walkways, warm gray
  buildings with a darker edge, clay for the track, in the app's palette, at
  every zoom (UCSD's tiles carry it from zoom 12).
  (Raising `raster-contrast` on the tiles only bleaches their light colors.)
- **Illustrated:** UC San Diego's drawn campus map, the Concept3D tiles behind
  the old maps.ucsd.edu (`assets.concept3d.com/assets/1005/1005_Map_9`, TMS
  rows, zoom 13 to 20). Around it, where the drawing stops, OpenStreetMap is
  drawn in the drawing's colors (`ILLUSTRATED_PAINT`, sampled from its tiles:
  greens, gray roads, cream footpaths, pale gray roofs), with its labels, icons,
  3D buildings and borders off so nothing lands on the drawing. The drawing's
  edge is softened by a blurred band of its grass green (~40 m on the ground)
  along its outline, traced once from its tiles' transparency into
  `apps/web/public/data/illustrated-edge.json`.

In Campus mode the topographic map covers all of OpenStreetMap's drawing.

On both, everywhere you can walk is drawn on top: every walkable edge of the
routing graph (footpaths, sidewalks, bike paths, step-across links, connector
roads; not bike-only roads), as white lines with a warm edge (`walkways`,
`WALKWAY_LAYERS`), stairs dashed, a little softer over the drawing, under the
app's own layers. No street names.

**Places** come from the same campus map's "Campus Points Of Interest - Public"
layer, grouped into nine categories in `scripts/fetch-campus-places.ts`
(internal ones like waypoints, offices and conference rooms are left out) and
toggled from the Map button (`campus-nav:place-categories`). Tapping one shows
what and where it is, with Directions here. UCSD's points can be 10–60 m off.

## Search

`CampusSearch` (`packages/core/src/campusSearch.ts`, on
[MiniSearch](https://github.com/lucaong/minisearch)) backs the From/To boxes:

- buildings by name, code ("WLH", "CSE", "HDSI") and nickname or old name, with
  partial words ("warren lec") and typos ("giesel") forgiven;
- rooms in any form, checked against the rooms classes actually meet in:
  "WLH 2001", "wlh2001", "2001 WLH", "WLH rm 2001", "WLH #2001", "WLH-2001",
  "warren lecture hall 2001". Rooms compare loosely ("MANDE B104" = B-104,
  "RWAC 103" = 0103, "otrsn 1e106"), named rooms match by their start
  ("mandeville auditorium" -> MANDE AUD), a number alone ("2001") lists every
  building with that room, "WLH 20" lists the rooms starting with 20, and a full
  number nobody's class uses is still offered (marked "not a listed classroom").
  Numbers are never typo-matched;
- courses ("CSE 11", "math20c", or a title like "data structures"), one result
  per section: each lecture group ("CSE 11" -> 001 TuTh at GH 242, 002 MW at
  CENTR 115; with one lecture, its discussions too), a group and its
  discussions/labs ("cse11 002"), one ("cse11 001-002"), or all of a kind
  ("cse11 lab"); a code still being typed ("cse1") lists courses. A course code
  is never read as a room. Your own classes come first. Leading zeros are fine
  (`courseKey`): "cse005", "CSE 005", "cse-005" are CSE 5, and a zero-padded
  number is taken as complete (CSE 5, not CSE 599; "cse008" still gives CSE 8A);
- student place names, your saved places, then shuttle stops.

Spaces don't matter: names are also indexed with their spaces taken out
("pricecenter", "warrenlecturehall2001", "W L H 2001", "c s e 1 1").

Empty, the box offers your location (start field), Home (or "Set your home"),
your classes and recent picks (kept in `localStorage`). It's a keyboard combobox (arrows, Enter, Esc).

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
  dropped; the rest, later departures included, are sorted by trip length
  (`route.minutes`, door to door with waits; ties go to the earlier arrival, or
  the later departure when arriving by a time). The first 3 are shown.
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
- Map around the illustrated drawing, and label fonts: [OpenFreeMap](https://openfreemap.org).
- Transit schedules: UC San Diego Triton Transit and San Diego MTS (GTFS; MTS's
  terms forbid using its trademarks or implying endorsement).
- Illustrated campus map: © UC San Diego (Concept3D tiles); campus map styles
  and places: UC San Diego's public ArcGIS campus map, on Esri World Topographic.
  Walkways traced from UCSD's ground plan are in `graph.json` next to the OSM
  paths. Check all of these are OK to use before a public release.
