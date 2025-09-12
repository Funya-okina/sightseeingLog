/**
 * inputJsonの内容をtemplateHtmlに埋め込んだHTMLを返す
 * @param {object} json 入力データ
 * @param {string} [base64Image] Base64エンコードされた画像データ
 * @returns {string} HTML文字列
 */
export function generateHtmlFromJson(json, base64Image) {
  // tripオブジェクト内にデータがある場合は取り出す
  const trip = json && typeof json === 'object' && json.trip ? json.trip : json;

  // 必須項目名の正規化
  const get = (obj, key) => obj[key] ?? obj[key + '!'] ?? obj[key && typeof key === 'string' ? key.replace(/!$/, '') : key];

  // 日程・宿泊先
  const rawStartDate = get(trip, 'startDate');
  const rawEndDate = get(trip, 'endDate');

  function toValidDate(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function getJpCalParts(d) {
    const fmt = new Intl.DateTimeFormat('ja-JP-u-ca-japanese', {
      timeZone: 'Asia/Tokyo',
      era: 'long',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    });
    const parts = fmt.formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    return {
      era: parts.era, // 例: "令和"
      year: parts.year, // 例: "6"
      month: parts.month, // 例: "9"
      day: parts.day, // 例: "12"
      weekday: parts.weekday, // 例: "木"
    };
  }

  function formatRange(startRaw, endRaw) {
    const sd = toValidDate(startRaw);
    const ed = toValidDate(endRaw);
    if (!sd && !ed) return '';

    if (sd && ed) {
      const sp = getJpCalParts(sd);
      const ep = getJpCalParts(ed);
      const startStr = `${sp.era}${sp.year}年${sp.month}月${sp.day}日(${sp.weekday})`;
      const endStr = sp.month === ep.month
        ? `${ep.day}日(${ep.weekday})`
        : `${ep.month}月${ep.day}日(${ep.weekday})`;
      return `${startStr}〜${endStr}`;
    }

    const p = getJpCalParts(sd || ed);
    return `${p.era}${p.year}年${p.month}月${p.day}日(${p.weekday})`;
  }

  const scheduleText = formatRange(rawStartDate, rawEndDate);
  const hotelsArr = get(trip, 'hotels');
  const hotels = Array.isArray(hotelsArr) ? hotelsArr.join(' / ') : undefined;

  // 目的
  const purpose = get(trip, 'purpose');

  // 参加者
  const membersArr = get(trip, 'members');
  let membersRows = '';
  if (Array.isArray(membersArr)) {
    const roleMap = {
      leader: '班長',
      camera: 'カメラ係',
      accountant: 'お財布係',
      navigator: '案内係',
      driver: '運転係',
      reservation: '予約係'
    };

    const processed = membersArr.map(m => {
      const name = get(m, 'name');
      if (!name) return null;
      const episode = get(m, 'episode');
      const rawRole = get(m, 'role');
      return { name, episode, rawRole };
    }).filter(Boolean);

    const anyProvidedRole = processed.some(p => {
      const v = p.rawRole;
      return v != null && String(v).trim() !== '';
    });

    membersRows = processed.map((p, idx) => {
      let roleJp = '班員';
      if (anyProvidedRole) {
        const key = String(p.rawRole || '').trim();
        if (key) roleJp = roleMap[key] || '班員';
      } else {
        roleJp = idx === 0 ? '班長' : '班員';
      }
      return `<tr><td>${p.name}</td><td>${roleJp}</td><td>${p.episode || ''}</td></tr>`;
    }).join('');
  }

  // 予算
  const allowanceArr = get(trip, 'allowance');
  let budgetRows = '';
  let total = 0;
  if (Array.isArray(allowanceArr)) {
    budgetRows = allowanceArr.map(a => {
      const title = get(a, 'title');
      const totalVal = get(a, 'total');
      const detailsArr = get(a, 'details');
      let details = '';
      if (Array.isArray(detailsArr)) {
        details = detailsArr.map(d => {
          const dname = get(d, 'name');
          const damount = get(d, 'amount');
          if (!dname || damount == null) return '';
          return `${dname}…… ${damount}円`;
        }).filter(Boolean).join('<br>');
      }
      if (!title || totalVal == null) return '';
      total += Number(totalVal) || 0;
      return `<tr><td>${title}</td><td>${details}</td><td class="money">${totalVal}円</td></tr>`;
    }).filter(Boolean).join('');

    console.log('Generate HTML Done');
  }

  // =========================
  // 行程（場所と時系列）生成
  // =========================
  console.time('itinerary');
  const imagesMeta = Array.isArray(json?.images) ? json.images : [];
  const events = [];
  for (let i = 0; i < imagesMeta.length; i++) {
    const m = imagesMeta[i] || {};
    const clientId = get(m, 'clientId');
    const rawPlaceName = get(m, 'placeName');
    const placeName = rawPlaceName || '（場所不明）';
    const rawDt = get(m, 'dateTime');
    let dt = null;
    if (typeof rawDt === 'string') {
      const d = new Date(rawDt);
      if (!isNaN(d.getTime())) dt = d;
    }

    // JSTでの表示用日付・時刻
    let ymd = null;
    let hm = '—';
    let ts = null;
    if (dt) {
      try {
        const dateFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
        const timeFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
        const dParts = dateFmt.formatToParts(dt).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
        ymd = `${dParts.year}/${dParts.month}/${dParts.day}`;
        hm = timeFmt.format(dt);
        ts = dt.getTime();
      } catch {}
    }

    // 表示ルール: 時間も場所も取得できていない要素は表示しない
    const hasTime = !!dt;
    const hasPlace = typeof rawPlaceName === 'string' && rawPlaceName.trim() !== '';
    if (!hasTime && !hasPlace) continue;

    events.push({
      clientId, placeName, ymd, hm, ts, uploadIndex: i
    });
  }

  // グルーピング（ymdなしは"日付不明"）
  const groups = new Map();
  for (const ev of events) {
    const key = ev.ymd || '日付不明';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  // グループキーの並び順（年月日昇順、日付不明は最後）
  const keys = Array.from(groups.keys());
  keys.sort((a, b) => {
    if (a === '日付不明') return 1;
    if (b === '日付不明') return -1;
    // YYYY/MM/DD を数値比較
    const na = Number(a.replaceAll('/', ''));
    const nb = Number(b.replaceAll('/', ''));
    return na - nb;
  });

  // 各日の中を ts → uploadIndex で昇順
  for (const k of keys) {
    groups.get(k).sort((x, y) => {
      const xt = x.ts ?? Infinity;
      const yt = y.ts ?? Infinity;
      if (xt !== yt) return xt - yt;
      return x.uploadIndex - y.uploadIndex;
    });
  }

  // 描画用HTML
  let itineraryHtml = '';
  if (keys.length) {
    let inner = '';
    for (const k of keys) {
      const list = groups.get(k);
      if (!list || list.length === 0) continue; // 念のため空グループはスキップ
      inner += `
    <h3 class=\"sticker\">${k}</h3>
    <ul>
      ${list.map(ev => `<li><span class=\"time\">${ev.hm}</span><span class=\"dot\">……</span><span class=\"place\">${ev.placeName}</span></li>`).join('\n      ')}
    </ul>`;
    }
    if (inner.trim()) {
      itineraryHtml = `
      <section class="section sheet">
        <h2>行程</h2>
        <div class="itinerary">${inner}
        </div>
      </section>`;
    }
  }
  console.timeEnd('itinerary');

  // HTML生成
  return `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>修学旅行のしおり</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    /* ======== 基本設定 ======== */
    :root{
      --ink:#000;
      --warn:#dc5a3a;             /* 強調色（注意・警戒） */
      --accent:#2e7d32;           /* 見出し・罫線のアクセント（深緑） */
    }
    body{
      margin:0; color:var(--ink);
      background:#fff;
      font-family:
        "Hiragino Maru Gothic ProN",
        "BIZ UDGothic",
        "Kosugi Maru",
        "Yu Gothic",
        "Noto Sans JP",
        "Hiragino Kaku Gothic ProN",
        Meiryo,
        sans-serif;
      line-height:1.6; font-size:12pt;
    }

    /* @page rule is defined below for A5 */
    @media print{
      body{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }
      .no-print{ display:none !important; }
      .page-footer{ position:fixed; bottom:8mm; left:0; right:0; text-align:center; font-size:10pt; color:#444; }
    }

    h2{
      margin:1.2em 0 .8em;
      font-size:16pt;
      font-weight:700;
      text-align:left;
      border-bottom:2px solid var(--accent);
      padding-bottom:4px;
    }

    .section{
      margin:20px 0;
      page-break-before:always;
    }

    /* セクション内の余白調整（背景は body 側へ移行） */
    .sheet{ padding-top:6px; }

    dl.kv{ margin:0 0 10px; }
    dl.kv dt{ font-weight:700; font-size:10.5pt; margin-bottom:2px; }
    dl.kv dd{ margin:0 0 6px 0; }

    .goals-container {
      display: flex;
      justify-content: center;  /* 横中央 */
      align-items: flex-start;  /* 上部に寄せる */
      padding-top: 7pt;        /* 上に余白 */
    }

    ul.goals {
      list-style: none;
      padding: 0;
      margin: 0;
      text-align: center;
      width: 100%;
    }

    ul.goals li {
      font-size: 24pt;            /* A5で見出し級に大きく */
      font-weight: bold;
      margin: 12pt 0;
      padding: 8pt 12pt;
      background: #eaf3ec;       /* アクセントに合わせた淡緑 */
      border-radius: 12pt;
      box-shadow: 2pt 2pt 6pt rgba(0,0,0,0.2);
      display: inline-block;      /* 横幅に合わせて中央寄せ */
    }

    table.members{ width:100%; border-collapse:collapse; margin-top:8px; }
    .members th, .members td{ border:1px solid #000; padding:6px; font-size:11pt; text-align:left; }
    .members th{ background:#eaf3ec; }

    table.budget{ width:100%; border-collapse:collapse; margin-top:8px; }
    .budget th,.budget td{ border:1px solid #000; padding:6px; vertical-align:top; font-size:10.5pt; }
    .budget th{ background:#eaf3ec; text-align:left; }
    .budget .money{ text-align:right; }

    /* 付箋/テープ風見出し（小見出し用） */
    .sticker{
      display:inline-block;
      padding:6px 10px;
      border-radius:8px;
      background:#f2f7f3; /* 薄い緑がかった灰色 */
      position:relative;
      font-weight:700;
      box-shadow:1px 1px 0 rgba(0,0,0,.35);
    }
    .sticker::before{
      content:"";
      position:absolute;
      inset:-6px auto auto -6px;
      width:36px; height:18px;
      background:repeating-linear-gradient(45deg, rgba(0,0,0,.08) 0 6px, rgba(0,0,0,.16) 6px 12px);
      transform:rotate(-6deg);
      opacity:.7;
      pointer-events:none;
    }

    /* 行程の可読性向上 */
    .itinerary ul{ margin:6px 0 12px; list-style:none; padding-left:0; }
    .itinerary li{ margin:4px 0; font-variant-numeric: tabular-nums; }
    .itinerary li .time{ display:inline-block; min-width:4ch; }
    .itinerary li .dot{ display:inline-block; margin:0 6px; opacity:.85; }
    .itinerary li .place{ display:inline-block; }

    .total-box{ margin-top:10px; border:2px solid var(--accent); background:#f3f8f4; padding:6px 10px; display:flex; justify-content:space-between; }
    .total-box .label{ color:var(--accent); font-weight:700; }
    .total-box .value{ font-weight:800; font-size:13pt; }

    .hint{ font-size:9pt; color:#444; margin-top:4px; }
    .warn{ color:var(--warn); font-weight:700; }

    /* ここ崩すと表紙のフィットがうまくいかなくなるので暫定で固定 */
    @page {
      margin: 0mm 5mm;
      size: A5 portrait;
    }
    @media print {
      body::before, body::after {
        display: none !important;
        content: none !important;
      }
    }
    @page fullimage {
      margin: 0mm 0mm;
      size: A5 portrait;
    }
    .page {
      page: fullimage;
      position: relative;
      width: 100%;
      height: 100vh; /* 1ページの高さを確保 */
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="page">  
    ${base64Image ? `<img src="data:image/png;base64,${base64Image}" alt="Cover Image" style="width: 100%;object-fit:cover;object-position: 50% 50%;" />` : ''}
    </div>
    ${scheduleText || membersRows ? `
      <section class="section sheet">
        <h2>日程</h2>
        ${scheduleText ? `
          <dl class="kv">
            <dd>${scheduleText}</dd>
          </dl>
        ` : ''}
        <h2>班員名簿</h2>
        <table class="members">
          <thead>
            <tr>
              <th style="width:30%">氏名</th>
              <th style="width:18%">役割</th>
              <th>エピソード</th>
            </tr>
          </thead>
          <tbody>
            ${membersRows}
          </tbody>
        </table>
        <p class="hint">※ 名札・健康カードを必ず携帯しましょう。</p>
      </section>
    ` : ''}
    <section class="section sheet">
      ${purpose ? `
        <h2>旅の目的</h2>
        <div class="goals-container">
          <ul class="goals">
            <li>${purpose}</li>
          </ul>
        </div>
      ` : ''}
      ${hotels ? `
        <h2>宿泊先</h2>
        <dl class="kv">
          <dd>${hotels}</dd>
        </dl>
      `: ''}
      <h2>持ち物と注意</h2>
      <dl class="kv">
        <dt>必ず持参</dt>
        <dd>しおり・筆記用具・健康保険証の写し・雨具・常備薬・ハンカチ/ティッシュ</dd>
      </dl>
      <dl class="kv">
        <dt>あると便利</dt>
        <dd>小さめの折りたたみバッグ・モバイルバッテリー・絆創膏</dd>
      </dl>
      <dl class="kv">
        <dt class="warn">約束（厳守）</dt>
        <dd>時間厳守・整理整頓・買い物は班長に相談・夜更かし禁止</dd>
      </dl>
    </section>
    ${budgetRows ? `
    <section class="section sheet">
      <h2>予算・使用金額</h2>
      <table class="budget" aria-label="予算内訳">
        <thead>
          <tr>
            <th style="width:25%">項目</th>
            <th>商品（明細）</th>
            <th style="width:20%">合計</th>
          </tr>
        </thead>
        <tbody>
          ${budgetRows}
        </tbody>
      </table>
      <div class="total-box">
        <div class="label">合計</div>
        <div class="value">${total}円</div>
      </div>
      <p class="hint">※ おこづかいはよく考えて使いましょう</p>
    </section>
    ` : ''}
    ${itineraryHtml}
    <div class="page-footer" aria-hidden="true"></div>
  </div>
</body>
</html>
`;
}
