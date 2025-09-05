import express from 'express';

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello World!');
});


const port = parseInt(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`Start on port ${port}`);
});