import express from 'express';
import axios from 'axios';
import multer from 'multer';

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() }); // メモリ上に保存

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

app.post(``, upload.fields([
  { name: 'images', maxCount: 10 },
  { name: `detailJson`, maxCount: 1 }
]), async (req, res) => {
  try {
    const requestFiles = req.files;
    console.log('Received files:', requestFiles);
    res.status(200).json({ imageName: requestFiles.images.map(file => file.originalname), detailJson: requestFiles.detailJson ? requestFiles.detailJson[0].buffer.toString() : null });
} catch (error) { 
    console.error('Error processing data:', error);
    res.status(500).send('Bad Request: Error processing data');
  }
});

const port = parseInt(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`Start on port ${port}`);
});