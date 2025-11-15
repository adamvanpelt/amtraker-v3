const fs = require('fs');
const nodeFetch = require('node-fetch'); // need a separate instance of fetch because reasons

const sleep = ms => new Promise(r => setTimeout(r, ms));

const blobsToRemove = [
  "Please standby for further information.",
  "We apologize for the inconvenience and thank you for your patience.",
  "For customers waiting to board this train, please be aware that departure estimates are subject to change.",
  "If conditions allow, a train delayed past its scheduled departure time may leave earlier than the updated estimate.",
  "To avoid missing your train, please stay near the boarding area and monitor for announcements or updates.",
  "We appreciate your continued patience and apologize for the delay.",
  "We sincerely apologize for the delay and appreciate your continued patience.",
  "We thank you for your patience and will provide updates as more information becomes available.",
  "If a train is delayed past its scheduled departure time, it may still leave earlier than the updated estimate, if conditions allow.",
  "For customers still waiting to board this train, departure estimates are subject to change.",
  "We sincerely apologize for any inconvenience.",
  "We sincerely appreciate your continued patience and apologize for the lengthy delay.",
  "We apologize for the delay.",
  "We apologize for any inconvenience this may cause.",
  "We sincerely appreciate your patience and apologize for the delay.",
  "We sincerely appreciate your continued patience and apologize for any inconvenience this has caused.",
  "We appreciate your patience during this process and are committed to providing additional details as soon as they become available.",
  "We sincerely apologize for the lengthy delay and appreciate your continued patience.",
  "We sincerely apologize for the extensive delay and appreciate your continued patience.",
  "Updates to come."
];

// VIA Rail 4-letter station codes → Amtrak 3-letter station codes
const viaToAmtrakStationMap = {
  MTRL: "MTR",
  TRTO: "TWO",
  VCVR: "VAC",
};

const extractAlertsFromTrain = (train) => {
  let alertTextsRaw = [];
  let alertTextsComparable = [];
  for (let i = 0; i < train.stops.length; i++) {
    //if (i > 0) continue; // seemingly the same alert is posted, just multiple times?
    const stop = train.stops[i];
    let stopStatusInfo = null;
    if (stop.arrival?.statusInfo) stopStatusInfo = stop.arrival.statusInfo;
    if (stop.departure?.statusInfo) stopStatusInfo = stop.departure.statusInfo;

    if (!stopStatusInfo || !stopStatusInfo.detailedMessage) continue;

    let message = stopStatusInfo.detailedMessage.split('\n')[0];

    const comparableMessage = message
      .replace(/\d+\:\d+ [AP]M [ECMP]T/, '')
      .replace(/\d+ hours( and \d+ minutes)/, '');

    if (!alertTextsComparable.includes(comparableMessage)) {
      for (let i = 0; i < blobsToRemove.length; i++) {
        message = message.replace(blobsToRemove[i], '');
      }
      message = message.trim();

      if (message.length > 0) {
        alertTextsRaw.push({
          message,
        });
        alertTextsComparable.push(comparableMessage);
      }
    }
  }

  return alertTextsRaw;
};

