import type { ClassMeeting } from "@campus/core";
import { useCallback, useEffect, useState } from "react";
import { storage } from "./data.ts";

const KEY = "campus-nav:schedule:v2";
/** Classes saved by the first version of the app (one meeting per class, no end time). */
const LEGACY_KEY = "campus-nav:classes";

export interface ScheduleFile {
  app: "ucsd-campus-nav";
  version: 2;
  savedAt: string;
  meetings: ClassMeeting[];
}

/** The student's schedule, saved to this browser on every change. */
export function useSchedule() {
  const [meetings, setMeetings] = useState<ClassMeeting[]>(() => {
    const saved = storage.get<ClassMeeting[] | null>(KEY, null);
    if (saved) return saved;
    return storage.get<ClassMeeting[]>(LEGACY_KEY, []);
  });

  useEffect(() => storage.set(KEY, meetings), [meetings]);

  const add = useCallback((ms: ClassMeeting[]) => setMeetings((cur) => [...cur, ...ms]), []);
  const update = useCallback(
    (id: string, patch: Partial<ClassMeeting>) => setMeetings((cur) => cur.map((m) => (m.id === id ? { ...m, ...patch } : m))),
    [],
  );
  const remove = useCallback((id: string) => setMeetings((cur) => cur.filter((m) => m.id !== id)), []);
  const removeCourse = useCallback((course: string) => setMeetings((cur) => cur.filter((m) => m.course !== course)), []);

  /** Download the schedule as a JSON file (a backup, or to move it to another device). */
  const exportFile = useCallback(() => {
    const file: ScheduleFile = { app: "ucsd-campus-nav", version: 2, savedAt: new Date().toISOString(), meetings };
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "my-schedule.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [meetings]);

  /** Replace the schedule with one from an exported file. Throws on a file that isn't one. */
  const importFile = useCallback(async (file: File) => {
    const parsed = JSON.parse(await file.text()) as Partial<ScheduleFile>;
    if (parsed.app !== "ucsd-campus-nav" || !Array.isArray(parsed.meetings)) {
      throw new Error("That isn't a schedule exported from this app.");
    }
    setMeetings(parsed.meetings);
    return parsed.meetings.length;
  }, []);

  return { meetings, add, update, remove, removeCourse, exportFile, importFile };
}

export type Schedule = ReturnType<typeof useSchedule>;
