# UCSD Campus Nav

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
- **Inside the building:** which door to use, which floor, elevators, and the
  exact room, pinned by students where the building isn't mapped indoors ("Pin this
  room"). Where the corridors are mapped (CSE's ground floor and basement today),
  an inside view walks you from the door to the room, animating the stairs or
  elevator between floors, and opens by itself as you reach the building. Floors
  without mapped corridors get no drawing rather than a guessed one.
- **Student place names:** search "Revelle bus stop", "GTC" and other names
  students use. Name any spot yourself, and suggest names for everyone.
- **Report a problem:** tap the spot on the map, pick what's wrong, and send it
  by email (prefilled with the location and details).

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
