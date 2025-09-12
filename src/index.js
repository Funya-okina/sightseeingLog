import express from 'express';
import axios from 'axios';
import multer from 'multer';
import cours from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer from 'puppeteer';
import OpenAI from 'openai';

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
        maxOutputTokens: 10000
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
// openAIクライアント取得
const openAiClient = new OpenAI();

// Puppeteer ブラウザをプロセス内で使い回す
const browserPromise = puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

// PDF 同時実行を抑制（簡易セマフォ）
let pdfInFlight = 0;
const PDF_MAX_CONCURRENCY = 2;
const waitShort = () => new Promise(r => setTimeout(r, 50));
async function withPdfSlot(task) {
  while (pdfInFlight >= PDF_MAX_CONCURRENCY) {
    await waitShort();
  }
  pdfInFlight++;
  try {
    return await task();
  } finally {
    pdfInFlight--;
  }
}

// 表紙取得関数
async function generateCoverImage(inputImageData) {
  const prompt =
    `#ミッション 
    画像から特徴的な部分を抽出し、以下を生成してください。 
    ・単色の色紙に黒ボールペンで描いたような、小学生の修学旅行のしおり表紙。 

    ＃ポイント 
    ・大きな手書き文字で「修学旅行」と書かれている。 
    ・子どもの落書き風に、画像の特徴部分と、楽しそうな児童やかわいい動物（くま・うさぎ・とり）を描く。 
    ・生成する画像は短辺:長辺=1:√2となる縦長の画像とすること
    ・線はガタガタで素朴、小学生が描いたようなノートの落書き風。
    `;

  const inputImageBase64 = Buffer.isBuffer(inputImageData)
    ? inputImageData.toString('base64')
    : Buffer.from(inputImageData).toString('base64');

  const response = await openAiClient.responses.create({
    model: "gpt-4o",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_image",
            image_url: `data:image/jpeg;base64,${inputImageBase64}`,
          }
        ],
      },
    ],
    tools: [{ type: "image_generation" }],
  });

  const imageData = response.output
    .filter((output) => output.type === "image_generation_call")
    .map((output) => output.result);

  console.log('GenerateCoverImage Done:');

  if (imageData.length > 0) {
    const imageBase64 = imageData[0];
    return imageBase64;
  } else {
    throw new Error("Image generation failed");
  }
}

// HTML文字列からPDFを生成する関数
async function htmlToPdf(htmlString) {
  const browser = await browserPromise;
  const page = await browser.newPage();
  try {
    await page.setContent(htmlString, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    const pdfBuffer = await page.pdf({ format: 'A5' });
    console.log('GeneratePDF Done:');
    return pdfBuffer;
  } finally {
    try { await page.close(); } catch {}
  }
}

// 画像生成のタイムアウト付きラッパ
async function generateCoverImageWithTimeout(inputImageData, timeoutMs = 150000) {
  console.time('cover');
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  try {
    const result = await Promise.race([
      generateCoverImage(inputImageData),
      timer
    ]);
    return result; // null の場合はフォールバック扱い
  } finally {
    console.timeEnd('cover');
  }
}

const upload = multer({ storage: multer.memoryStorage() }); // メモリ上に保存

// 旅行の感想 生成関数（Gemini）
async function generateImpression(detailJson) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'text/plain',
      temperature: 0.7,
      maxOutputTokens: 10000,
    }
  });

  const trip = detailJson.trip;
  const allowance = trip.allowance;
  const allowanceTotal = allowance.reduce((sum, a) => sum + (Number(a.total) || 0), 0);
  const members = trip.members
    .map(member => `${member.name}${member.role ? `（${member.role}）` : ''}${member.episode ? `（${member.episode}）` : ''}`)
    .join('、');
  const hotels = trip.hotels.filter(Boolean).join('、');
  const places = detailJson.images.map(image => image.placeName).filter(Boolean).join(' → ');
  const allowanceDetails = allowance
    .map(a => {
      const n = a.name;
      const amount = `${a.amount}円`;
      return n ? `${n}(${amount})` : amount;
    })

  const prompt = [
    'あなたは小学6年生です。これから、学校の「旅行のしおり」にのせる短い感想文を書きます。',
    '下のデータだけを使って、作り話はせず、300〜500文字で日本語の感想を書いてください。',
    '短めの文で、やさしい言葉を中心に、前向きな気持ちが伝わるようにします。段落を2〜4つに分けてください。',
    '',
    '[旅行データの要約（入力から作成）]',
    `${trip.purpose ? "・目的: " + trip.purpose : ''}`,
    `・期間: ${trip.startDate} 〜 ${trip.endDate}`,
    `${hotels.length ? "・宿泊先: " + hotels : ''}`,
    `・参加メンバー: ${members}`,
    `${places ? '・主な訪問地: ' + places : ''}`,
    `・おこづかいメモ: 合計 ${allowanceTotal} 円、主な内訳 ${allowanceDetails}`,
    '',
    '[元データ（そのまま）]',
    JSON.stringify(detailJson, null, 2),
    '',
    '出力は本文のみを書き、タイトルは不要です。'
  ].join('\n');

  const result = await model.generateContent([{ text: prompt }]);
  const resp = result?.response;
  let text = resp?.text?.() ?? '';
  if (!text && resp?.candidates?.[0]?.content?.parts) {
    text = resp.candidates[0].content.parts
      .map(p => p?.text)
      .filter(Boolean)
      .join('')
      .trim();
  }
  return (text || '').trim();
}

