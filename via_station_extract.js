const fs = require('fs');

const file = fs.readFileSync('./viastations.txt', { encoding: "utf8" });

let names = {};
let timezones = {};
let coords = {};

const rows = file.split('\r\n');

console.log(rows)
console.log(rows.length)

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];

  if (i === 0) continue;

  const rowSplit = row.split(',');

  names[rowSplit[1]] = rowSplit[2];
  timezones[rowSplit[1]] = rowSplit[6];
  coords[rowSplit[1]] = [rowSplit[5], rowSplit[4]];

  console.log(rowSplit)
}

console.log(JSON.stringify(names))
console.log(JSON.stringify(timezones))
console.log(JSON.stringify(coords))
