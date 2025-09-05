import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

app.get('/landmarkData', async (req, res) => {
  const gpsInfo = req.query.lat && req.query.lon
  ? {
    latitude: req.query.lat,
    longitude: req.query.lon,
  }
  : null;

  if (gpsInfo !== null) {
    try {
      const response = await axios.get(
        `https://map.yahooapis.jp/placeinfo/V1/get?lat=${gpsInfo.latitude}&lon=${gpsInfo.longitude}&appid=${process.env.YAHOO_API_KEY}&output=json`);
      res.json(response.data);
    } catch (error) {
      console.error('Error fetching data:', error);
      res.status(500).send('Bad Request: Error fetching data from external API');
    }
  } else {
    res.status(400).send('Bad Request: Missing latitude or longitude parameters');
  }
});


const port = parseInt(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`Start on port ${port}`);
});