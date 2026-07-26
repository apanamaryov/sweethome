import { getJson } from "./api";

export type SeriesPoint = { t: number } & Record<string, number | null>;

export interface DailyRow {
  day: string;
  pv_wh: number;
  load_wh: number;
  grid_wh: number;
  batt_charge_wh: number;
  batt_discharge_wh: number;
  solar_start_ts: number | null;
  solar_end_ts: number | null;
  soc_min: number | null;
  soc_max: number | null;
  grid_loss_count: number;
  sample_count: number;
}

export interface StatsEvent {
  id: number;
  ts: number;
  type: string;
  detail: string; // JSON
}

/** Энергия (Вт·ч) за одну корзину. `t` — начало корзины, unix ms. */
export interface EnergyBucket {
  t: number;
  pv_wh: number;
  load_wh: number;
  grid_wh: number;
  batt_charge_wh: number;
  batt_discharge_wh: number;
}

export function fetchSeries(fields: string[], from: number, to: number): Promise<SeriesPoint[]> {
  return getJson(`/api/stats/series?fields=${fields.join(",")}&from=${from}&to=${to}&res=auto`);
}

export function fetchDaily(fromDay: string, toDay: string): Promise<DailyRow[]> {
  return getJson(`/api/stats/daily?from=${fromDay}&to=${toDay}`);
}

export type SolarState = "idle" | "active" | "ended";

export interface SolarWindow {
  day: string;
  start: number | null; // unix ms
  end: number | null; //   unix ms
  state: SolarState;
}

export function fetchSolarWindow(day?: string): Promise<SolarWindow> {
  return getJson(`/api/stats/solar-window${day ? `?day=${day}` : ""}`);
}

export function fetchEvents(from: number, to: number, type?: string): Promise<StatsEvent[]> {
  const t = type ? `&type=${encodeURIComponent(type)}` : "";
  return getJson(`/api/stats/events?from=${from}&to=${to}&limit=200${t}`);
}

export function fetchEnergy(
  from: number,
  to: number,
  bucket: "hour" | "day"
): Promise<EnergyBucket[]> {
  return getJson(`/api/stats/energy?from=${from}&to=${to}&bucket=${bucket}`);
}