// 日程生成関数
/**
 * Generate itinerary using Gemini API
 * @param {Array<{dateTime: string, placeName: string}>} inputList
 * @returns {Promise<{days: {date: string, details: {startTime: string, place: string}[]}[]}>}
 */
const generateIntinerary = async (inputList) => {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
      maxOutputTokens: 16384,
    }
  });

  // Prompt (English variable names, Japanese instructions)
  const prompt = [
    '以下のsightseeing placesリストから、dateTimeの日にちごとにグループ化した一日の行程を作成してください。',
    '出力は必ず次の構造のJSON形式で返してください。',
    '[出力例]',
    '{ "days": [ { "date": "2025-09-12", "details": [ { "startTime": "09:00", "place": "東京タワー" }, { "startTime": "13:00", "place": "浅草寺" } ] } ] }',
    '[入力リスト]',
    JSON.stringify(inputList, null, 2),
    '[制約]',
    '- 各dateごとに、placeを時系列で並べてください。',
    '- details各項目のstartTimeはdateTimeの時間から1時間以内にしてください。',
    '- details各項目のstartTimeはJST（UTC+9）で出力してください。',
    '- details各項目のstartTimeは30分区切りの時間を出力してください（例: 09:00, 13:30, 15:30, 18:00 など）',
    '- JSONのみを出力し、余計な説明やテキストは一切含めないでください。',
  ].join('\n');

  const result = await model.generateContent([{ text: prompt }]);
  const resp = result?.response;
  let text = resp?.text?.() ?? '';
  if (!text && resp?.candidates?.[0]?.content?.parts) {
    text = resp.candidates[0].content.parts
      .map(p => p?.text)
      .filter(Boolean)
      .join('')
      .trim();
  }
  // JSONパース
  try {
    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
    return parsed;
  } catch (e) {
    throw new Error('Gemini APIからの応答のパースに失敗しました: ' + text);
  }
};

  // 本番用pdf返却エンドポイント
app.post(`/`, upload.fields([
  { name: 'images', maxCount: 10 },
  { name: `detailJson`, maxCount: 1 }
]), async (req, res) => {
  try {
    // このルートは重い可能性があるためレスポンスのタイムアウトを延長
    res.setTimeout(180000);

    const requestFiles = req.files;

    console.time('html');
    const detailObj = requestFiles.detailJson ? JSON.parse(requestFiles.detailJson[0].buffer.toString()) : {};
    const intineraryData = await generateIntinerary(detailObj.images ? detailObj.images : []);
    const coverImage = await generateCoverImageWithTimeout(
      requestFiles.images && requestFiles.images[0] ? requestFiles.images[0].buffer : null
    );
    const impressionText = await generateImpression(detailObj);
    const generatedHtml = generateHtmlFromJson(detailObj, coverImage, intineraryData, impressionText);
    console.timeEnd('html');

    console.time('pdf');
    const pdfData = await withPdfSlot(() => htmlToPdf(generatedHtml));
    console.timeEnd('pdf');

    res.set('Content-disposition', 'attachment; filename="shiori.pdf"');
    res.contentType("application/pdf");
    res.send(pdfData);
  } catch (error) { 
    console.error('Error processing data:', error);
    res.status(500).send('Bad Request: Error processing data');
  }
});


//////////////////////////////
// サーバ起動
//////////////////////////////
const port = parseInt(process.env.PORT) || 8080;
const server = app.listen(port, () => {
  console.log(`Start on port ${port}`);
});
// タイムアウト設定（インフラ側でも適切に調整すること）
server.headersTimeout = 120000; // ヘッダ読み取り上限
server.requestTimeout = 0;      // 全体リクエストのタイムアウト無効化（プロキシ側で制御）
server.keepAliveTimeout = 60000;
