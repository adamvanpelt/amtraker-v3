import {
  StationMeta,
  StationResponse,
  Train,
  TrainResponse,
} from "./types/amtraker";

export default class cache {
  trains: TrainResponse;
  stations: StationResponse;
  ids: string[];

  constructor() {
    this.trains = {};
    this.stations = {};
    this.ids = [];
    return;
  }

  getIDs() {
    return this.ids;
  }

  getTrains() {
    return this.trains;
  }

  getStation(code: string) {
    return this.stations[code];
  }

  getStations() {
    return this.stations;
  }

  setTrains(data: TrainResponse) {
    console.log("setting trains");
    //fs.writeFileSync('cache.json', JSON.stringify(data, null, 2));

    let tempIDs = [];

    Object.keys(data).forEach((key) => {
      data[key].forEach((train) => {
        train.stations.forEach((station) => {
          const stationData = this.getStation(station.code);
          //console.log(stationData)

          if (stationData && !stationData.trains.includes(train.trainID)) {
            stationData.trains.push(train.trainID);
          }

          this.setStation(station.code, stationData);
        });

        const trainOriginDate = new Date(train.stations[0].schDep);
        const trainOriginMonth = new Intl.DateTimeFormat([], { month: 'numeric', timeZone: train.stations[0].tz }).format(trainOriginDate);
        const trainOriginDay = new Intl.DateTimeFormat([], { day: 'numeric', timeZone: train.stations[0].tz }).format(trainOriginDate);
        const trainOriginYear = new Intl.DateTimeFormat([], { year: '2-digit', timeZone: train.stations[0].tz }).format(trainOriginDate);

        tempIDs.push(`${train.trainNum}-${trainOriginMonth}-${trainOriginDay}-${trainOriginYear}`);
      });
    });

    this.ids = tempIDs;
    this.trains = data;
  }

  setStation(code: string, data: StationMeta) {
    //console.log('setting', code)
    this.stations[code] = data;
  }

  setStations(data: StationResponse) {
    this.stations = data;
  }

  stationExists(code: string) {
    return this.stations[code] !== undefined && this.stations[code] !== null;
  }
}
