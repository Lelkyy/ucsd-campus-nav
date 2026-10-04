/**
 * Collects every building + room that classes and finals meet in, from UCSD's
 * public Schedule of Classes (no login), and writes data/rooms.json.
 *
 *   npm run fetch:rooms                 # default terms
 *   npm run fetch:rooms -- FA25 WI26    # specific terms
 *
 * Requests are sequential per term with a pause between them to be gentle on the
 * server. Progress is checkpointed, so an interrupted run resumes where it stopped.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data/rooms.json");
const PROGRESS = join(ROOT, "data/raw/rooms-progress.json");
const BASE = "https://act.ucsd.edu/scheduleOfClasses/";
const DEFAULT_TERMS = ["FA25", "WI26", "SP26"];
const PAUSE_MS = 250;

/** Codes that aren't physical places. */
const NOT_A_PLACE = new Set(["TBA", "RCLAS", "ONLINE", "REMOTE"]);

class Session {
  private cookies = new Map<string, string>();

  async request(url: string, init: RequestInit = {}): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(new URL(url, BASE), {
          ...init,
          redirect: "manual",
          headers: {
            "User-Agent": "ucsd-campus-nav room list (student project)",
            Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            ...init.headers,
          },
          signal: AbortSignal.timeout(60_000),
        });
        for (const c of res.headers.getSetCookie()) {
          const [pair] = c.split(";");
          const eq = pair.indexOf("=");
          this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return await res.text();
      } catch (err) {
        if (attempt >= 3) throw err;
        await sleep(2000 * attempt);
      }
    }
  }
}

interface Progress {
  rooms: Record<string, string[]>;
  done: string[];
  failed: string[];
  sections: number;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => /^[A-Z0-9]{4}$/.test(a));
  const terms = args.length ? args : DEFAULT_TERMS;

  // Resume from a previous partial run of the same terms.
  const saved: Progress | null = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")) : null;
  const rooms = new Map<string, Set<string>>(Object.entries(saved?.rooms ?? {}).map(([b, r]) => [b, new Set(r)]));
  const progress = { done: new Set(saved?.done ?? []), failed: new Set<string>(), sections: saved?.sections ?? 0 };
  if (saved) console.log(`Resuming: ${progress.done.size} term/subject pairs already done`);
  const checkpoint = () => {
    mkdirSync(dirname(PROGRESS), { recursive: true });
    const out: Progress = {
      rooms: Object.fromEntries([...rooms].map(([b, r]) => [b, [...r]])),
      done: [...progress.done],
      failed: [...progress.failed],
      sections: progress.sections,
    };
    writeFileSync(PROGRESS, JSON.stringify(out));
  };

  // One session per term, run side by side (three gentle request streams).
  await Promise.all(terms.map((term) => fetchTerm(term, rooms, progress, checkpoint)));

  const out = {
    source: "UC San Diego Schedule of Classes (public)",
    terms,
    fetchedAt: new Date().toISOString(),
    incomplete: [...progress.failed].sort(),
    rooms: Object.fromEntries(
      [...rooms]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([b, rs]) => [b, [...rs].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))]),
    ),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  if (progress.failed.size === 0) rmSync(PROGRESS, { force: true });
  else checkpoint();
  const roomCount = Object.values(out.rooms).reduce((n, r) => n + r.length, 0);
  console.log(`${progress.sections} meeting rows -> ${rooms.size} buildings, ${roomCount} rooms -> data/rooms.json`);
  if (progress.failed.size) console.log(`Could not fetch (rerun to retry): ${[...progress.failed].join(", ")}`);
}

