import express from 'express';
import axios from 'axios';
import multer from 'multer';
import cours from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer from 'puppeteer';
import { generateHtmlFromJson } from './generateHtml.js';


const app = express();
app.use(express.json());
app.use(cours());


//////////////////////////////
// ランドマーク取得エンドポイント
//////////////////////////////
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


//////////////////////////////
// レシート読取エンドポイント関連
//////////////////////////////
const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

function parseItemsFromJsonText(text) {
  try {
    // Remove Markdown fences if included
    const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const data = JSON.parse(cleaned);

    if (!data || !Array.isArray(data.items)) {
      return null;
    }

    const items = data.items
      .filter(it => it && typeof it.name === 'string' && (typeof it.amount === 'number' || typeof it.amount === 'string'))
      .map(it => ({
        name: it.name.trim(),
        amount: typeof it.amount === 'number' ? it.amount : Number(String(it.amount).replace(/[^0-9.\-]/g, ''))
      }))
      .filter(it => it.name && Number.isFinite(it.amount));
    const storeNameRaw = data.storeName || data.store || data.shop || data['店舗名'] || data['店名'];
    const storeName = typeof storeNameRaw === 'string' ? storeNameRaw.trim() : undefined;
    return items.length ? { items, storeName } : null;
  } catch {
    return null;
  }
}

// レシート読取エンドポイント本体
app.post('/receipt', uploadReceipt.single('receipt'), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server misconfiguration: GEMINI_API_KEY is not set' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Bad Request: receipt image is required (field name: receipt)' });
    }
    if (!allowedImageTypes.has(file.mimetype)) {
      return res.status(400).json({ error: `Bad Request: unsupported image type (${file.mimetype})` });
    }

    const base64 = file.buffer.toString('base64');

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0,
        maxOutputTokens: 2048
      }
    });

    const prompt = [
      'レシート画像から、店舗名(storeName) と 商品名・金額(items) を抽出し、JSONのみで出力してください。',
      'フォーマット例: {"storeName":"◯◯店","items":[{"name":"コーヒー","amount":300}]}',
      '条件: キーは storeName, items/name/amount。通貨はJPYとして amount は数値(円)。',
      '余計な文章・説明・コードブロックは一切出力しないこと。'
    ].join('\n');

    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType: file.mimetype } },
      { text: prompt }
    ]);
    const resp = result?.response;
    let text = resp?.text?.() ?? '';
    if (!text && resp?.candidates?.[0]?.content?.parts) {
      text = resp.candidates[0].content.parts
        .map(p => p?.text)
        .filter(Boolean)
        .join('')
        .trim();
    }

    const parsed = parseItemsFromJsonText(text);

    if (!parsed) {
      return res.status(422).json({
        error: 'Unprocessable Entity: failed to extract items from receipt',
        details: process.env.NODE_ENV !== 'production' ? {
          finishReason: resp?.candidates?.[0]?.finishReason,
          promptFeedback: resp?.promptFeedback || null
        } : undefined
      });
    }

    return res.status(200).json(parsed);
  } catch (error) {
    console.error('Error extracting receipt:', error);
    if (error?.status === 400) {
      return res.status(400).json({ error: 'Bad Request' });
    }
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});


//////////////////////////////
// pdf返却エンドポイント関連
//////////////////////////////
const upload = multer({ storage: multer.memoryStorage() }); // メモリ上に保存

// HTML文字列からPDFを生成する関数
async function htmlToPdf(htmlString) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setContent(htmlString, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({ format: 'A5' });
  await browser.close();
  return pdfBuffer;
}

// 本番用pdf返却エンドポイント
app.post(`/`, upload.fields([
  { name: 'images', maxCount: 10 },
  { name: `detailJson`, maxCount: 1 }
]), async (req, res) => {
  try {
    const requestFiles = req.files;
    const generatedHtml = generateHtmlFromJson(requestFiles.detailJson ? JSON.parse(requestFiles.detailJson[0].buffer.toString()) : {});

    htmlToPdf(generatedHtml).then(data => {
      res.set('Content-disposition', 'attachment; filename="shiori.pdf"');
      res.contentType("application/pdf");
      res.send(data);
    }).catch(async err => {
      console.error('Error generating PDF file:', err);
      res.status(500).send('Internal Server Error: Unable to generate PDF file');
    });
} catch (error) { 
    console.error('Error processing data:', error);
    res.status(500).send('Bad Request: Error processing data');
  }
});

// テスト用PDF返却エンドポイント
app.get('/pdf', (req, res) => {
  htmlToPdf(sampleHtml).then(data => {
    res.set('Content-disposition', 'attachment; filename="sample.pdf"');
    res.contentType("application/pdf");
    res.send(data);
  }).catch(async err => {
    console.error('Error generating PDF file:', err);
    res.status(500).send('Internal Server Error: Unable to generate PDF file');
  });
});


//////////////////////////////
// サーバ起動
//////////////////////////////
const port = parseInt(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`Start on port ${port}`);
});
