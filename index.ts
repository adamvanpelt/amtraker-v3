// so much goop god this needs a hell of a rewrite

import * as crypto from "crypto-js";
import moment from "moment-timezone";
import * as schedule from "node-schedule";
import * as fs from "fs";
import { XMLBuilder } from "fast-xml-parser";

const xmlBuilder = new XMLBuilder();

import { Amtrak, RawStation } from "./types/amtrak";
import { RawViaTrain } from "./types/via";
import {
  Train,
  Station,
  StationStatus,
  TrainResponse,
  StationResponse,
} from "./types/amtraker";

import { trainNames, viaTrainNames } from "./data/trains";
import * as stationMetaData from "./data/stations";
import { amtrakStationCodeReplacements } from './data/sharedStations';
import cache from "./cache";

const rawStations = JSON.parse(fs.readFileSync("./rawStations.json", { encoding: "utf8" }));

import length from "@turf/length";
import along from "@turf/along";
import calculateIconColor from "./calculateIconColor";

// ---- resilient fetch helpers ----
type FetchFn<T> = (url: string) => Promise<T>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout(ms: number, signal?: AbortSignal) {
  const composite = new AbortController();
  const timeout = setTimeout(() => composite.abort(), ms);
  const onAbort = () => composite.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: composite.signal,
    clear: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchTextWithRetry(
  url: string,
  {
    attempts = 5,
    baseDelayMs = 500,
    timeoutMs = 8000,
    tag = "fetchText",
  }: { attempts?: number; baseDelayMs?: number; timeoutMs?: number; tag?: string } = {}
): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const jitter = Math.floor(Math.random() * baseDelayMs);
    const delay = i === 0 ? 0 : baseDelayMs * 2 ** (i - 1) + jitter;
    if (delay) await sleep(delay);

    const { signal, clear } = withTimeout(timeoutMs);
    try {
      const res = await fetch(url, { signal });
      clear();
      if (!res.ok) throw new Error(`${tag}: HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      clear();
      lastErr = e;
      console.log(`[${tag}] attempt ${i + 1}/${attempts} failed:`, (e as Error).message ?? e);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchJsonWithRetry<T>(
  url: string,
  opts?: { attempts?: number; baseDelayMs?: number; timeoutMs?: number; tag?: string }
): Promise<T> {
  const txt = await fetchTextWithRetry(url, { tag: "fetchJson", ...opts });
  try {
    return JSON.parse(txt) as T;
  } catch (e) {
    throw new Error(`fetchJson: invalid JSON (${(e as Error).message})`);
  }
}
// ---- end helpers ----

const snowPiercerShape = JSON.parse(
  fs.readFileSync("./snowPiercer.json", "utf8")
);
const snowPiercerShapeLength = length(snowPiercerShape);

const calculateSnowPiercerPosition = (time: Date) => {
  const timesAround = Math.abs(
    Number(
      (
        ((time.valueOf() -
          new Date(new Date().toISOString().split("T")[0]).getTime()) /
          (1000 * 60 * 60 * 6)) %
        1
      ).toFixed(4)
    )
  );
  const distanceOnShape = snowPiercerShapeLength * timesAround;

  const point = along(snowPiercerShape, distanceOnShape);

  return point;
};

let staleData = {
  avgLastUpdate: 0,
  activeTrains: 0,
  stale: false,
};

let shitsFucked = false;
let providerStatus = {
  AMTK: {
    avgLastUpdate: 0,
    activeTrains: 0,
    stale: true,
    ok: false,
    lastUpdated: null as string | null,
  },
  VIA: {
    avgLastUpdate: 0,
    activeTrains: 0,
    stale: true,
    ok: false,
    lastUpdated: null as string | null,
  },
  BLNE: {
    avgLastUpdate: 0,
    activeTrains: 0,
    stale: true,
    ok: false,
    lastUpdated: null as string | null,
  },
};

const amtrakTrainsURL =
  "https://maps.amtrak.com/services/MapDataService/trains/getTrainsData";
const amtrakStationsURL =
  "https://maps.amtrak.com/services/MapDataService/stations/trainStations";
const sValue = "9a3686ac";
const iValue = "c6eb2f7f5c4740c1a2f708fefd947d39";
const publicKey = "69af143c-e8cf-47f8-bf09-fc1f61e5cc33";
const masterSegment = 88;

const viaURL = "https://tsimobile.viarail.ca/data/allData.json";

const amtrakerCache = new cache();
let decryptedTrainData = "";
let decryptedStationData = "";
let AllTTMTrains = "";
let trainPlatforms = {};
let brightlineData = {};
let brightlinePlatforms = {};
let updateTrainsInProgress = false;
const viaLastKnownCoords: Record<string, [number, number]> = {};

//https://stackoverflow.com/questions/196972/convert-string-to-title-case-with-javascript
const title = (str: string) => {
  return str.replace(
    /\w\S*/g,
    (text) => text.charAt(0).toUpperCase() + text.substring(1).toLowerCase()
  );
};

const normalizeViaStationName = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const viaStationCodeFromName = (stationName: string | undefined) => {
  if (!stationName) return undefined;

  const normalizedStationName = normalizeViaStationName(stationName);

  return Object.entries(stationMetaData.viaStationNames).find(
    ([, name]) => normalizeViaStationName(name) === normalizedStationName
  )?.[0];
};

type ViaGtfsStop = {
  stop_id: string;
  stop_code: string;
  stop_name: string;
  stop_timezone: string;
};

type ViaGtfsTrip = {
  route_id: string;
  service_id: string;
  trip_id: string;
  trip_short_name: string;
  trip_headsign: string;
};

type ViaGtfsStopTime = {
  trip_id: string;
  arrival_time: string;
  departure_time: string;
  stop_id: string;
  stop_sequence: string;
};

type ViaGtfsCalendar = {
  service_id: string;
  start_date: string;
  end_date: string;
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
};

type ViaGtfsCalendarDate = {
  service_id: string;
  date: string;
  exception_type: string;
};

type ViaGtfsScheduledStop = {
  code: string;
  name: string;
  tz: string;
  schArr?: string;
  schDep?: string;
  sequence: number;
};

const parseCsv = (content: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  const headers = rows.shift() ?? [];
  return rows
    .filter((r) => r.some((value) => value !== ""))
    .map((r) =>
      Object.fromEntries(headers.map((header, i) => [header, r[i] ?? ""]))
    );
};

const readViaGtfsCsv = <T>(filename: string) =>
  parseCsv(
    fs.readFileSync(`./data/viarail-gtfs/${filename}`, { encoding: "utf8" })
  ) as T[];

const viaGtfsAgencyTimezone = "America/Toronto";
const viaGtfsStops = readViaGtfsCsv<ViaGtfsStop>("stops.txt");
const viaGtfsTrips = readViaGtfsCsv<ViaGtfsTrip>("trips.txt");
const viaGtfsStopTimes = readViaGtfsCsv<ViaGtfsStopTime>("stop_times.txt");
const viaGtfsCalendar = readViaGtfsCsv<ViaGtfsCalendar>("calendar.txt");
const viaGtfsCalendarDates =
  readViaGtfsCsv<ViaGtfsCalendarDate>("calendar_dates.txt");
const viaGtfsStopsById = Object.fromEntries(
  viaGtfsStops.map((stop) => [stop.stop_id, stop])
);
const viaGtfsStopTimesByTrip = viaGtfsStopTimes.reduce((acc, stopTime) => {
  if (!acc[stopTime.trip_id]) acc[stopTime.trip_id] = [];
  acc[stopTime.trip_id].push(stopTime);
  return acc;
}, {} as Record<string, ViaGtfsStopTime[]>);

const viaGtfsTimeToIso = (
  serviceDate: string,
  gtfsTime: string | undefined
) => {
  if (!serviceDate || !gtfsTime) return undefined;

  const [hours, minutes, seconds] = gtfsTime.split(":").map(Number);
  if ([hours, minutes, seconds].some((value) => Number.isNaN(value))) {
    return undefined;
  }

  return moment
    .tz(serviceDate, "YYYY-MM-DD", viaGtfsAgencyTimezone)
    .startOf("day")
    .add(hours, "hours")
    .add(minutes, "minutes")
    .add(seconds, "seconds")
    .toISOString();
};

const viaGtfsServiceDate = (serviceDate: string) =>
  serviceDate.replace(/-/g, "");

const viaGtfsServiceActive = (serviceId: string, serviceDate: string) => {
  const dateKey = viaGtfsServiceDate(serviceDate);
  const exception = viaGtfsCalendarDates.find(
    (calendarDate) =>
      calendarDate.service_id === serviceId && calendarDate.date === dateKey
  );

  if (exception?.exception_type === "1") return true;
  if (exception?.exception_type === "2") return false;

  const calendar = viaGtfsCalendar.find(
    (service) => service.service_id === serviceId
  );
  if (!calendar || dateKey < calendar.start_date || dateKey > calendar.end_date) {
    return false;
  }

  const dayName = moment
    .tz(serviceDate, "YYYY-MM-DD", viaGtfsAgencyTimezone)
    .format("dddd")
    .toLowerCase() as keyof ViaGtfsCalendar;

  return calendar[dayName] === "1";
};

const findViaGtfsTrip = (rawTrainData: RawViaTrain, trainNum: string) => {
  const shortName = trainNum.split(" ")[0];
  const destination = normalizeViaStationName(rawTrainData.to);
  const candidatesForTrainNumber = viaGtfsTrips.filter(
    (trip) => trip.trip_short_name === shortName
  );
  const candidates =
    candidatesForTrainNumber.filter((trip) =>
      viaGtfsServiceActive(trip.service_id, rawTrainData.instance)
    ) ?? candidatesForTrainNumber;
  const usableCandidates =
    candidates.length > 0 ? candidates : candidatesForTrainNumber;

  return (
    usableCandidates.find(
      (trip) => normalizeViaStationName(trip.trip_headsign) === destination
    ) ?? usableCandidates[0]
  );
};

const getViaGtfsScheduledStops = (
  rawTrainData: RawViaTrain,
  trainNum: string
): ViaGtfsScheduledStop[] => {
  const trip = findViaGtfsTrip(rawTrainData, trainNum);
  if (!trip) return [];

  const serviceDate = rawTrainData.instance;
  return (viaGtfsStopTimesByTrip[trip.trip_id] ?? [])
    .slice()
    .sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence))
    .map((stopTime): ViaGtfsScheduledStop | null => {
      const stop = viaGtfsStopsById[stopTime.stop_id];
      if (!stop?.stop_code) return null;

      const tz =
        stop.stop_timezone ??
        stationMetaData.viatimeZones[stop.stop_code] ??
        "America/Toronto";

      return {
        code: stop.stop_code,
        name: stationMetaData.viaStationNames[stop.stop_code] ?? stop.stop_name,
        tz,
        schArr: viaGtfsTimeToIso(serviceDate, stopTime.arrival_time),
        schDep: viaGtfsTimeToIso(serviceDate, stopTime.departure_time),
        sequence: Number(stopTime.stop_sequence),
      };
    })
    .filter((stop): stop is ViaGtfsScheduledStop => stop !== null);
};

const ccDegToCardinal = (deg) => {
  const fixedDeg = deg - 45 / 2;
  if (fixedDeg < 0) return "N";
  if (fixedDeg < 45) return "NE";
  if (fixedDeg < 90) return "E";
  if (fixedDeg < 135) return "SE";
  if (fixedDeg < 180) return "S";
  if (fixedDeg < 225) return "SW";
  if (fixedDeg < 270) return "W";
  if (fixedDeg <= 315) return "NW";
  return "N";
};

const providerStaleThresholdMs = 1000 * 60 * 15;

const createProviderStatus = () => ({
  AMTK: {
    avgLastUpdate: 0,
    activeTrains: 0,
    stale: true,
    ok: false,
    lastUpdated: null as string | null,
  },
  VIA: {
    avgLastUpdate: 0,
    activeTrains: 0,
    stale: true,
    ok: false,
    lastUpdated: null as string | null,
  },
  BLNE: {
    avgLastUpdate: 0,
    activeTrains: 0,
    stale: true,
    ok: false,
    lastUpdated: null as string | null,
  },
});

const recordFreshness = (
  train: Train,
  nowCleaning: number,
  providerFreshness: ReturnType<typeof createProviderStatus>
) => {
  if (train.trainState !== "Active") return;

  const provider = train.providerShort as keyof ReturnType<typeof createProviderStatus>;
  if (!providerFreshness[provider]) return;

  const lastVal = new Date(train.lastValTS).valueOf();
  if (Number.isNaN(lastVal)) return;

  const age = nowCleaning - lastVal;
  staleData.avgLastUpdate += age;
  staleData.activeTrains++;

  providerFreshness[provider].avgLastUpdate += age;
  providerFreshness[provider].activeTrains++;

  const lastUpdated = providerFreshness[provider].lastUpdated;
  if (!lastUpdated || lastVal > new Date(lastUpdated).valueOf()) {
    providerFreshness[provider].lastUpdated = new Date(lastVal).toISOString();
  }
};

const finalizeProviderStatus = (
  providerFreshness: ReturnType<typeof createProviderStatus>
) => {
  Object.keys(providerFreshness).forEach((provider) => {
    const key = provider as keyof ReturnType<typeof createProviderStatus>;
    const status = providerFreshness[key];

    status.avgLastUpdate =
      status.activeTrains > 0
        ? status.avgLastUpdate / status.activeTrains
        : 0;
    const newestUpdateAge = status.lastUpdated
      ? Date.now() - new Date(status.lastUpdated).valueOf()
      : Infinity;

    status.stale =
      status.activeTrains === 0 ||
      newestUpdateAge > providerStaleThresholdMs;
    status.ok = !status.stale;
  });

  providerStatus = providerFreshness;
};

const countProviderTrains = (trains: TrainResponse, providerShort: string) =>
  Object.values(trains).reduce(
    (sum, trainsForNumber) =>
      sum +
      (trainsForNumber?.filter((train) => train.providerShort === providerShort)
        .length ?? 0),
    0
  );

const mergeCachedProviderTrains = (
  target: TrainResponse,
  cached: TrainResponse,
  providerShort: string,
  nowCleaning: number,
  providerFreshness: ReturnType<typeof createProviderStatus>
) => {
  let merged = 0;

  Object.keys(cached).forEach((trainNum) => {
    const cachedProviderTrains = cached[trainNum]?.filter(
      (train) => train.providerShort === providerShort
    );
    if (!cachedProviderTrains?.length) return;

    if (!target[trainNum]) target[trainNum] = [];

    cachedProviderTrains.forEach((cachedTrain) => {
      if (target[trainNum].some((train) => train.trainID === cachedTrain.trainID)) {
        return;
      }

      target[trainNum].push(cachedTrain);
      recordFreshness(cachedTrain, nowCleaning, providerFreshness);
      merged++;
    });
  });

  if (merged > 0) {
    console.log(`[updateTrains] reused ${merged} cached ${providerShort} trains`);
  }
};

const findCachedTrain = (
  cached: TrainResponse,
  trainNum: string,
  trainID: string
) => cached[trainNum]?.find((train) => train.trainID === trainID);

const decrypt = (content, key) => {
  return crypto.AES.decrypt(
    crypto.lib.CipherParams.create({
      ciphertext: crypto.enc.Base64.parse(content),
    }),
    crypto.PBKDF2(key, crypto.enc.Hex.parse(sValue), {
      keySize: 4,
      iterations: 1e3,
      hasher: crypto.algo.SHA1 // thank you cabalex!
    }),
    { iv: crypto.enc.Hex.parse(iValue) }
  ).toString(crypto.enc.Utf8);
};

const fetchAmtrakTrainsForCleaning = async () => {
  try {
    const url = amtrakTrainsURL + `?${Date.now()}=true`;
    const data = await fetchTextWithRetry(url, {
      attempts: 5,
      baseDelayMs: 600,
      timeoutMs: 9000,
      tag: "amtrakTrains",
    });

    const mainContent = data.substring(0, data.length - masterSegment);
    const encryptedPrivateKey = data.substr(data.length - masterSegment, data.length);
    const privateKey = decrypt(encryptedPrivateKey, publicKey).split("|")[0];
    const decryptedData = decrypt(mainContent, privateKey);

    const parsed = JSON.parse(decryptedData);
    const features = parsed?.features ?? [];
    if (!Array.isArray(features) || features.length === 0) {
      throw new Error("amtrakTrains: empty features");
    }

    decryptedTrainData = JSON.stringify(features);
    return features;
  } catch (e) {
    console.log("[amtrakTrains] failed:", (e as Error).message);
    return [];
  }
};

const fetchAmtrakStationsForCleaning = async () => {
  try {
    const data = await fetchTextWithRetry(amtrakStationsURL + `?${Date.now()}=true`, {
      attempts: 5,
      baseDelayMs: 600,
      timeoutMs: 9000,
      tag: "amtrakStations",
    });

    const mainContent = data.substring(0, data.length - masterSegment);
    const encryptedPrivateKey = data.substr(
      data.length - masterSegment,
      data.length
    );
    const privateKey = decrypt(encryptedPrivateKey, publicKey).split("|")[0];
    const decrypted = decrypt(mainContent, privateKey);

    decryptedStationData = JSON.stringify(
      JSON.parse(decrypted)?.StationsDataResponse
    );

    const parsed = JSON.parse(decrypted);
    const stationsResp = parsed?.StationsDataResponse;
    const features = stationsResp?.features;

    // Keep a useful snapshot
    decryptedStationData = JSON.stringify(stationsResp ?? []);

    return Array.isArray(features) ? features : rawStations.features;
  } catch (e) {
    console.log("[amtrakStations] failed:", (e as Error).message);
    decryptedStationData = JSON.stringify(rawStations.features);
    return rawStations.features;
  }
};

const fetchViaForCleaning = async () => {
  const url = viaURL + `?${Date.now()}=true`;
  try {
    const data = await fetchJsonWithRetry<Record<string, RawViaTrain>>(url, {
      attempts: 5,
      baseDelayMs: 600,
      timeoutMs: 8000,
      tag: "viaAllData",
    });
    // basic sanity check: expect object with keys
    if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
      throw new Error("viaAllData: empty payload");
    }
    return data;
  } catch (e) {
    console.log("[viaAllData] failed:", (e as Error).message);
    return {};
  }
};

// Normalize VIA alerts to match Amtrak-style alerts: [{ message: string }]
const normalizeViaAlerts = (rawTrainData: RawViaTrain) => {
  const rawAlerts = (rawTrainData as any).alerts ?? [];

  return rawAlerts
    .map((alert: any) => {
      const headerEn = alert.header?.en ?? "";
      const headerFr = alert.header?.fr ?? "";
      const descEn = alert.description?.en ?? "";
      const descFr = alert.description?.fr ?? "";

      const header = headerEn || headerFr || "";
      const description = descEn || descFr || "";

      // If both are empty, skip this alert
      if (!header && !description) return null;

      const parts: string[] = [];
      if (header) parts.push(header.trim());
      if (description) parts.push(description.trim());

      const message = parts.join(": ");

      return { message };
    })
    .filter((a: any) => a !== null);
};

const parseDate = (badDate: string | null, code: string | null) => {
  if (code == null) code = "America/New_York";

  if (badDate == null || code == null) return null;
  const timeZone =
    stationMetaData.timeZones[code] ??
    (moment.tz.zone(code) ? code : "America/New_York");

  try {
    const dateArr = badDate.split(" ");
    let MDY = dateArr[0].split("/").map((num) => Number(num));
    let HMS = dateArr[1].split(":").map((num) => Number(num));

    if (dateArr.length == 3 && dateArr[2] == "PM") {
      HMS[0] += 12; //adds 12 hour difference for time zone
    }

    if (dateArr.length == 3 && dateArr[2] == "AM" && HMS[0] == 12) {
      HMS[0] = 0; //12 AM is 0 hour
    }

    if (HMS[0] == 24) {
      HMS[0] = 12;
      //edge case for 12:00pm - 12:59pm
    }

    const month = MDY[0].toString().padStart(2, "0");
    const date = MDY[1].toString().padStart(2, "0");
    const year = MDY[2].toString().padStart(4, "0");

    const hour = HMS[0].toString().padStart(2, "0");
    const minute = HMS[1].toString().padStart(2, "0");
    const second = HMS[2].toString().padStart(2, "0");

    const parsed = moment.tz(
      `${year}-${month}-${date} ${hour}:${minute}:${second}`,
      "YYYY-MM-DD HH:mm:ss",
      timeZone
    );

    if (!parsed.isValid()) {
      throw new Error(`Invalid parsed date for ${badDate} in ${timeZone}`);
    }

    return parsed.format("YYYY-MM-DDTHH:mm:ssZ");
  } catch (e) {
    console.log("Couldn't parse date:", badDate, code);
    return null;
  }
};

const generateCmnt = (
  scheduledDate: string,
  actualDate: string,
  code: string
) => {
  let parsedScheduledDate = parseDate(scheduledDate, code);
  let parsedActualDate = parseDate(actualDate, code);
  let earlyOrLate = moment(parsedScheduledDate).isBefore(parsedActualDate)
    ? "Late"
    : "Early";

  let diff = moment(parsedActualDate).diff(parsedScheduledDate);

  let duration = moment.duration(diff);
  let hrs = duration.hours(),
    mins = duration.minutes();

  let string =
    (hrs > 0 ? Math.abs(hrs) + " Hours, " : "") +
    (Math.abs(mins) + " Minutes ");

  if (mins < 5 && earlyOrLate === "Late") {
    return "On Time";
  } else {
    return string + earlyOrLate;
  }
};

const parseRawStation = (rawStation: RawStation, rawTrainNum: String = "", debug: boolean = false) => {
  let status: StationStatus;
  let arr: string;
  let dep: string;

  const actualCode = amtrakStationCodeReplacements[rawStation.code] ?? rawStation.code;

  if (!rawStation.scharr && !rawStation.postarr) {
    //first station
    if (rawStation.postdep) {
      //has departed
      if (debug) console.log("First station departed:", rawStation.code);
    }
  }

  if (rawStation.estarr == null && rawStation.postarr == null) {
    // is this the first station
    if (rawStation.postdep != null) {
      // if the train has departed
      if (debug) console.log("has departed first station", rawStation.code);
      status = StationStatus.Departed;
      dep = parseDate(rawStation.postdep, rawStation.code);
    } else {
      // if the train hasn't departed
      if (debug) console.log("has not departed first station", rawStation.code);
      status = StationStatus.Station;
      dep = parseDate(rawStation.estdep, rawStation.code);
    }
  } else if (rawStation.postarr == null) {
    // is this the last station
    if (rawStation.postarr != null) {
      // if the train has arrived
      if (debug) console.log("has arrived last station", rawStation.code);
      status = StationStatus.Station;
      arr = parseDate(rawStation.postarr, rawStation.code);
    } else {
      // if the train is enroute
      if (debug) console.log("enroute to last station", rawStation.code);
      status = StationStatus.Enroute;
      arr = parseDate(rawStation.estarr, rawStation.code);
    }
  } else {
    // for all other stations
    if (rawStation.estarr != null && rawStation.estdep != null) {
      // if the train is enroute
      if (debug) console.log("enroute", rawStation.code);
      status = StationStatus.Enroute;
      arr = parseDate(rawStation.estarr, rawStation.code);
      dep = parseDate(rawStation.estdep, rawStation.code);
    } else if (rawStation.postarr != null && rawStation.estdep != null) {
      // if the train has arrived but not departed
      if (debug) console.log("not departed", rawStation.code);
      status = StationStatus.Station;
      arr = parseDate(rawStation.postarr, rawStation.code);
      dep = parseDate(rawStation.estdep, rawStation.code);
    } else if (rawStation.postdep != null || rawStation.postcmnt != null) {
      // if the train has departed
      if (debug) console.log("has departed", rawStation.code);
      status = StationStatus.Departed;
      arr = parseDate(rawStation.postarr, rawStation.code);
      dep = parseDate(rawStation.postdep, rawStation.code);
    } else {
      if (debug) console.log("wtf goin on??????");
      //console.log(rawStation);
    }
  }

  return {
    name: stationMetaData.stationNames[rawStation.code],
    code: actualCode,
    tz: stationMetaData.timeZones[rawStation.code],
    bus: rawStation.bus,
    schArr:
      parseDate(rawStation.scharr, rawStation.code) ??
      parseDate(rawStation.schdep, rawStation.code),
    schDep:
      parseDate(rawStation.schdep, rawStation.code) ??
      parseDate(rawStation.scharr, rawStation.code),
    arr: arr ?? dep,
    dep: dep ?? arr,
    arrCmnt: "",
    depCmnt: "",
    status: status,
    stopIconColor: "#212529",
    platform: trainPlatforms[rawStation.code] && trainPlatforms[rawStation.code][rawTrainNum] ? trainPlatforms[rawStation.code][rawTrainNum] : "",
  } as Station
};

const updateTrains = async () => {
  if (updateTrainsInProgress) {
    console.log("Skipping train refresh: previous update still in progress");
    return;
  }

  updateTrainsInProgress = true;
  const startedAt = Date.now();
  console.log("Updating trains...");
  shitsFucked = false;

  try {
    // getting allttmtrains for ASMAD
    void fetch(
      `https://maps.amtrak.com/services/MapDataService/stations/AllTTMTrains?${Date.now()}=true`
    )
      .then((res) => res.text())
      .then((data) => {
        AllTTMTrains = data;
      })
      .catch(() => {
        console.log("AllTTMTrains fetch error");
      });

    const supportFetchStartedAt = Date.now();

    // Commented out platform fetch to stop depending on platformsapi.amtraker.com.
    // Leave trainPlatforms empty so the rest of the pipeline continues to work.
    // try {
    //   const platformTxt = await fetchTextWithRetry("https://platformsapi.amtraker.com/stations", {
    //     attempts: 5, baseDelayMs: 600, timeoutMs: 8000, tag: "platforms"
    //   });
    //   trainPlatforms = JSON.parse(platformTxt);
    // } catch (e) {
    //   console.log("[platforms] failed:", (e as Error).message);
    //   trainPlatforms = {};
    // }
    trainPlatforms = {};

    let amtrakAlertsData: any = { trains: {} };
    try {
      const alertsTxt = await fetchTextWithRetry("https://ttp-alerts-production.up.railway.app/amtrak_alerts", {
        attempts: 5, baseDelayMs: 600, timeoutMs: 8000, tag: "amtrakAlerts"
      });
      amtrakAlertsData = JSON.parse(alertsTxt);
    } catch (e) {
      console.log("[amtrakAlerts] failed:", (e as Error).message);
    }

    try {
      const blTxt = await fetchTextWithRetry("https://store.transitstat.us/brightline", {
        attempts: 5, baseDelayMs: 600, timeoutMs: 8000, tag: "brightline"
      });
      const rawBrightline = JSON.parse(blTxt);
      // Ensure a safe shape so downstream code never crashes
      brightlineData = rawBrightline['v1'] ?? { trains: {}, stations: {}, lastUpdated: null };
      brightlinePlatforms = rawBrightline['platforms'] ?? {};
    } catch (e) {
      console.log("[brightline] failed:", (e as Error).message);
      // Safe fallback shape
      brightlineData = { trains: {}, stations: {}, lastUpdated: null };
      brightlinePlatforms = {};
    }

    console.log(`[updateTrains] support fetches complete in ${Date.now() - supportFetchStartedAt}ms`);

    let trains: TrainResponse = {};
    let allStations: StationResponse = {};

    const coreFetchStartedAt = Date.now();
    const viaData = await fetchViaForCleaning();
    const viaDataReceivedAt = new Date().toISOString();
    const stationData = await fetchAmtrakStationsForCleaning();
    console.log(`[updateTrains] core fetches complete in ${Date.now() - coreFetchStartedAt}ms`);
    console.log("fetched stations");

    const transformStartedAt = Date.now();
    const cachedTrains = amtrakerCache.getTrains();

    (Array.isArray(stationData) ? stationData : rawStations.features).forEach((station) => {
          const actualCode = amtrakStationCodeReplacements[station.properties.Code] ?? station.properties.Code;

          const stationObj = {
            name: stationMetaData.stationNames[station.properties.Code],
            code: actualCode,
            tz: stationMetaData.timeZones[station.properties.Code],
            lat: station.properties.lat,
            lon: station.properties.lon,
            hasAddress: true,
            address1: station.properties.Address1,
            address2: station.properties.Address2,
            city: station.properties.City,
            state: station.properties.State,
            zip: station.properties.Zipcode,
            trains: [],
          };

          if (!allStations[actualCode]) allStations[actualCode] = stationObj;
          amtrakerCache.setStation(actualCode, stationObj);
        });

    console.log(`[updateTrains] station normalization complete in ${Date.now() - transformStartedAt}ms`);

    const amtrakFetchStartedAt = Date.now();
    const amtrakData = await fetchAmtrakTrainsForCleaning();
    console.log(`[updateTrains] amtrak fetch complete in ${Date.now() - amtrakFetchStartedAt}ms`);
    console.log("fetched trains");
    const nowCleaning: number = new Date().valueOf();
    const viaFetchReturnedEmpty = Object.keys(viaData).length === 0;
    const amtrakFetchReturnedEmpty = amtrakData.length === 0;

    staleData.activeTrains = 0;
    staleData.avgLastUpdate = 0;
    staleData.stale = false;
    const liveProviderStatus = createProviderStatus();

    const brightlineTransformStartedAt = Date.now();
    Object.keys(brightlineData['trains']).forEach((trainNum) => {
  const rawTrainData = brightlineData['trains'][trainNum];

  if (!rawTrainData.realTime) return; // train is scheduled and should not be shown on Amtraker

  const firstStation = rawTrainData['predictions'][0];
  const lastStation = rawTrainData['predictions'].slice(-1)[0];
  const trainEventStation = rawTrainData['predictions'].filter((station) => station.dep >= Date.now())[0] ?? lastStation;

  let train: Train = {
    routeName: 'Brightline',
    trainNum: 'b' + trainNum,
    trainNumRaw: trainNum,
    trainID: 'b' + trainNum + '-' + new Date(firstStation.dep).getDate(),
    lat: rawTrainData['lat'],
    lon: rawTrainData['lon'],
    trainTimely: "",
    iconColor: "#212529",
    textColor: "#ffffff",
    stations: rawTrainData.predictions.map((prediction) => {
      const actualID = 'B' + prediction.stationID;
      if (!allStations[actualID]) {
        allStations[actualID] = {
          name: prediction.stationName,
          code: actualID,
          tz: prediction.tz,
          lat: brightlineData['stations'][prediction['stationID']]['lat'],
          lon: brightlineData['stations'][prediction['stationID']]['lon'],
          hasAddress: false,
          address1: "",
          address2: "",
          city: "",
          state: "",
          zip: 0,
          trains: [],
        }
      }

      allStations[actualID].trains.push(
        'b' + trainNum + '-' + new Date(firstStation.dep).getDate()
      );

      return {
        name: prediction['stationName'],
        code: actualID,
        tz: prediction['tz'],
        bus: false,
        schArr: new Date(prediction['arr'] - prediction['arrDelay']).toISOString(),
        schDep: new Date(prediction['dep'] - prediction['depDelay']).toISOString(),
        arr: new Date(prediction['arr']).toISOString(),
        dep: new Date(prediction['dep']).toISOString(),
        arrCmnt: "",
        depCmnt: "",
        status: prediction['dep'] > Date.valueOf() ? "Departed" : "Enroute",
        stopIconColor: "#212529",
        platform: brightlinePlatforms[prediction.stationID] && brightlinePlatforms[prediction.stationID][trainNum] ? brightlinePlatforms[prediction.stationID][trainNum] : "",
      };
    }),
    heading: ccDegToCardinal(rawTrainData.heading),
    eventCode: 'B' + trainEventStation.stationID,
    eventTZ: trainEventStation.tz,
    eventName: trainEventStation.stationName,
    origCode: 'B' + firstStation.stationID,
    originTZ: firstStation.tz,
    origName: firstStation.stationName,
    destCode: 'B' + lastStation.stationID,
    destTZ: lastStation.tz,
    destName: lastStation.stationName,
    trainState: "Active",
    velocity: 0, // no data unfortunately
    statusMsg: " ",
    createdAt: brightlineData['lastUpdated'] ?? new Date().toISOString(),
    updatedAt: brightlineData['lastUpdated'] ?? new Date().toISOString(),
    lastValTS: brightlineData['lastUpdated'] ?? new Date().toISOString(),
    objectID: Number(trainNum),
    provider: "Brightline",
    providerShort: "BLNE",
    onlyOfTrainNum: true,
    alerts: [],
  };

  const calculatedColors = calculateIconColor(train, allStations);
  train.iconColor = calculatedColors['color'];
  train.textColor = calculatedColors['text'];
  train.stations = train.stations.map((stationRaw) => {
    return {
      ...stationRaw,
      stopIconColor: calculateIconColor(train, allStations, stationRaw.code)['color'],
    }
  });

  if (!trains['b' + trainNum]) trains['b' + trainNum] = [];
  trains['b' + trainNum].push(train);

  recordFreshness(train, nowCleaning, liveProviderStatus);
})
    console.log(`[updateTrains] brightline transform complete in ${Date.now() - brightlineTransformStartedAt}ms`);

    const viaTransformStartedAt = Date.now();
    Object.keys(viaData).forEach((trainNum) => {
      try {
              const rawTrainData = viaData[trainNum];
              const actualTrainNum = "v" + trainNum.split(" ")[0];
              const trainID = `${actualTrainNum}-${rawTrainData.instance.split("-")[2]}`;
              const cachedTrain = findCachedTrain(cachedTrains, actualTrainNum, trainID);
              if (!rawTrainData.departed) return; //train doesn't exist
              if (rawTrainData.arrived) return; // keep completed trips from posing as fresh active data
              if (actualTrainNum == "97" || actualTrainNum == "98") return; //covered by amtrak
              if (!Array.isArray(rawTrainData.times) || rawTrainData.times.length === 0) return;

              const sortedStations = rawTrainData.times.sort(
                (a, b) =>
                  new Date(a.scheduled).valueOf() -
                  new Date(b.scheduled).valueOf()
              );

              const firstStation = sortedStations[0];
              const lastStation = sortedStations[sortedStations.length - 1];
              const viaGtfsScheduledStops = getViaGtfsScheduledStops(rawTrainData, trainNum);
              const liveStationsByCode = new Map(
                sortedStations.map((station) => [station.code, station])
              );
              const stationRows: Array<{
                live?: RawViaTrain["times"][number];
                scheduled?: ViaGtfsScheduledStop;
              }> =
                viaGtfsScheduledStops.length > 0
                  ? [
                      ...viaGtfsScheduledStops.map((scheduled) => ({
                        scheduled,
                        live: liveStationsByCode.get(scheduled.code),
                      })),
                      ...sortedStations
                        .filter(
                          (live) =>
                            !viaGtfsScheduledStops.some(
                              (scheduled) => scheduled.code === live.code
                            )
                        )
                        .map((live) => ({ live })),
                    ]
                  : sortedStations.map((live) => ({ live }));
              const destCode =
                viaStationCodeFromName(rawTrainData.to) ?? lastStation.code;
              const destName =
                stationMetaData.viaStationNames[destCode] ?? title(rawTrainData.to);

// Prefer next non-ARR event, else first with known coords, else first
const trainEventStation =
  sortedStations.find((s) => s.eta !== "ARR")
  ?? sortedStations.find((s) => !!stationMetaData.viaCoords[s.code])
  ?? firstStation;

const eventCode = trainEventStation?.code;
const eventCoords = eventCode ? stationMetaData.viaCoords[eventCode] : undefined;

// 1) Use VIA realtime coords if present (most accurate for in-between positions)
// 2) Else keep the last coords VIA sent for this train if we have them
// 3) Else use the chosen event station coords
// 4) Else fall back to any station we have coords for
// 5) Else [0, 0]
const fromRaw =
  (rawTrainData.lat != null && rawTrainData.lng != null)
    ? [Number(rawTrainData.lat), Number(rawTrainData.lng)] as [number, number]
    : undefined;
if (fromRaw) viaLastKnownCoords[trainID] = fromRaw;
const fromLastKnown = viaLastKnownCoords[trainID];

const fromAnyStation = (() => {
  for (const s of sortedStations) {
    const c = stationMetaData.viaCoords[s.code];
    if (c) return c as [number, number];
  }
  return undefined;
})();

const [safeLat, safeLon] = (fromRaw ?? fromLastKnown ?? eventCoords ?? fromAnyStation ?? [0, 0]) as [number, number];

// Ensure this exists so the map() below can safely update it
let trainDelay = 0;

let train: Train = {
  routeName:
    viaTrainNames[trainNum.split(" ")[0]] ??
    `${title(rawTrainData.from)}-${title(rawTrainData.to)}`,
  trainNum: `${actualTrainNum}`,
  trainNumRaw: trainNum.split(" ")[0],
  trainID,
  lat: safeLat,
  lon: safeLon,
  trainTimely: "",
  iconColor: '#212529',
  textColor: '#ffffff',
  stations: stationRows.map(({ live, scheduled }) => {
    const code = live?.code ?? scheduled?.code ?? "";
    const name =
      stationMetaData.viaStationNames[code] ?? live?.station ?? scheduled?.name ?? code;
    const tz =
      stationMetaData.viatimeZones[code] ?? scheduled?.tz ?? "America/Toronto";

    if (!allStations[code]) {
      allStations[code] = {
        name,
        code,
        tz,
        lat: stationMetaData.viaCoords[code] ? stationMetaData.viaCoords[code][0] : 0,
        lon: stationMetaData.viaCoords[code] ? stationMetaData.viaCoords[code][1] : 0,
        hasAddress: false,
        address1: "",
        address2: "",
        city: "",
        state: "",
        zip: 0,
        trains: [],
      };
    }

    allStations[code].trains.push(
      `${actualTrainNum}-${rawTrainData.instance.split("-")[2]}`
    );

    // Update delay when VIA gives an estimated & scheduled arrival
    if (live?.arrival?.estimated && live?.arrival?.scheduled) {
      trainDelay =
        new Date(live.arrival.estimated).valueOf() -
        new Date(live.arrival.scheduled).valueOf();
    }

    // Safer field access
    const baseArr = live ? (live.arrival ?? live.departure) : undefined;
    const baseDep = live ? (live.departure ?? live.arrival) : undefined;
    const estArr = baseArr?.estimated;
    const estDep = baseDep?.estimated;
    const schArr = baseArr?.scheduled ?? scheduled?.schArr;
    const schDep = baseDep?.scheduled ?? scheduled?.schDep;

    return {
      name,
      code,
      tz,
      bus: false,
      schArr,
      schDep,
      arr:
        live && estArr
          ? estArr
          : live && baseArr?.scheduled
            ? new Date(new Date(baseArr.scheduled).valueOf() + trainDelay).toISOString()
            : undefined,
      dep:
        live && estDep
          ? estDep
          : live && baseDep?.scheduled
            ? new Date(new Date(baseDep.scheduled).valueOf() + trainDelay).toISOString()
            : undefined,
      arrCmnt: "",
      depCmnt: "",
      status: live?.eta === "ARR" ? "Departed" : "Enroute",
      stopIconColor: "#212529",
      platform: "",
    };
  }),
  heading: ccDegToCardinal(rawTrainData.direction),
  eventCode: eventCode ?? firstStation.code,
  eventTZ: (eventCode && stationMetaData.viatimeZones[eventCode]) ?? "America/Toronto",
  eventName: (eventCode && stationMetaData.viaStationNames[eventCode]) ?? (eventCode ?? ""),
  origCode: firstStation.code,
  originTZ: stationMetaData.viatimeZones[firstStation.code] ?? "America/Toronto",
  origName: stationMetaData.viaStationNames[firstStation.code],
  destCode,
  destTZ: stationMetaData.viatimeZones[destCode] ?? "America/Toronto",
  destName,
  trainState: "Active",
  velocity: (rawTrainData.speed ?? 0) * 0.621371,
  statusMsg: " ",
  createdAt: cachedTrain?.createdAt ?? rawTrainData.poll ?? viaDataReceivedAt,
  updatedAt: rawTrainData.poll ?? viaDataReceivedAt,
  lastValTS: rawTrainData.poll ?? viaDataReceivedAt,
  objectID: (rawTrainData as any).OBJECTID,
  provider: "Via",
  providerShort: "VIA",
  onlyOfTrainNum: true,
  alerts: normalizeViaAlerts(rawTrainData),
};

              const calculatedColors = calculateIconColor(train, allStations);
              train.iconColor = calculatedColors['color'];
              train.textColor = calculatedColors['text'];
              train.stations = train.stations.map((stationRaw) => {
                return {
                  ...stationRaw,
                  stopIconColor: calculateIconColor(train, allStations, stationRaw.code)['color'],
                }
              });

              if (!trains[actualTrainNum]) trains[actualTrainNum] = [];
              trains[actualTrainNum].push(train);

              recordFreshness(train, nowCleaning, liveProviderStatus);
      } catch (e) {
        console.log("[viaTransform] failed for train", trainNum, (e as Error).message);
      }
            });
    console.log(`[updateTrains] via transform complete in ${Date.now() - viaTransformStartedAt}ms`);

    const amtrakTransformStartedAt = Date.now();
    amtrakData.forEach((property) => {
      try {
              let rawTrainData = property.properties;

              let rawStations: Array<RawStation> = [];

              for (let i = 1; i < 47; i++) {
                let station = rawTrainData[`Station${i}`];
                if (station == undefined || !station) {
                  continue;
                } else {
                  try {
                    let rawStation = JSON.parse(station);
                    if (rawStation.code === "CBN") continue;
                    rawStations.push(rawStation);
                  } catch (e) {
                    console.log("Error parsing station:", e);
                    continue;
                  }
                }
              }

              let stations = rawStations.map((station) => {
                const actualCode = amtrakStationCodeReplacements[station.code] ?? station.code;

                if (!allStations[actualCode]) {
                  const fallbackStation =
                    amtrakerCache.stationExists(actualCode)
                      ? amtrakerCache.getStation(actualCode)
                      : {
                          name: stationMetaData.stationNames[station.code],
                          code: actualCode,
                          tz: stationMetaData.timeZones[station.code],
                          lat: 0,
                          lon: 0,
                          hasAddress: false,
                          address1: "",
                          address2: "",
                          city: "",
                          state: "",
                          zip: 0,
                          trains: [],
                        };

                  allStations[actualCode] = {
                    ...fallbackStation,
                    trains: [...(fallbackStation?.trains ?? [])],
                  };
                }

                const result = parseRawStation(station, rawTrainData.TrainNum); //, rawTrainData.TrainNum == "784");

                return result;
              });

              if (stations.length === 0) {
                console.log(
                  "No stations found for train:",
                  rawTrainData.TrainNum
                );
                return;
              }

              const enrouteStations = stations.filter(
                (station) =>
                  (station.status === "Enroute" ||
                    station.status === "Station") &&
                  (station.arr || station.dep)
              );

              const trainEventCode = enrouteStations.length == 0 ? stations[stations.length - 1].code : enrouteStations[0].code;
              const actualTrainEventCode = amtrakStationCodeReplacements[trainEventCode] ?? trainEventCode;
              const actualOrigCode = amtrakStationCodeReplacements[rawTrainData.OrigCode] ?? rawTrainData.OrigCode;
              const actualDestCode = amtrakStationCodeReplacements[rawTrainData.DestCode] ?? rawTrainData.DestCode;

              // i hate this more than you do
              const originDateOfMonth = new Intl.DateTimeFormat('en-US',
                {
                  timeZone: stationMetaData.timeZones[rawTrainData.OrigCode],
                  day: 'numeric'
                })
                .format(new Date(
                  stations[0].schDep));

              let train: Train = {
                routeName: trainNames[+rawTrainData.TrainNum]
                  ? trainNames[+rawTrainData.TrainNum]
                  : rawTrainData.RouteName,
                trainNum: `${+rawTrainData.TrainNum}`,
                trainNumRaw: `${+rawTrainData.TrainNum}`,
                trainID: `${+rawTrainData.TrainNum}-${originDateOfMonth}`,
                lat: property.geometry.coordinates[1],
                lon: property.geometry.coordinates[0],
                trainTimely: "",
                iconColor: "#212529",
                textColor: "#ffffff",
                stations: stations,
                heading: rawTrainData.Heading ? rawTrainData.Heading : "N",
                eventCode: actualTrainEventCode,
                eventTZ: stationMetaData.timeZones[trainEventCode],
                eventName: stationMetaData.stationNames[trainEventCode],
                origCode: actualOrigCode,
                originTZ: stationMetaData.timeZones[rawTrainData.OrigCode],
                origName: stationMetaData.stationNames[rawTrainData.OrigCode],
                destCode: actualDestCode,
                destTZ: stationMetaData.timeZones[rawTrainData.DestCode],
                destName: stationMetaData.stationNames[rawTrainData.DestCode],
                trainState: rawTrainData.TrainState,
                velocity: +rawTrainData.Velocity,
                statusMsg:
                  stations.filter(
                    (station) =>
                      !station.arr &&
                      !station.dep &&
                      station.code === trainEventCode
                  ).length > 0
                    ? "SERVICE DISRUPTION"
                    : rawTrainData.StatusMsg,
                createdAt:
                  parseDate(rawTrainData.created_at, "America/New_York") ??
                  parseDate(rawTrainData.updated_at, "America/New_York"),
                updatedAt:
                  parseDate(rawTrainData.updated_at, "America/New_York") ??
                  parseDate(rawTrainData.created_at, "America/New_York"),
                lastValTS:
                  parseDate(rawTrainData.LastValTS, trainEventCode) ??
                  stations[0].schDep,
                objectID: rawTrainData.OBJECTID,
                provider: "Amtrak",
                providerShort: "AMTK",
                onlyOfTrainNum: true,
                alerts: amtrakAlertsData['trains'][`${+rawTrainData.TrainNum}-${originDateOfMonth}`] ?? [],
              };

              const calculatedColors = calculateIconColor(train, allStations);
              train.iconColor = calculatedColors['color'];
              train.textColor = calculatedColors['text'];
              train.stations = train.stations.map((stationRaw) => {
                return {
                  ...stationRaw,
                  stopIconColor: calculateIconColor(train, allStations, stationRaw.code)['color'],
                }
              });

              if (!trains[rawTrainData.TrainNum]) trains[rawTrainData.TrainNum] = [];
              trains[rawTrainData.TrainNum].push(train);

              recordFreshness(train, nowCleaning, liveProviderStatus);
      } catch (e) {
        console.log("[amtrakTransform] failed:", (e as Error).message);
      }
            });
    console.log(`[updateTrains] amtrak transform complete in ${Date.now() - amtrakTransformStartedAt}ms`);

    if (
      (viaFetchReturnedEmpty || countProviderTrains(trains, "VIA") === 0) &&
      countProviderTrains(cachedTrains, "VIA") > 0
    ) {
      mergeCachedProviderTrains(trains, cachedTrains, "VIA", nowCleaning, liveProviderStatus);
    }

    if (
      (amtrakFetchReturnedEmpty || countProviderTrains(trains, "AMTK") === 0) &&
      countProviderTrains(cachedTrains, "AMTK") > 0
    ) {
      mergeCachedProviderTrains(trains, cachedTrains, "AMTK", nowCleaning, liveProviderStatus);
    }

    // setting onlyOfTrainNum and deduplicating at the same time
    const dedupeStartedAt = Date.now();
    Object.keys(trains).forEach((trainNum) => {
              // deduplicating trains with the same ID
              let trainIDs = [];
              trains[trainNum] = trains[trainNum].filter((train) => {
                if (trainIDs.includes(train.trainID)) return false;
                trainIDs.push(train.trainID);
                return true;
              });

              // setting onlyOfTrainNum 
              trains[trainNum].forEach((train, i, arr) => {
                trains[trainNum][i].onlyOfTrainNum = arr.length <= 1; // this should be an == but edge cases be damned
              });
            })
    console.log(`[updateTrains] dedupe complete in ${Date.now() - dedupeStartedAt}ms`);

    console.log(`[updateTrains] transform complete in ${Date.now() - transformStartedAt}ms`);

    staleData.avgLastUpdate =
      staleData.activeTrains > 0
        ? staleData.avgLastUpdate / staleData.activeTrains
        : 0;

    if (staleData.avgLastUpdate > providerStaleThresholdMs) {
      console.log("Data is stale, setting...");
      staleData.stale = true;
    }
    finalizeProviderStatus(liveProviderStatus);

    Object.keys(allStations).forEach((stationKey) => {
      amtrakerCache.setStation(stationKey, allStations[stationKey]);
    });
    console.log(`[updateTrains] station cache swap complete in ${Date.now() - transformStartedAt}ms`);

    // Guard: avoid clobbering last-good cache with an empty/invalid pull
    const trainCount = Object.values(trains).reduce((sum, arr) => sum + (arr?.length ?? 0), 0);
    if (trainCount > 0) {
      amtrakerCache.setTrains(trains);
      console.log(`set trains cache (records=${trainCount})`);
      console.log(`[updateTrains] train cache swap complete in ${Date.now() - transformStartedAt}ms`);
    } else {
      console.log("skip cache update: no trains in pull (keeping last-good)");
      shitsFucked = true;
    }
  } catch (e) {
    console.log("Error updating trains:", e);
    shitsFucked = true;
  } finally {
    console.log(`[updateTrains] total ${Date.now() - startedAt}ms`);
    updateTrainsInProgress = false;
  }
};

