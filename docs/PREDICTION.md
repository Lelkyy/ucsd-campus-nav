# Bus arrival prediction

Testbed on the `barebones/prediction` branch: predicting when MTS buses and trolleys reach their stops,
starting from MTS's own predictions and learning, from every bus that arrives, how to do better.

## Pieces

| Piece | What it does |
|---|---|
| `npm run record:mts` (`scripts/record-mts.ts`) | Logs every new GPS fix every 15 s and every changed MTS prediction every 60 s, one gzipped NDJSON file per hour (`data/private/mts-log`, not in git). |
| `decodeTripUpdates` (`packages/core/src/liveTransit.ts`) | Reads MTS's GTFS-realtime trip updates: predicted arrival and departure at every stop ahead of every trip. |
| `packages/core/src/arrivals.ts` | Ground truth: snaps a trip's GPS fixes to its route shape and finds when the bus reached each stop. |
| `packages/core/src/arrivalModel.ts` | The online model (below). |
| `npm run predict:live` (`scripts/prediction/live.ts`) | Runs the model around the clock on the recorder's logs: predicts every stop ahead every minute, learns as buses arrive, writes the model, current predictions and a scorecard to `data/private/mts-model`. |
| `scripts/prediction/accuracy.ts` | The accuracy database: every prediction the live model is scored on (SQLite, `accuracy.sqlite` in the model folder), with views `accuracy_by_hour` and `accuracy_by_day`. Charted at `GET /accuracy` on the model server. |
| `npm run evaluate:prediction` (`scripts/prediction/evaluate.ts`) | Replays the recordings in time order and scores MTS, the timetable and the model side by side. |
| `scripts/server/` | One command to run the recorder and the live model as services on a Linux server (Google Cloud e2-micro; logs in `/var/lib/mts-recorder`, model in `/var/lib/mts-recorder/model`). |

## Truth

A trip's route shape and stops come from MTS's timetable (downloaded weekly). Each GPS fix is snapped to the
shape, giving metres along the trip; progress only moves forward, and a stop is placed at the first pass of the
route near it (loops end where they start). A bus has reached a stop when it passes 15 m before it, interpolated
between the fixes either side; fixes more than 2 minutes apart give no answer.

## The online model

It predicts MTS's error, not the arrival from scratch, and learns from every arrival as it happens:

- **Running averages** of MTS's recent error by route, by stop and overall, fading with a half-life
  (30 minutes for routes, 3 hours for stops), so a route running late today is picked up within minutes.
- **One small linear model per horizon** (0–2, 2–5, 5–10, 10–20, 20–60 minutes ahead), over those averages and
  live signals: how late this bus is now against the timetable, how late the bus that will run a not-yet-started
  trip is on the trip it's still finishing, and how stale MTS's prediction and the last GPS fix are. Fitted by
  recursive least squares with a forgetting factor, so it follows the day.
- **Learning waits for every bus to have had its chance** (`learnAt`: the horizon plus 15 minutes). Learning
  from each bus the moment it arrives would learn from early buses first and drift early.
- **It keeps score** of MTS as published, MTS plus the route's recent error, and the full model, per horizon,
  and serves whichever has been closest lately. So it never stays worse than MTS, and switches as soon as the
  model starts winning.

First results, 3 hours of a weekday afternoon (last hour, settled predictions): 0–2 minutes ahead, 46 s average
error against MTS's 56 s; 2–5 minutes, 72 s against 79 s; further ahead it is still learning and serves MTS.
Time-of-day and weekday effects need weeks; those are what the server's recordings are for.

## Seeing it improve

The model server (port 8787) serves:

- `/accuracy`: a page charting our average error against MTS's, hour by hour or day by day, for each horizon.
- `/accuracy.json?by=hour|day&hours=N`: the same numbers.
- `/scorecard`: the last hour, as the log line shows it.
- `/vehicles?bbox=w,s,e,n`: where each bus in the box is going (what the app moves buses along).

Or query the database directly: `SELECT * FROM accuracy_by_day;` in `accuracy.sqlite`.

## Next

- Traffic signals ahead of each stop, from OpenStreetMap, as a feature (live signal timing isn't public).
- Serving the model's predictions to the app.
- A particle filter for where each bus is between fixes, using the predicted segment times.
