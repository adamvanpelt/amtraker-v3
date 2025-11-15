const express = require('express');
const amtrakAlerts = require('./amtrakAlerts');

const app = express();

let alertsCache = {
  trains: {},
  meta: {
    timeUpdated: Date.now(),
    numWithAlerts: 0,
    numWithoutAlerts: 0,
    trainsWithAlerts: [],
    trainsWithoutAlerts: [],
    errorsEncountered: [],
  },
};

const refreshAlerts = async (firstUpdate = false) => {
  try {
    const data = await amtrakAlerts.update({ firstUpdate });
    alertsCache = data;
    console.log('✅ Amtrak alerts updated');
  } catch (e) {
    console.error('❌ Failed to update Amtrak alerts:', e.toString());
  }
};

// initial load
refreshAlerts(true);
// refresh every 5 minutes (tune as needed)
setInterval(() => refreshAlerts(false), 5 * 60 * 1000);

app.get('/amtrak_alerts', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json(alertsCache);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚆 Alerts service listening on port ${PORT}`);
});
