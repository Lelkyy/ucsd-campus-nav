import { describe, expect, it } from "vitest";
import { OnlineArrivalModel, type ArrivalContext } from "./arrivalModel.ts";

const MIN = 60_000;
const t0 = new Date(2026, 9, 23, 15, 0).getTime();
const at = (k: number, route = "30", stop = `s${k % 20}`): ArrivalContext => ({
  tau: t0 + k * MIN,
  mts: t0 + k * MIN + 4 * MIN,
  schedule: t0 + k * MIN + 4 * MIN,
  route,
  stop,
  predAge: 47,
});

describe("OnlineArrivalModel", () => {
  it("starts out trusting MTS", () => {
    const m = new OnlineArrivalModel();
    expect(m.predict(at(0)).at).toBe(at(0).mts);
  });

  it("learns that MTS runs early and corrects for it", () => {
    const m = new OnlineArrivalModel();
    // Buses arrive 90 s after MTS says.
    for (let k = 0; k < 400; k++) {
      const c = at(k);
      const p = m.predict(c);
      m.learn(c, p, c.mts + 90_000);
    }
    const c = at(400);
    expect((m.predict(c).at - c.mts) / 1000).toBeGreaterThan(75);
    expect((m.predict(c).at - c.mts) / 1000).toBeLessThan(105);
  });

  it("picks up one route running late without moving the others", () => {
    const m = new OnlineArrivalModel();
    for (let k = 0; k < 600; k++) {
      for (const route of ["30", "201"]) {
        const c = at(k, route);
        const p = m.predict(c);
        m.learn(c, p, c.mts + (route === "30" ? 5 * MIN : 0));
      }
    }
    const late = m.predict(at(600, "30"));
    const onTime = m.predict(at(600, "201"));
    expect((late.at - at(600).mts) / MIN).toBeGreaterThan(3.5);
    expect(Math.abs((onTime.at - at(600).mts) / MIN)).toBeLessThan(1);
  });

  it("uses how late the next bus is on its last trip when MTS only has the timetable", () => {
    const m = new OnlineArrivalModel();
    for (let k = 0; k < 800; k++) {
      const late = (k % 4) * 3; // 0, 3, 6, 9 minutes behind on its last trip
      const c = { ...at(k), vehicleDelay: late * 60 };
      const p = m.predict(c);
      m.learn(c, p, c.schedule + late * MIN);
    }
    const c = { ...at(800), vehicleDelay: 9 * 60 };
    expect((m.predict(c).at - c.schedule) / MIN).toBeGreaterThan(7);
  });

  it("saves and restores what it learned", () => {
    const m = new OnlineArrivalModel();
    for (let k = 0; k < 200; k++) {
      const c = at(k);
      const p = m.predict(c);
      m.learn(c, p, c.mts + 60_000);
    }
    const copy = OnlineArrivalModel.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
    expect(copy.predict(at(200)).at).toBe(m.predict(at(200)).at);
    expect(copy.learned).toBe(200);
  });
});
