import { Train } from "./types/amtraker";

const colors = {
  early: "#2b8a3e",
  onTime: "#1864ab",
  late: "#c60c30",
  default: "#212529",
};

const toHoursAndMinutesLate = (date1: Date, date2: Date): string => {
  if (
    date1.toString() === "Invalid Date" ||
    date2.toString() === "Invalid Date"
  )
    return "Estimate Error";

  const diff = date1.valueOf() - date2.valueOf();

  if (Math.abs(diff) > 1000 * 60 * 60 * 24) return "Schedule Error";

  const hours = Math.floor(Math.abs(diff) / 1000 / 60 / 60);
  const minutes = Math.floor((Math.abs(diff) / 1000 / 60 / 60 - hours) * 60);

  // creating the text
  let amount = `${Math.abs(hours)}h ${Math.abs(minutes)}m`;
  if (hours === 0) amount = `${Math.abs(minutes)}m`;
  if (minutes === 0) amount = `${Math.abs(hours)}h`;

  //on time
  if (diff === 0) return "On Time";

  //late or early
  return diff > 0 ? `${amount} late` : `${amount} early`;
};

const calculateIconColor = (train: Train) => {
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

  let trainStatus: string = 'Unknown';

  if (currentStation) {
    trainStatus = toHoursAndMinutesLate(
      new Date(currentStation.arr ?? currentStation.dep ?? null),
      new Date(currentStation.schArr ?? currentStation.schDep ?? null)
    );
  }

  const trainNum = train.trainNum ? train.trainNum.toString() : "NULL";

  let trainIconState = "default";

  if (trainStatus) {
    if (trainStatus.includes("early") || trainStatus.includes("On Time")) {
      trainIconState = 'early';
    }

    if (trainStatus.includes("late") || trainStatus.includes("NaN")) {
      trainIconState = 'late';
    }

    if (
      train.trainState.includes("Cancelled") ||
      train.trainState.includes("Completed") ||
      train.trainState.includes("Predeparture") ||
      trainStatus.includes('Unknown')
    ) {
      trainIconState = 'default';
    }
  }

  return colors[trainIconState];
}

export default calculateIconColor;