import { Train, StationResponse, Station } from "./types/amtraker";
import { lineString } from "@turf/helpers";
import length from "@turf/length";

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

const calculateColorInRange = (minutesLate: number, maxMinutesLate: number) => {
  const actualMinutesLate = Math.min(Math.max(minutesLate, 0), maxMinutesLate);

  const colorPercents = [
    {
      minutes: 0,
      hsv: [132, 0.69, 0.54]
    },
    {
      minutes: maxMinutesLate * 0.25,
      hsv: [35, 0.93, 0.54]
    },
    {
      minutes: maxMinutesLate,
      hsv: [-12, 0.94, 0.78]
    }
  ];

  let lowPointIndex = 0;
  let highPointIndex = colorPercents.length - 1;

  for (let i = 0; i < colorPercents.length; i++) {
    const point = colorPercents[i];

    if (point.minutes < minutesLate) lowPointIndex = i;
    if (point.minutes >= minutesLate) {
      highPointIndex = i;
      break;
    }

    if (i == colorPercents.length - 1) highPointIndex = i; // has to be the high point
  };

  const lowPoint = colorPercents[lowPointIndex];
  const highPoint = colorPercents[highPointIndex];

  if (lowPoint.minutes == highPoint.minutes) return hsvToRgb(lowPoint.hsv[0], lowPoint.hsv[1], lowPoint.hsv[2]);

  let actualHue = reinterprolateValue(actualMinutesLate, lowPoint.minutes, highPoint.minutes, lowPoint.hsv[0], highPoint.hsv[0]);
  let actualSaturation = reinterprolateValue(actualMinutesLate, lowPoint.minutes, highPoint.minutes, lowPoint.hsv[1], highPoint.hsv[1]);
  let actualValue = reinterprolateValue(actualMinutesLate, lowPoint.minutes, highPoint.minutes, lowPoint.hsv[2], highPoint.hsv[2]);

  // fallback
  // NaN really only appears at the if above, but im not trying to be too careful
  if (
    isNaN(actualHue) ||
    isNaN(actualSaturation) ||
    isNaN(actualValue)
  ) return "#f542d7"; // return hsvToRgb(lowPoint.hsv[0], lowPoint.hsv[1], lowPoint.hsv[2]);

  if (actualHue < 0) actualHue += 360;

  return hsvToRgb(actualHue, actualSaturation, actualValue);
};

const calculateIconColor = (train: Train, allStations: StationResponse, activeStationOverride: string = null) => {
  if (
    !activeStationOverride && (
      train.trainState.includes("Cancelled") ||
      train.trainState.includes("Completed") ||
      train.trainState.includes("Predeparture")
    )
  ) {
    return '#212529';
  }

  let eventCode = train.eventCode;

  if (activeStationOverride) eventCode = activeStationOverride;

  //canadian border crossing shenanigans
  if (eventCode == "CBN") {
    const stationCodes = train.stations.map((station) => station.code);
    if (stationCodes.indexOf("NFS") < stationCodes.indexOf("NFL")) {
      eventCode = "NFL";
    } else {
      eventCode = "NFS";
    }
  }

  const currentStation = train.stations.find(
    (station) => station.code === eventCode
  );

  try {
    if (train.stations.length == 1) {
      train.stations = [train.stations[0], train.stations[0]] // bruh
    }

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

    if (isNaN(minutesLate)) return '#212529';

    const color = calculateColorInRange(minutesLate, routeMaxTimeFrameLate);

    return color;
  } catch (e) {
    console.log('calculating train color error:', train)
    return '#212529';
  }
};

export default calculateIconColor;