const updateFeed = async (updateConfig) => {
  const now = Date.now();
  try {
    let responseObject = {
      trains: {},
      meta: {
        timeUpdated: now,
        numWithAlerts: 0,
        numWithoutAlerts: 0,
        trainsWithAlerts: [],
        trainsWithoutAlerts: [],
        errorsEncountered: [],
      },
    };

    // 1) Get list of active train IDs from YOUR Amtraker instance
    //    e.g. ["22-11-15-25", "6-11-14-25", ...]
    let trainIDs = await fetch('https://ttp-amtraker.up.railway.app/v3/ids').then((res) => res.json());

    // Normalize in case /v3/ids ever returns a non-array structure
    if (!Array.isArray(trainIDs)) {
      console.log('[alerts] /v3/ids returned non-array, attempting to normalize');
      if (trainIDs && typeof trainIDs === 'object') {
        // e.g. { "0": "22-11-15-25", "1": "6-11-14-25", ... }
        trainIDs = Object.values(trainIDs).flat();
      } else {
        trainIDs = [];
      }
    }

    if (trainIDs.length === 0) {
      console.log('[alerts] No train IDs returned from /v3/ids');
    } else {
      console.log(`[alerts] Retrieved ${trainIDs.length} train IDs from /v3/ids`);
    }

    // Keep this setup call as in the original script
    const setupFetchRes = await nodeFetch("https://www.amtrak.com/eymoNXDNm7bbwqa38ydg/3aO5GVz2f06z3X/XmE7QS8hAQ/WQE8U14D/NEE", {
      "credentials": "include",
      "headers": {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        "CSRF-Token": "undefined",
        "Content-Type": "text/plain;charset=UTF-8",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Priority": "u=0",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache"
      },
      "referrer": "https://www.amtrak.com/home.html",
      "body": "{}",
      "method": "POST",
      "mode": "cors"
    });

    for (let i = 0; i < trainIDs.length; i++) {
      const trainID = trainIDs[i];

      if (trainID.startsWith('v') || trainID.startsWith('b')) continue; // not amtrak

      const splitID = trainID.split('-');

      const trainNum = splitID[0]; // e.g. "22"
      const trainDate = `20${splitID[3]}-${splitID[1].padStart(2, '0')}-${splitID[2].padStart(2, '0')}`; // YYYY-MM-DD
      const shortID = `${trainNum}-${splitID[2]}`; // initial guess, e.g. "22-15"
      const timeBeforeFetch = Date.now();

      // 2) Fetch train details from your Railway Amtraker instance
      //    Use the *short* ID (trainNum-dayOfMonth), e.g. /v3/trains/22-15
      let destCode = null;
      try {
        const trainDetailRes = await fetch(`https://ttp-amtraker.up.railway.app/v3/trains/${shortID}`)
          .then((res) => res.json());

        // trainDetailRes should look like { "22": [ { destCode: "...", ... }, ... ] }
        const trainsForNum = trainDetailRes[trainNum];
        if (Array.isArray(trainsForNum) && trainsForNum.length > 0) {
          destCode = trainsForNum[0].destCode || trainsForNum[0].dest?.code || null;
        }
      } catch (e) {
        console.log('error fetching train details for', shortID, e.toString());
      }

      if (!destCode) {
        // If we can't determine a destination station, record an error and skip
        responseObject.meta.errorsEncountered.push({
          trainID: shortID,
          code: 'NO_DEST_CODE',
          message: `Could not determine destination station for train ${trainID}`,
        });
        continue;
      }

      // Normalize to a 3-letter Amtrak station code when possible.
      // If we see a VIA 4-letter code (MTRL, TRTO, VCVR, etc.), map it.
      let amtrakDestCode = destCode;
      if (viaToAmtrakStationMap[destCode]) {
        amtrakDestCode = viaToAmtrakStationMap[destCode];
      }

      // Guard: only query Amtrak with valid 3-letter codes
      if (!amtrakDestCode || amtrakDestCode.length !== 3) {
        console.log('[alerts] skipping non-Amtrak dest code', destCode, '→', amtrakDestCode, 'for', shortID);
        responseObject.meta.errorsEncountered.push({
          trainID: shortID,
          code: 'NON_AMTRAK_DEST_CODE',
          message: `Destination station code ${destCode} could not be normalized to a 3-letter Amtrak code`,
        });
        continue;
      }

      // 3) Call the Amtrak endpoint using the (normalized) destination station code
      //    /dotcom/travel-service/statuses/stops/{amtrakDestCode}?service-numbers={trainNum}&departure-date={trainDate}
      const amtrakURL = `https://www.amtrak.com/dotcom/travel-service/statuses/stops/${amtrakDestCode}?service-numbers=${trainNum}&departure-date=${trainDate}`;

      const trainDataRes = await fetch(amtrakURL, {
        "credentials": "include",
        "headers": {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.5",
          "Content-Type": "application/json",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "Pragma": "no-cache",
          "Cache-Control": "no-cache"
        },
        "referrer": "https://www.amtrak.com/tickets/train-status.html",
        "method": "GET",
        "mode": "cors"
      })
        .then((res) => res.json())
        .catch((e) => {
          console.log('error fetching alerts for amtrak train', trainNum, trainDate, e.toString());
          return { error: { message: e.toString() } };
        });

      // New JSON shape: { data: [ stop, stop, ... ] }
      if (!trainDataRes || !Array.isArray(trainDataRes.data) || trainDataRes.data.length === 0) {
        responseObject.meta.errorsEncountered.push({
          trainID: shortID,
          ...(trainDataRes && trainDataRes.error ? trainDataRes.error : {}),
        });
        continue;
      }

      // ---- Date-aware but *non-fatal* logic ----
      let finalShortID = shortID;
      let stopsForThisTrain = trainDataRes.data;

      try {
        // Prefer only the records whose travelService.date matches our trainDate
        const sameServiceDateStops = trainDataRes.data.filter(
          (s) => s.travelService && s.travelService.date === trainDate
        );

        if (sameServiceDateStops.length > 0) {
          stopsForThisTrain = sameServiceDateStops;

          const svcDateStr = sameServiceDateStops[0].travelService.date; // e.g. "2025-11-14"
          const svcDate = new Date(svcDateStr);
          if (!isNaN(svcDate.getTime())) {
            const svcDay = svcDate.getDate(); // 14 or 15
            const recomputedShortID = `${trainNum}-${svcDay}`;

            if (recomputedShortID !== shortID) {
              console.log(
                `[alerts] remapped ${shortID} → ${recomputedShortID} using travelService.date=${svcDateStr}`
              );
            }

            finalShortID = recomputedShortID;
          }
        } else {
          // No exact date match – log but keep all records and keep the original key
          console.log(
            `[alerts] no stops with travelService.date === ${trainDate} for ${shortID}; using all ${stopsForThisTrain.length} records and keeping key ${finalShortID}`
          );
        }
      } catch (e) {
        console.log(
          '[alerts] failed to apply date-aware logic for',
          shortID,
          e.toString()
        );
      }
      // ---- End date-aware logic ----

      // Adapt to existing extractor, which expects train.stops[]
      const alerts = extractAlertsFromTrain({ stops: stopsForThisTrain });

      if (alerts.length > 0) {
        responseObject.trains[finalShortID] = alerts;
        responseObject.meta.numWithAlerts++;
        responseObject.meta.trainsWithAlerts.push(finalShortID);
      } else {
        responseObject.meta.numWithoutAlerts++;
        responseObject.meta.trainsWithoutAlerts.push(finalShortID);
      }

      // NOTE: original code didn't await this sleep, so leaving behavior unchanged
      sleep(Date.now() - timeBeforeFetch + 250 + 25); // making sure the time between now and when we started the fetch has been at least 250ms, but doing 275 for safety
    }

    console.log(`Finished updating Amtrak Alerts`);
    return responseObject;
  } catch (e) {
    console.log('Error with Amtrak Alerts');
    const errorMessage = e.message;
    const errorString = e.toString();

    if (updateConfig.firstUpdate) {
      const initialStateText = await fetch('https://store.transitstat.us/amtrak_alerts').then((res) => res.text());
      if (initialStateText !== 'Not found' && !initialStateText.startsWith('no available server')) return JSON.parse(initialStateText);
    }

    return {
      trains: {},
      meta: {
        timeUpdated: now,
        numWithAlerts: 0,
        numWithoutAlerts: 0,
        trainsWithAlerts: [],
        trainsWithoutAlerts: [],
        errorsEncountered: [{
          trainID: 'all',
          code: 'ERROR_CATCH',
          message: errorString,
          detailedMessage: errorMessage,
          businessMessage: '',
        }],
      },
    };
  }
};

exports.update = updateFeed;