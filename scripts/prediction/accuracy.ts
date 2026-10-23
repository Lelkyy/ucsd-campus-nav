import Database from "better-sqlite3";

/**
 * Every prediction the live model has been scored on, in SQLite (MODEL_DIR/accuracy.sqlite), to see it improve:
 * when it was made, for which trip, stop and route, how far ahead, when the bus actually came, what MTS said,
 * what we said, and which of the model's options it served.
 *
 *   SELECT * FROM accuracy_by_hour ORDER BY hour DESC LIMIT 24;   -- our error vs MTS's, hour by hour
 *   SELECT * FROM accuracy_by_day;                                 -- and day by day
 *
 * Times are ms since the epoch; errors in the views are seconds. Hours and days are San Diego time.
 */
export interface ScoredPrediction {
  trip: string;
  stop: string;
  route: string;
  /** When the prediction was made (ms). */
  madeAt: number;
  horizon: string;
  /** How far ahead MTS's prediction was (s). */
  aheadS: number;
  actual: number;
  mts: number;
  ours: number;
  servedBy: string;
  settledAt: number;
}

export interface AccuracyRow {
  period: string;
  horizon: string;
  n: number;
  ourMeanError: number;
  mtsMeanError: number;
  /** How much smaller our error is than MTS's (%). */
  improvement: number;
  ourWithinMinute: number;
  mtsWithinMinute: number;
}

const summary = (period: string) => `
  SELECT ${period} AS period, horizon, COUNT(*) AS n,
    ROUND(AVG(ABS(ours - actual)) / 1000.0, 1) AS ourMeanError,
    ROUND(AVG(ABS(mts - actual)) / 1000.0, 1) AS mtsMeanError,
    ROUND(100.0 * (1 - AVG(ABS(ours - actual)) / NULLIF(AVG(ABS(mts - actual)), 0)), 1) AS improvement,
    ROUND(100.0 * AVG(ABS(ours - actual) <= 60000), 1) AS ourWithinMinute,
    ROUND(100.0 * AVG(ABS(mts - actual) <= 60000), 1) AS mtsWithinMinute
  FROM predictions`;

export class AccuracyDb {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS predictions (
        trip TEXT NOT NULL, stop TEXT NOT NULL, made_at INTEGER NOT NULL,
        route TEXT, horizon TEXT, ahead_s REAL,
        actual INTEGER NOT NULL, mts INTEGER NOT NULL, ours INTEGER NOT NULL,
        served_by TEXT, settled_at INTEGER,
        PRIMARY KEY (trip, stop, made_at)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS predictions_made_at ON predictions (made_at);
      CREATE VIEW IF NOT EXISTS accuracy_by_hour AS
        ${summary("strftime('%Y-%m-%d %H:00', made_at / 1000, 'unixepoch', 'localtime')")}
        GROUP BY period, horizon UNION ALL
        ${summary("strftime('%Y-%m-%d %H:00', made_at / 1000, 'unixepoch', 'localtime')").replace("horizon,", "'all' AS horizon,")}
        GROUP BY period;
      CREATE VIEW IF NOT EXISTS accuracy_by_day AS
        ${summary("date(made_at / 1000, 'unixepoch', 'localtime')")}
        GROUP BY period, horizon UNION ALL
        ${summary("date(made_at / 1000, 'unixepoch', 'localtime')").replace("horizon,", "'all' AS horizon,")}
        GROUP BY period;
    `);
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO predictions (trip, stop, made_at, route, horizon, ahead_s, actual, mts, ours, served_by, settled_at)
      VALUES (@trip, @stop, @madeAt, @route, @horizon, @aheadS, @actual, @mts, @ours, @servedBy, @settledAt)`);
  }

  add(rows: ScoredPrediction[]) {
    if (!rows.length) return;
    this.db.transaction((rs: ScoredPrediction[]) => {
      for (const r of rs) this.insert.run(r);
    })(rows);
  }

  /** Our error vs MTS's per hour (or day), for predictions made in the last `hours`. */
  history(by: "hour" | "day", hours: number): AccuracyRow[] {
    const period = by === "day" ? "date(made_at / 1000, 'unixepoch', 'localtime')" : "strftime('%Y-%m-%d %H:00', made_at / 1000, 'unixepoch', 'localtime')";
    const since = Date.now() - hours * 3600_000;
    const sql = `${summary(period)} WHERE made_at >= ? GROUP BY period, horizon UNION ALL ${summary(period).replace("horizon,", "'all' AS horizon,")} WHERE made_at >= ? GROUP BY period ORDER BY period, horizon`;
    return this.db.prepare(sql).all(since, since) as AccuracyRow[];
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM predictions").get() as { n: number }).n;
  }
}
