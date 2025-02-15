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
import cache from "./cache";

const rawStations = JSON.parse(fs.readFileSync("./rawStations.json", { encoding: "utf8" }));

import length from "@turf/length";
import along from "@turf/along";
import calculateIconColor from "./calculateIconColor";

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
let shitsFuckedSource = "";

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

//https://stackoverflow.com/questions/196972/convert-string-to-title-case-with-javascript
const title = (str: string) => {
  return str.replace(
    /\w\S*/g,
    (text) => text.charAt(0).toUpperCase() + text.substring(1).toLowerCase()
  );
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

const decrypt = (content, key) => {
  return crypto.AES.decrypt(
    crypto.lib.CipherParams.create({
      ciphertext: crypto.enc.Base64.parse(content),
    }),
    crypto.PBKDF2(key, crypto.enc.Hex.parse(sValue), {
      keySize: 4,
      iterations: 1e3,
    }),
    { iv: crypto.enc.Hex.parse(iValue) }
  ).toString(crypto.enc.Utf8);
};

const fetchAmtrakTrainsForCleaning = async () => {
  const response = await fetch(amtrakTrainsURL + `?${Date.now()}=true`);
  const data = await response.text();

  console.log("fetch in t");

  const mainContent = data.substring(0, data.length - masterSegment);
  const encryptedPrivateKey = data.substr(
    data.length - masterSegment,
    data.length
  );
  const privateKey = decrypt(encryptedPrivateKey, publicKey).split("|")[0];
  const decryptedData = decrypt(mainContent, privateKey);

  console.log("dec in t");

  //console.log(decryptedTrainData);

  try {
    decryptedTrainData = JSON.stringify(JSON.parse(decryptedData).features);

    return JSON.parse(decryptedData).features;
  } catch (e) {
    shitsFucked = true;
    shitsFuckedSource = "Amtrak";
    return [];
  }
};

const fetchAmtrakStationsForCleaning = async () => {
  const response = await fetch(amtrakStationsURL + `?${Date.now()}=true`);
  const data = await response.text();

  const mainContent = data.substring(0, data.length - masterSegment);
  const encryptedPrivateKey = data.substr(
    data.length - masterSegment,
    data.length
  );
  const privateKey = decrypt(encryptedPrivateKey, publicKey).split("|")[0];
  const decrypted = decrypt(mainContent, privateKey);

  try {
    decryptedStationData = JSON.stringify(
      JSON.parse(decrypted)?.StationsDataResponse
    );

    return decrypted.length > 0
      ? JSON.parse(decrypted)?.StationsDataResponse?.features
      : rawStations.features;
  } catch (e) {
    //console.log("stations e:", e.toString());
    decryptedStationData = JSON.stringify(rawStations.features);
    return rawStations.features;
  }
};

const fetchViaForCleaning = async () => {
  try {
    const response = await fetch(viaURL + `?${Date.now()}=true`);
    const data = await response.json();

    return data;
  } catch (e) {
    console.log(e);
    throw new Error('VIA');
    return {};
  }
};

const parseDate = (badDate: string | null, code: string | null) => {
  if (code == null) code = "America/New_York";

  if (badDate == null || code == null) return null;

  //first is standard time, second is daylight savings
  const offsets = {
    "America/New_York": ["-05:00", "-04:00"],
    "America/Detroit": ["-05:00", "-04:00"],
    "America/Chicago": ["-06:00", "-05:00"],
    "America/Denver": ["-07:00", "-06:00"],
    "America/Phoenix": ["-07:00", "-07:00"],
    "America/Los_Angeles": ["-08:00", "-07:00"],
    "America/Boise": ["-07:00", "-06:00"],
    "America/Toronto": ["-05:00", "-04:00"],
    "America/Indiana/Indianapolis": ["-05:00", "-04:00"],
    "America/Kentucky/Louisville": ["-05:00", "-04:00"],
    "America/Vancouver": ["-08:00", "-07:00"],
  };

  const timeZone = stationMetaData.timeZones[code] ?? "America/New_York";

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

    const now = new Date();
    const nowYear = now.getFullYear();
    let dst_start = new Date(nowYear, 2, 14);
    let dst_end = new Date(nowYear, 10, 7);
    dst_start.setDate(14 - dst_start.getDay()); // adjust date to 2nd Sunday
    dst_end.setDate(7 - dst_end.getDay()); // adjust date to the 1st Sunday

    const isDST = Number(now >= dst_start && now < dst_end);

    return `${year}-${month}-${date}T${hour}:${minute}:${second}${offsets[timeZone][isDST]}`;
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

  if (!rawStation.scharr && !rawStation.postarr) {
    //first station
    if (rawStation.postdep) {
      //has departed
      if (debug) console.log("First station departed:", rawStation.code);
    }
  }

  if (debug && (rawStation.code === "OXN" || rawStation.code === "SBA"))
    console.log(rawStation);

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
    code: rawStation.code,
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
    platform: trainPlatforms[rawStation.code] && trainPlatforms[rawStation.code][rawTrainNum] ? trainPlatforms[rawStation.code][rawTrainNum] : "",
  } as Station;
};

