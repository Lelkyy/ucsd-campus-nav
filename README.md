# Triton Trails

<img src="apps/web/public/logo.png" alt="Triton Trails" width="260" />

UCSD campus navigation

We've all gotten lost on campus at some point. Google Maps doesn't show the
campus footpaths, and there's no good way to plan a route if you commute by
bike, because it doesn't know the bike paths on campus either.

This project is a campus navigation app: enter your classes and it shows you
the way, using the paths, stairs and bike paths students actually use.

> Not an official UC San Diego project.

## What it does

- **Four ways to get there:** Walk, No stairs (step-free), Bike (bike paths
  first, roads where needed, walking your bike only where riding isn't allowed),
  and Transit: campus shuttles, MTS buses and the Blue Line trolley on their
  real timetables. Like Google Maps, Transit lists several options (with
  times, lines, walking, transfers, "every N min", fare, free with the UCSD
  U-Pass), sorted by Best route, Fewer transfers or Less walking, with Leave
  now / Depart at / Arrive by and a wheelchair-accessible option.
- **Your schedule:** add courses from the Fall 2026 schedule by picking a
  section; lectures, discussions, labs, midterms and the final come with it.
  Edit anything, add your own events, see a week view, export/import a backup.
  Saved in your browser.
- **Leave-by times:** for your next class, in whichever mode you picked.
- **Every classroom:** 556 rooms across 84 building codes are mapped to
  buildings; the few that aren't are listed with the reason.
- **Live directions:** press Start for turn-by-turn navigation that follows your
  GPS ("In 120 ft, turn left onto Library Walk"), re-routes when you go off
  course, can speak instructions, and keeps the screen on.
- **Inside the building:** which door to use, whether there's an elevator, and
  roughly where the room is ("It's on the second floor"), kept in the map's
  corner.
- **Your whole day:** see any day's classes in order, how long each walk between
  them takes and whether the gap is enough, and get directions to any class,
  from where you are or from the class before. Overlapping classes show as a
  conflict to choose from, and the day's walks are drawn on the map.
- **Search that understands campus:** "WLH 2001", "wlh2001", "CSE 11" (each
  section separately), "giesel" (typos and missing spaces are fine), building
  codes, old names and the names students use.
- **Home:** save it once, and it's one tap from either search box.
- **Student place names:** search "Revelle bus stop", "GTC" and other names
  students use. Name any spot yourself, and suggest names for everyone.
- **Report a problem:** from any route or the footer, tap the spot on the map,
  pick what's wrong, and send it by email (prefilled with the location and details).

## Run it

Requires Node 20+.

```bash
npm install
npm run dev          # http://localhost:5173
```

The campus map data is checked in, so this works straight away. Course
sections need the private schedule file (see
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#course-sections-private)); without
it you add classes by hand.

## Working on it

Work is split into tickets. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
starting: it covers how to claim a ticket, make a branch, and open a pull
request. How the code and data fit together is in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

Questions or ideas for new tickets: message Leonid (LE) on Instagram or in person.
