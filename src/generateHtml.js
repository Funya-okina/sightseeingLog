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
  function formatDateToYMD(date) {
    if (!date) return '';
    let d = date;
    if (!(d instanceof Date)) {
      d = new Date(d);
    }
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  const rawStartDate = get(trip, 'startDate');
  const rawEndDate = get(trip, 'endDate');
  const startDate = formatDateToYMD(rawStartDate);
  const endDate = formatDateToYMD(rawEndDate);
  const hotelsArr = get(trip, 'hotels');
  const hotels = Array.isArray(hotelsArr) ? hotelsArr.join('<br>') : undefined;

  // 目的
  const purpose = get(trip, 'purpose');

  // 参加者
  const membersArr = get(trip, 'members');
  let membersRows = '';
  if (Array.isArray(membersArr)) {
    membersRows = membersArr.map(m => {
      const name = get(m, 'name');
      const episode = get(m, 'episode');
      // nameは必須
      if (!name) return '';
      return `<tr><td>${name}</td><td>${episode || ''}</td></tr>`;
    }).filter(Boolean).join('');
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
    }
    body{
      margin:0; color:var(--ink); background:#fff;
      font-family:"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;
      line-height:1.6; font-size:12pt;
    }

    @page{ size:A4; margin:15mm; }
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
      border-bottom:2px solid #000;
      padding-bottom:4px;
    }

    .section{
      margin:20px 0;
      page-break-before:always;
    }

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
      background: #c9c9c9;
      border-radius: 12pt;
      box-shadow: 2pt 2pt 6pt rgba(0,0,0,0.2);
      display: inline-block;      /* 横幅に合わせて中央寄せ */
    }

    table.members{ width:100%; border-collapse:collapse; margin-top:8px; }
    .members th, .members td{ border:1px solid #000; padding:6px; font-size:11pt; text-align:left; }
    .members th{ background:#eee; }

    table.budget{ width:100%; border-collapse:collapse; margin-top:8px; }
    .budget th,.budget td{ border:1px solid #000; padding:6px; vertical-align:top; font-size:10.5pt; }
    .budget th{ background:#eee; text-align:left; }
    .budget .money{ text-align:right; }

    .total-box{ margin-top:10px; border:2px solid #000; padding:6px 10px; display:flex; justify-content:space-between; }
    .total-box .label{ font-weight:700; }
    .total-box .value{ font-weight:800; font-size:13pt; }

    .hint{ font-size:9pt; color:#444; margin-top:4px; }
    .warn{ color:var(--warn); font-weight:700; }

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
    ${startDate && endDate && hotels ? `
    <section class="section">
      <h2>日程と宿泊先</h2>
      <dl class="kv">
        <dt>旅行開始日</dt>
        <dd>${startDate}</dd>
      </dl>
      <dl class="kv">
        <dt>旅行終了日</dt>
        <dd>${endDate}</dd>
      </dl>
      <dl class="kv">
        <dt>宿泊先</dt>
        <dd>${hotels}</dd>
      </dl>
    </section>
    ` : ''}
    ${purpose ? `
    <section class="section">
      <h2>旅の目的</h2>
      <div class="goals-container">
        <ul class="goals">
          <li>${purpose}</li>
        </ul>
      </div>
    </section>
    ` : ''}
    ${membersRows ? `
    <section class="section">
      <h2>参加者名</h2>
      <table class="members">
        <thead>
          <tr>
            <th style="width:30%">氏名</th>
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
    ${budgetRows ? `
    <section class="section">
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
    <!-- 持ち物と注意 -->
    <section class="section">
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
    <div class="page-footer" aria-hidden="true"></div>
  </div>
</body>
</html>
`;
}