const updateTrains = async () => {
  console.log("Updating trains...");
  shitsFucked = false;
  shitsFuckedSource = "";

  // getting allttmtrains for ASMAD
  fetch(
    `https://maps.amtrak.com/services/MapDataService/stations/AllTTMTrains?${Date.now()}=true`
  )
    .then((res) => res.text())
    .then((data) => {
      AllTTMTrains = data;
    })
    .catch((e) => {
      console.log("AllTTMTrains fetch error");
    });

  const platformRes = await fetch("https://platformsapi.amtraker.com/stations");
  try {
    trainPlatforms = await platformRes.json();
  } catch (e) {
    trainPlatforms = {};
  }

  const brightlineRes = await fetch('https://store.transitstat.us/brightline');
  const rawBrightline = await brightlineRes.json();
  brightlineData = rawBrightline['v1'];
  brightlinePlatforms = rawBrightline['platforms'];

  fetchViaForCleaning()
    .then((viaData) => {
      fetchAmtrakStationsForCleaning().then((stationData) => {
        console.log("fetched s");
        stationData.forEach((station) => {
          amtrakerCache.setStation(station.properties.Code, {
            name: stationMetaData.stationNames[station.properties.Code],
            code: station.properties.Code,
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
          });
        });

        fetchAmtrakTrainsForCleaning()
          .then((amtrakData) => {
            console.log("fetched t");
            const nowCleaning: number = new Date().valueOf();

            staleData.activeTrains = 0;
            staleData.avgLastUpdate = 0;
            staleData.stale = false;

            let trains: TrainResponse = {};
            let allStations: StationResponse = {};

            Object.keys(brightlineData['trains']).forEach((trainNum) => {
              const rawTrainData = brightlineData['trains'][trainNum];
              const firstStation = rawTrainData['predictions'][0];
              const lastStation = rawTrainData['predictions'].slice(-1)[0];
              const trainEventStation = rawTrainData['predictions'].filter((station) => station.dep >= Date.now())[0] ?? lastStation;

              let train: Train = {
                routeName: 'Brightline',
                trainNum: 'b' + trainNum,
                trainID: 'b' + trainNum + '-' + new Date(firstStation.dep).getDate(),
                lat: rawTrainData['lat'],
                lon: rawTrainData['lon'],
                trainTimely: "",
                iconColor: "#212529",
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
              };

              train.iconColor = calculateIconColor(train);

              if (!trains['b' + trainNum]) trains['b' + trainNum] = [];
              trains['b' + trainNum].push(train);

              if (train.trainState === "Active") {
                staleData.avgLastUpdate +=
                  nowCleaning - new Date(train.updatedAt).valueOf();
                staleData.activeTrains++;
              }
            })

            Object.keys(viaData).forEach((trainNum) => {
              const rawTrainData = viaData[trainNum];
              const actualTrainNum = "v" + trainNum.split(" ")[0];
              if (!rawTrainData.departed) return; //train doesn't exist
              if (actualTrainNum == "97" || actualTrainNum == "98") return; //covered by amtrak

              const sortedStations = rawTrainData.times.sort(
                (a, b) =>
                  new Date(a.scheduled).valueOf() -
                  new Date(b.scheduled).valueOf()
              );

              const firstStation = sortedStations[0];
              const lastStation = sortedStations[sortedStations.length - 1];
              const trainEventStation =
                sortedStations.find((station) => station.eta !== "ARR") ??
                firstStation;

              let trainDelay = 0;

              let train: Train = {
                routeName:
                  viaTrainNames[trainNum.split(" ")[0]] ??
                  `${title(rawTrainData.from)}-${title(rawTrainData.to)}`,
                trainNum: `${actualTrainNum}`,
                trainID: `${actualTrainNum}-${rawTrainData.instance.split("-")[2]
                  }`,
                lat:
                  rawTrainData.lat ??
                  stationMetaData.viaCoords[firstStation.code][0],
                lon:
                  rawTrainData.lng ??
                  stationMetaData.viaCoords[firstStation.code][1],
                trainTimely: "",
                iconColor: '#212529',
                stations: sortedStations.map((station) => {
                  if (!allStations[station.code]) {
                    allStations[station.code] = {
                      name: stationMetaData.viaStationNames[station.code],
                      code: station.code,
                      tz: stationMetaData.viatimeZones[station.code] ?? "America/Toronto",
                      lat: stationMetaData.viaCoords[station.code] ? stationMetaData.viaCoords[station.code][0] : 0,
                      lon: stationMetaData.viaCoords[station.code] ? stationMetaData.viaCoords[station.code][1] : 0,
                      hasAddress: false,
                      address1: "",
                      address2: "",
                      city: "",
                      state: "",
                      zip: 0,
                      trains: [],
                    };
                  }

                  allStations[station.code].trains.push(
                    `${actualTrainNum}-${rawTrainData.instance.split("-")[2]}`
                  );

                  if (station.arrival && station.arrival.estimated) {
                    trainDelay =
                      new Date(station.arrival.estimated).valueOf() -
                      new Date(station.arrival.scheduled).valueOf();
                  }

                  const estArr = (station.arrival ?? station.departure)
                    .estimated;
                  const estDep = (station.departure ?? station.arrival)
                    .estimated;

                  return {
                    name: stationMetaData.viaStationNames[station.code],
                    code: station.code,
                    tz: stationMetaData.viatimeZones[station.code],
                    bus: false,
                    schArr: (station.arrival ?? station.departure).scheduled,
                    schDep: (station.departure ?? station.arrival).scheduled,
                    arr:
                      estArr ??
                      new Date(
                        new Date(
                          (station.arrival ?? station.departure).scheduled
                        ).valueOf() + trainDelay
                      ),
                    dep:
                      estDep ??
                      new Date(
                        new Date(
                          (station.departure ?? station.arrival).scheduled
                        ).valueOf() + trainDelay
                      ),
                    arrCmnt: "",
                    depCmnt: "",
                    status: station.eta === "ARR" ? "Departed" : "Enroute",
                    platform: "",
                  };
                }),
                heading: ccDegToCardinal(rawTrainData.direction),
                eventCode: trainEventStation.code,
                eventTZ: stationMetaData.viatimeZones[trainEventStation.code],
                eventName: trainEventStation.code,
                origCode: firstStation.code,
                originTZ: stationMetaData.viatimeZones[firstStation.code],
                origName: stationMetaData.viaStationNames[firstStation.code],
                destCode: lastStation.code,
                destTZ: stationMetaData.viatimeZones[lastStation.code],
                destName: stationMetaData.viaStationNames[lastStation.code],
                trainState: "Active",
                velocity: (rawTrainData.speed ?? 0) * 0.621371, // i love metric lol
                statusMsg: " ",
                createdAt: rawTrainData.poll ?? new Date().toISOString(),
                updatedAt: rawTrainData.poll ?? new Date().toISOString(),
                lastValTS: rawTrainData.poll ?? new Date().toISOString(),
                objectID: rawTrainData.OBJECTID,
                provider: "Via",
              };

              train.iconColor = calculateIconColor(train);

              if (!trains[actualTrainNum]) trains[actualTrainNum] = [];
              trains[actualTrainNum].push(train);

              if (train.trainState === "Active") {
                staleData.avgLastUpdate +=
                  nowCleaning - new Date(train.updatedAt).valueOf();
                staleData.activeTrains++;
              }
            });

            amtrakData.forEach((property) => {
              let rawTrainData = property.properties;
              //console.log(property)

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
                if (!allStations[station.code]) {
                  if (!amtrakerCache.stationExists(station.code)) {
                    amtrakerCache.setStation(station.code, {
                      name: stationMetaData.stationNames[station.code],
                      code: station.code,
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
                    });
                  }
                }

                const result = parseRawStation(station, rawTrainData.TrainNum); //, rawTrainData.TrainNum == "784");

                return result;
              });

              let stationsFixed = stations.map((station, i, arr) => {
                if (!station.arr && !station.dep) {
                  if (i === 0) return station; //cant really fix this

                  const lastStation = arr[i - 1];
                  if (!lastStation.dep && !lastStation.schDep) return station; //dont have the data
                }
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
              const trainEventCode =
                enrouteStations.length === 0
                  ? stations[stations.length - 1].code
                  : enrouteStations[0].code;

              let train: Train = {
                routeName: trainNames[+rawTrainData.TrainNum]
                  ? trainNames[+rawTrainData.TrainNum]
                  : rawTrainData.RouteName,
                trainNum: `${+rawTrainData.TrainNum}`,
                trainID: `${+rawTrainData.TrainNum}-${new Date(
                  stations[0].schDep
                ).getDate()}`,
                lat: property.geometry.coordinates[1],
                lon: property.geometry.coordinates[0],
                trainTimely: "",
                iconColor: "#212529",
                stations: stations,
                heading: rawTrainData.Heading ? rawTrainData.Heading : "N",
                eventCode: trainEventCode,
                eventTZ: stationMetaData.timeZones[trainEventCode],
                eventName: stationMetaData.stationNames[trainEventCode],
                origCode: rawTrainData.OrigCode,
                originTZ: stationMetaData.timeZones[rawTrainData.OrigCode],
                origName: stationMetaData.stationNames[rawTrainData.OrigCode],
                destCode: rawTrainData.DestCode,
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
              };

              train.iconColor = calculateIconColor(train);

              if (!trains[rawTrainData.TrainNum])
                trains[rawTrainData.TrainNum] = [];
              trains[rawTrainData.TrainNum].push(train);

              if (train.trainState === "Active") {
                staleData.avgLastUpdate +=
                  nowCleaning - new Date(train.updatedAt).valueOf();
                staleData.activeTrains++;
              }
            });

            staleData.avgLastUpdate =
              staleData.avgLastUpdate / staleData.activeTrains;

            if (staleData.avgLastUpdate > 1000 * 60 * 20) {
              console.log("Data is stale, setting...");
              staleData.stale = true;
            }

            Object.keys(allStations).forEach((stationKey) => {
              amtrakerCache.setStation(stationKey, allStations[stationKey]);
            });

            amtrakerCache.setTrains(trains);
            console.log("set trains cache");
          })
          .catch((e) => {
            console.log("Error fetching train data:", e);
            shitsFucked = true;
          });
      });
    })
    .catch((e) => {
      console.log("Error fetching station data:", e);
      shitsFucked = true;
    });
};

updateTrains();

schedule.scheduleJob("*/5 * * * *", updateTrains);

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
