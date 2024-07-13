const fs = require("fs");
const geoTz = require("geo-tz");

const stations = fs.readFileSync("./viastations.json", "utf-8");

const stationsJSON = JSON.parse(stations);

let parsedStations = {};

stationsJSON.forEach((feature) => {
  const coord = feature.field_coordinates.replace(' ', '').split(',').map((n) => Number(n));
  console.log(feature)

  let tz = geoTz.find(
    ...coord
  );
  parsedStations[feature.title.split(' ')[0]] = tz ?? "Unknown";
});

//console.log(geoTz.find(73.1673, 44.0153));

console.log(JSON.stringify(parsedStations))