async function fetchTerm(
  term: string,
  rooms: Map<string, Set<string>>,
  progress: { done: Set<string>; failed: Set<string>; sections: number },
  checkpoint: () => void,
): Promise<void> {
  let session = await openSession();
  const subjects = (JSON.parse(await session.request(`subject-list.json?selectedTerm=${term}`)) as { code: string }[])
    .map((s) => s.code.trim());
  console.log(`${term}: ${subjects.length} subjects`);

  for (const [k, subject] of subjects.entries()) {
    const key = `${term}:${subject}`;
    if (progress.done.has(key)) continue;
    for (let attempt = 1; ; attempt++) {
      try {
        const found = new Map<string, Set<string>>();
        progress.sections += await fetchSubject(session, term, subject, found);
        for (const [b, rs] of found) {
          if (!rooms.has(b)) rooms.set(b, new Set());
          rs.forEach((r) => rooms.get(b)!.add(r));
        }
        progress.done.add(key);
        progress.failed.delete(key);
        checkpoint();
        break;
      } catch (err) {
        if (attempt >= 2) {
          console.warn(`  ${key}: giving up (${(err as Error).message})`);
          progress.failed.add(key);
          break;
        }
        // The server keeps paging state per session; start a clean one.
        await sleep(10_000);
        session = await openSession();
      }
    }
    if ((k + 1) % 20 === 0) console.log(`  ${term}: ${k + 1}/${subjects.length} subjects, ${rooms.size} buildings so far`);
    await sleep(PAUSE_MS);
  }
}

async function openSession(): Promise<Session> {
  const session = new Session();
  await session.request("scheduleOfClassesStudent.htm");
  return session;
}

/** All result pages for one subject; returns meeting rows seen. */
async function fetchSubject(session: Session, term: string, subject: string, rooms: Map<string, Set<string>>): Promise<number> {
  const form = new URLSearchParams({ selectedTerm: term, tabNum: "tabs-sub", selectedSubjects: subject, _selectedSubjects: "1" });
  // Every course-level filter on, every day, all times.
  for (const opt of ["1", "11", "12", "2", "4", "5", "3", "7", "8", "13", "10", "9"]) {
    form.append(`schedOption${opt}`, "true");
    form.append(`_schedOption${opt}`, "on");
  }
  for (const d of ["M", "T", "W", "R", "F", "S", "SU"]) form.append("schDay", d);
  form.append("_schDay", "on");
  Object.entries({ schStartTime: "12:00", schStartAmPm: "0", schEndTime: "12:00", schEndAmPm: "0" }).forEach(([a, b]) =>
    form.append(a, b),
  );

  let count = 0;
  let html = await session.request("scheduleOfClassesStudentResult.htm", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const pages = Math.max(1, ...[...html.matchAll(/page=(\d+)/g)].map((m) => Number(m[1])));
  for (let page = 1; ; page++) {
    count += collectRooms(html, rooms);
    if (page >= pages) break;
    await sleep(PAUSE_MS);
    html = await session.request(`scheduleOfClassesStudentResult.htm?page=${page + 1}`);
  }
  return count;
}

/** Adds building/room pairs from section and exam rows; returns rows seen. */
function collectRooms(html: string, rooms: Map<string, Set<string>>): number {
  let n = 0;
  for (const [, row] of html.matchAll(/<tr class="(?:sectxt|nonenrtxt)">([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      decode(m[1].replace(/<[^>]+>/g, "")).trim(),
    );
    // Location follows the time column: "... | 9:30a-10:50a | CENTR | 115 | ..."
    const t = cells.findIndex((c) => /^\d{1,2}:\d{2}[ap]-\d{1,2}:\d{2}[ap]$/.test(c));
    if (t === -1) continue;
    const building = cells[t + 1]?.toUpperCase();
    const room = cells[t + 2]?.toUpperCase();
    n++;
    if (!building || !/^[A-Z][A-Z0-9-]{1,7}$/.test(building) || NOT_A_PLACE.has(building)) continue;
    if (!rooms.has(building)) rooms.set(building, new Set());
    if (room && room !== "TBA") rooms.get(building)!.add(room);
  }
  return n;
}

function decode(s: string): string {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
