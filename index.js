const puppeteer = require('puppeteer');
const moment = require('moment-timezone')
const {PubSub} = require('@google-cloud/pubsub');
const Firestore = require('@google-cloud/firestore');

function getTable(_selector, _theTab) {
  const theData = document.querySelectorAll(_selector)
  let trackList = []
  // the first three rows are 1) google ads 2) 'New York Penn Station
  // Departures, 3) DEP TO TRK (a.k.k column headers)
  theData.forEach((val, index) => {
    if (index > 2) {
      trackList.push(val)
    }
  })
  let innerTexts = trackList.map(el => el.innerText)
  let finalData = []
  innerTexts.forEach(txt => {
    finalData.push(txt.split(_theTab))
  })
  return finalData
}

function getTimestamp() {
  return moment().tz('America/New_York').format('YYYY-MM-DDTHH:mm')
}

const scrapeAndSend = async (browser, time, stationID) => {
  const page = await browser.newPage();
  await page.goto(`http://dv.njtransit.com/mobile/tid-mobile.aspx?SID=${stationID}`, {
    waitUntil: ['domcontentloaded'],
  });
  const stationSelector = '#GridView1 > tbody > tr'
  await page.waitForSelector(stationSelector)
  let theTab = '	'
  let content = await page.evaluate(getTable, stationSelector, theTab)
  let headers = [['DEP', 'TO', 'TRK', 'LINE', 'TRAIN', 'STATUS']]
  const table = headers.concat(content);
  const theData = { table, time, stationID };
  const data = JSON.stringify(theData, null, 2);
  const topicName = 'njtransit-data';
  const dataBuffer = Buffer.from(data);
  const pubsub = new PubSub();
  const messageId = await pubsub.topic(topicName).publish(dataBuffer);
  console.log(`Message ${messageId} published for stationID ${stationID}.`);
  return theData;
}

const getBrowser = async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  return browser;
}

const getDataFromResults = (results) => {
  const data = {};
  results.forEach(result => {
    const {stationID, table, time} = result;
    data.time = time;
    data[stationID] = table;
  });
  return data;
}

const doTheScraping = async () => {
  const browser = await getBrowser();
  const time = getTimestamp();
  const promises = ['NY', 'NP', 'HB', 'ND'].map(
    stationID => scrapeAndSend(browser, time, stationID)
  );
  try {
    const results = await Promise.all(promises);
    browser.close();
    return getDataFromResults(results);
  } catch (error) {
    console.log(`error from the try: ${error}`);
    browser.close();
    return true;
  }
}

exports.http = async (request, response) => {
  const data = await doTheScraping();
  response.status(200).send(data);
};

exports.scrapeOnSchedule = async (request, response) => {
  const data = await doTheScraping();
  console.log('scrapeOnSchedule finished - results:')
  console.log(JSON.stringify(data, null, 2));
};

exports.event = async (event, callback) => {
  const keys = Object.keys(event);
  const buff = new Buffer(event.data, 'base64');
  const decoded = buff.toString();
  const data = JSON.parse(decoded);
  const { time, table, stationID } = data;
  
  console.log(`callback is: ${JSON.stringify(callback, null, 2)}`);
  const firestore = new Firestore();
  const document = firestore
    .collection('boards')
    .doc(stationID)
    .collection('boards')
    .doc(time);
  const values = [];
  const headerRow = table[0];
  table.slice(1).forEach(row => {
    let newVal = {};
    headerRow.forEach((headerCol, colNum) => {
      newVal[headerCol] = row[colNum];
    });
    values.push(newVal);
  });
  await document.set({ values });
  console.log('Entered new data into the document');
};
