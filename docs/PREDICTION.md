# Bus arrival prediction

Testbed on the `barebones/prediction` branch: predicting when MTS buses and trolleys reach their stops,
starting from MTS's own predictions and improving on them.

## Pieces

| Piece | What it does |
|---|---|
| `npm run record:mts` (`scripts/record-mts.ts`) | Logs every new GPS fix every 15 s and every changed MTS prediction every 60 s, one gzipped NDJSON file per hour (`data/private/mts-log`, not in git). |
| `scripts/server/` | One-command setup that runs the recorder as a service on a Linux server (Google Cloud e2-micro, `/var/lib/mts-recorder`). |
| `decodeTripUpdates` (`packages/core/src/liveTransit.ts`) | Reads MTS's GTFS-realtime trip updates: predicted arrival and departure at every stop ahead of every trip. |
| `packages/core/src/arrivals.ts` | Ground truth: snaps a trip's GPS fixes to its route shape and finds when the bus reached each stop. |
| `npm run evaluate:prediction` (`scripts/prediction/evaluate.ts`) | Replays the recordings minute by minute, scores each method against the truth, fitted on earlier trips and scored on later ones. |

## Truth

A trip's route shape and stops come from MTS's timetable (`data/raw/gtfs/mts.zip`). Each GPS fix is snapped to
the shape, giving metres along the trip; progress only moves forward. A bus has reached a stop when it passes
15 m before it, interpolated between the fixes either side; fixes more than 2 minutes apart give no answer.

## Methods so far

- **mts**: MTS's prediction as published. Most times are rounded to the minute and about 47 s old.
- **schedule**: the timetable.
- **delay**: the timetable plus how late the bus is now, from its latest fix.
- **mts+bias**: MTS's prediction plus its typical error at that horizon.
- **blend**: MTS's prediction moved toward `delay` by a weight fitted per horizon.

First result, 1 h 45 min of recordings on a weekday afternoon: MTS is off by 125 s on average and about a minute
early; mts+bias brings that to 118 s, and at 0–2 minutes ahead from 76 s to 53 s (within a minute 52% → 68%).
One afternoon can't show time-of-day or weekday effects; those need weeks of recordings.

## Next

1. Pull the server's recordings down for training.
2. LightGBM on MTS's error, with horizon, route, stop, time of day, weekday, fix age, distance left and the
   speed of buses just ahead as features.
3. A particle filter for where each bus is between fixes, using the predicted segment times.