updateTrains();

schedule.scheduleJob("*/1 * * * *", updateTrains);

Bun.serve({
  port: process.env.PORT ?? 3001,
  fetch(request) {
    let url = new URL(request.url).pathname;

    console.log(request.url);
    console.log(url);

    if (url.startsWith("/v2")) {
      url = url.replace("/v2", "/v3");
    }

    if (url === "/v3/all") {
      const trains = amtrakerCache.getTrains();
      const stations = amtrakerCache.getStations();
      const ids = amtrakerCache.getIDs();

      return new Response(
        JSON.stringify({
          trains,
          stations,
          ids,
          shitsFucked,
          staleData,
          providerStatus,
        }),
        {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        }
      );
    }

    if (url === "/") {
      return new Response(
        "Welcome to the Amtreker API! Docs should be available at /docs, if I remembered to add them..."
      );
    }

    if (url === "/docs") {
      return Response.redirect("https://github.com/piemadd/amtrak", 302);
    }

    if (url === "/v3") {
      return Response.redirect("/v3/trains", 301);
    }

    if (url === "/v3/shitsfuckedlmao") {
      return new Response(shitsFucked.toString(), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url === "/v3/raw") {
      return new Response(decryptedTrainData, {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url === "/v3/rawStations") {
      return new Response(decryptedStationData, {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url === "/v3/AllTTMTrains") {
      return new Response(AllTTMTrains, {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url === "/v3/stale") {
      return new Response(JSON.stringify(staleData), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url === "/v3/providerStatus") {
      return new Response(JSON.stringify(providerStatus), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url.startsWith("/v3/ids")) {
      console.log("train ids");
      const trainIDs = amtrakerCache.getIDs();
      return new Response(JSON.stringify(trainIDs), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url.startsWith("/v3/trains")) {
      const trainNum = url.split("/")[3];

      const trains = amtrakerCache.getTrains();

      if (trainNum === undefined) {
        console.log("all trains");
        const trainCount = Object.values(trains).reduce(
          (sum, arr) => sum + (arr?.length ?? 0),
          0
        );

        if (trainCount === 0) {
          return new Response(JSON.stringify({ error: "No train data available yet" }), {
            status: 503,
            headers: {
              "Access-Control-Allow-Origin": "*", // CORS
              "content-type": "application/json",
            },
          });
        }

        return new Response(JSON.stringify(trains), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        });
      }

      if (trainNum === "arr") {
        console.log("all trains in an array");
        return new Response(
          JSON.stringify({
            0: Object.values(trains).flatMap((n) => n),
          }),
          {
            headers: {
              "Access-Control-Allow-Origin": "*", // CORS
              "content-type": "application/json",
            },
          }
        );
      }

      console.log("train num", trainNum);

      if (trainNum.split("-").length === 2) {
        const trainsArr = trains[trainNum.split("-")[0]];

        if (trainsArr == undefined) {
          return new Response(JSON.stringify([]), {
            headers: {
              "Access-Control-Allow-Origin": "*", // CORS
              "content-type": "application/json",
            },
          });
        }

        for (let i = 0; i < trainsArr.length; i++) {
          if (trainsArr[i].trainID === trainNum) {
            return new Response(
              JSON.stringify({ [trainNum.split("-")[0]]: [trainsArr[i]] }),
              {
                headers: {
                  "Access-Control-Allow-Origin": "*", // CORS
                  "content-type": "application/json",
                },
              }
            );
          }
        }

        return new Response(JSON.stringify([]), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        });
      }

      if (trains[trainNum] == null) {
        return new Response(JSON.stringify([]), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        });
      }

      return new Response(
        JSON.stringify({
          [trainNum]: trains[trainNum],
        }),
        {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        }
      );
    }

    if (url.startsWith("/v3/stations")) {
      const stationCode = url.split("/")[3];
      const stations = amtrakerCache.getStations();

      if (stationCode === undefined) {
        console.log("stations");
        return new Response(JSON.stringify(stations), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        });
      }

      if (stations[stationCode] == null) {
        return new Response(JSON.stringify([]), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        });
      }

      return new Response(
        JSON.stringify({
          [stationCode]: stations[stationCode],
        }),
        {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        }
      );
    }

    if (url.startsWith("/v3/oembed")) {
      const params = new URL(request.url).searchParams;
      const paramsObj = Object.fromEntries(params.entries());

      if (!paramsObj.url) {paramsObj.url = 'https://amtraker.com/'};

      const requestedURL = new URL(paramsObj.url);
      const processedURL =
        requestedURL.origin + requestedURL.pathname + "?oembed";

      const embedWidth = Math.min(
        paramsObj.maxwidth ? Number(paramsObj.maxwidth) : 1000,
        464
      );
      const embedHeight = Math.min(
        paramsObj.maxheight ? Number(paramsObj.maxheight) : 1000,
        788
      );

      const oembedResponse = {
        type: "rich",
        version: "1.0",
        title: "",
        provider_name: "Amtraker",
        provider_url: "https://amtraker.com",
        cache_age: "180",
        html: `<iframe src="${processedURL}" style="border:0px #ffffff none;" name="amtraker_iframe" scrolling="no" frameborder="0" marginheight="0px" marginwidth="0px" height="${embedHeight}px" width="${embedWidth}px" allowfullscreen></iframe>`,
        width: embedWidth,
        height: embedHeight,
      };

      if (paramsObj.format && paramsObj.format === "xml") {
        const xmlResponse = xmlBuilder.build(oembedResponse);

        return new Response(
          `<?xml version="1.0" encoding="utf-8"?><oembed>${xmlResponse}</oembed>`,
          {
            headers: {
              "Access-Control-Allow-Origin": "*", // CORS
              "content-type": "text/xml+oembed",
            },
          }
        );
      }

      return new Response(JSON.stringify(oembedResponse, null, 2), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json+oembed",
        },
      });
    }

    return new Response("Not found", {
      status: 404,
    });
  },
});
