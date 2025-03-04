import { Train, StationResponse } from "./types/amtraker";
import { trainLengths } from "./data/trains";
import { lineString } from "@turf/helpers";
import length from "@turf/length";

const colors = {
  early: "#2b8a3e",
  onTime: "#1864ab",
  late: "#c60c30",
  default: "#212529",
};

// https://stackoverflow.com/questions/5623838/rgb-to-hex-and-hex-to-rgb
const componentToHex = (c) => {
  const trueValue = Math.min(Math.max(Math.floor(c * 255), 0), 255);
  var hex = trueValue.toString(16);
  return hex.padStart(2, '0');
};

// https://stackoverflow.com/questions/17242144/javascript-convert-hsb-hsv-color-to-rgb-accurately
const hsvToRgb = (h: number, s: number, v: number) => {
  let f = (n, k = (n + h / 60) % 6) => v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
  return `#${componentToHex(f(5))}${componentToHex(f(3))}${componentToHex(f(1))}`;
};

const reinterprolateValue = (x: number, minX: number, maxX: number, minY: number, maxY: number) => (((x - minX) * (maxY - minY)) / (maxX - minX)) + minY;

const calculateColorInRange = (minutesLate, maxMinutesLate) => {
  const actualMinutesLate = Math.min(minutesLate, maxMinutesLate);
  let actualHue = reinterprolateValue(actualMinutesLate, 0, maxMinutesLate, 132, -12);
  let actualSaturation = reinterprolateValue(actualMinutesLate, 0, maxMinutesLate, .69, .94);
  let actualValue = reinterprolateValue(actualMinutesLate, 0, maxMinutesLate, .54, .78);

  if (actualHue < 0) actualHue += 360;

  return hsvToRgb(actualHue, actualSaturation, actualValue);
};

const calculateIconColor = (train: Train, allStations: StationResponse) => {
  if (
    train.trainState.includes("Cancelled") ||
    train.trainState.includes("Completed") ||
    train.trainState.includes("Predeparture")
  ) {
    return '#212529';
  }

  //canadian border crossing shenanigans
  if (train.eventCode == "CBN") {
    const stationCodes = train.stations.map((station) => station.code);
    if (stationCodes.indexOf("NFS") < stationCodes.indexOf("NFL")) {
      train.eventCode = "NFL";
    } else {
      train.eventCode = "NFS";
    }
  }

  const currentStation = train.stations.find(
    (station) => station.code === train.eventCode
  );

  const basicRouteLine = lineString(train.stations.map((station) => [allStations[station.code].lon, allStations[station.code].lat]));
  const trainRouteLength = length(basicRouteLine, { units: 'miles' });

  // these are very similar to what ASM does
  // brightline trains are treated the same as via corridor trains and amtrak acela trains
  let routeMaxTimeFrameLate = 150; // 550+ mile Amtrak

  if (trainRouteLength < 450) routeMaxTimeFrameLate = 120;
  if (trainRouteLength < 350) routeMaxTimeFrameLate = 90;
  if (trainRouteLength < 250) routeMaxTimeFrameLate = 60;

  //route specific
  if (train.provider == 'Via') routeMaxTimeFrameLate = 360;
  if (train.routeName == 'Corridor' || train.routeName == 'Acela' || train.routeName == 'Brightline') routeMaxTimeFrameLate = 60;

  const actual = new Date(currentStation.arr ?? currentStation.dep).valueOf();
  const sched = new Date(currentStation.schArr ?? currentStation.schDep).valueOf();

  const minutesLate = ((actual - sched) / 60000);

  const color = calculateColorInRange(minutesLate, routeMaxTimeFrameLate);
  if (train.trainNum == '97') console.log(color)
  return color;
}

export default calculateIconColor;