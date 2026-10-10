/* ============================================================
   英単語フラッシュカード - アプリ本体
   ライトナー方式（5つの箱）による間隔反復学習
   ============================================================ */

'use strict';

// ============================================================
// 定数 - ここを変えれば動作が変わる
// ============================================================

/** 各箱の復習間隔（日数）。インデックス = 箱番号 */
const INTERVAL_DAYS = [0, 1, 2, 4, 9, 21];

/** localStorage のキー名 */
const KEY_PROGRESS = 'wisdom_flashcards_progress_v1';
const KEY_SETTINGS = 'wisdom_flashcards_settings_v1';
const KEY_INTRO    = 'wisdom_flashcards_intro_v1';
const KEY_USER_WORDS = 'wisdom_flashcards_user_words_v1';

/** 文型クイズから取りこんだ単語のID開始番号。CSVの行番号と重ならないよう大きく離す */
const USER_ID_BASE = 1000000;

/** 文型クイズがコピーする文字列の先頭の目印（クイズ側と同じ値） */
const WORDS_HEADER = 'BUNKEI-QUIZ-WORDS';

/** CSVファイルのパス */
const CSV_PATH = 'data/words.csv';

/** セッション中の最大消化枚数（無限ループ防止） */
const MAX_SESSION_CARDS = 80;

// ============================================================
// グローバル変数
// ============================================================

/** 全単語データ（CSVから読み込む） */
let allWords = [];

/** 設定 */
let settings = {
  sessionSize: 20,
  newPerDay: 10,
  direction: '英和',  // '英和' / '和英' / '両方'
};

/** localStorage から読んだ進捗データ { cardId: {box, due, correct, wrong, last} } */
let progress = {};

/** 文型クイズから取りこんだ単語 [{headword, meaning, example, translation, source, regDate}] */
let userWords = [];

/** 本日の新規導入カウント { 'YYYY-MM-DD': 数 } */
let introCount = {};

/** 現在のセッションのキュー（cardId の配列） */
let sessionQueue = [];

/** セッション中に処理したカード総数 */
let sessionProcessed = 0;

/** セッション結果の集計 */
let sessionStats = {
  correct: 0,
  wrong: 0,
  newCards: 0,
  reviewCards: 0,
};

/** 現在表示中のカードID */
let currentCardId = null;

/** カードが表を表示しているか（false = 裏が出ている） */
let isFront = true;

// ============================================================
// 日付ユーティリティ
// ============================================================

/** 今日の日付を 'YYYY-MM-DD' 形式で返す（ローカルタイム） */
function getToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** today から n 日後の日付を 'YYYY-MM-DD' で返す */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ============================================================
// localStorage 読み書き（try/catch で壊れたデータから保護）
// ============================================================

function loadProgress() {
  try {
    const raw = localStorage.getItem(KEY_PROGRESS);
    progress = raw ? JSON.parse(raw) : {};
  } catch {
    progress = {};
  }
}

function saveProgress() {
  try {
    localStorage.setItem(KEY_PROGRESS, JSON.stringify(progress));
  } catch (e) {
    console.error('進捗の保存に失敗しました', e);
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (raw) {
      settings = { ...settings, ...JSON.parse(raw) };
    }
  } catch {
    /* 初期値のまま */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
  } catch (e) {
    console.error('設定の保存に失敗しました', e);
  }
}

function loadIntroCount() {
  try {
    const raw = localStorage.getItem(KEY_INTRO);
    introCount = raw ? JSON.parse(raw) : {};
  } catch {
    introCount = {};
  }
}

function saveIntroCount() {
  try {
    localStorage.setItem(KEY_INTRO, JSON.stringify(introCount));
  } catch (e) {
    console.error('新規導入カウントの保存に失敗しました', e);
  }
}

function loadUserWords() {
  try {
    const raw = localStorage.getItem(KEY_USER_WORDS);
    const list = raw ? JSON.parse(raw) : [];
    userWords = Array.isArray(list) ? list : [];
  } catch {
    userWords = [];
  }
}

function saveUserWords() {
  try {
    localStorage.setItem(KEY_USER_WORDS, JSON.stringify(userWords));
    return true;
  } catch (e) {
    console.error('取りこんだ単語の保存に失敗しました', e);
    return false;
  }
}

/** 取りこんだ単語をカードの形にする。並び順を変えないので ID（＝進捗の紐づけ）は変わらない */
function toUserCards() {
  return userWords.map((u, i) => ({
    id: USER_ID_BASE + i,
    headword: u.headword,
    meaning: u.meaning || '',
    dict: '英和',
    regDate: u.regDate,
    example: u.example || '',
    translation: u.translation || '',
    source: u.source || '',
    isUser: true,
  }));
}

// ============================================================
// CSV 読み込み（PapaParse 使用）
// ============================================================

function loadCSV() {
  return new Promise((resolve, reject) => {
    Papa.parse(CSV_PATH, {
      download: true,
      header: true,           // 1行目をヘッダとして扱う
      skipEmptyLines: true,   // 空行をスキップ
      complete: (results) => {
        let skipped = 0;
        const words = [];

        results.data.forEach((row, index) => {
          const headword = (row['見出し語'] || '').trim();
          const meaning  = (row['意味']     || '').trim();
          const dict     = (row['辞書']     || '').trim();
          const regDate  = (row['登録日']   || '').trim();

          // 意味が空欄の行はスキップ（仕様 §1.3）
          if (!meaning) {
            skipped++;
            return;
          }

          words.push({
            id: index,        // CSV データ行のインデックス（0始まり）が一意ID
            headword,
            meaning,
            dict,
            regDate,
          });
        });

        console.log(`✅ ${words.length} 語読み込み（${skipped} 行スキップ）`);
        resolve(words);
      },
      error: (err) => {
        console.error('CSV読み込みエラー:', err);
        reject(err);
      }
    });
  });
}

// ============================================================
// 進捗の集計
// ============================================================

/** 現在の設定で出題対象となる単語のみ絞り込む */
function getTargetWords() {
  if (settings.direction === '両方') return allWords;
  return allWords.filter(w => w.dict === settings.direction);
}

/** マスター/学習中/未学習の語数を返す */
function countStats() {
  const targets = getTargetWords();
  let mastered = 0, learning = 0, newCards = 0;

  for (const w of targets) {
    const p = progress[w.id];
    if (!p) {
      newCards++;
    } else if (p.box >= 5) {
      // box=5 で正解済みならマスター（due が未来ならマスター扱い）
      mastered++;
    } else {
      learning++;
    }
  }
  return { mastered, learning, newCards, total: targets.length };
}

/** 今日に復習期限が来たカード数を返す */
function countDueToday() {
  const today = getToday();
  const targets = getTargetWords();
  return targets.filter(w => {
    const p = progress[w.id];
    if (!p || p.box >= 5) return false;  // 未学習やマスターは除外
    return p.due <= today;
  }).length;
}

/** 本日まだ導入できる新規語数を返す */
function countNewAvailableToday() {
  const today = getToday();
  const usedToday = introCount[today] || 0;
  return Math.max(0, settings.newPerDay - usedToday);
}

// ============================================================
// セッションキューの組み立て（§3.5）
// ============================================================

function buildSessionQueue() {
  const today = getToday();
  const targets = getTargetWords();
  const queue = [];

  // 1. 復習期限が来たカードを due の古い順で追加
  const dueCards = targets
    .filter(w => {
      const p = progress[w.id];
      if (!p || p.box >= 5) return false;
      return p.due <= today;
    })
    .sort((a, b) => {
      const da = progress[a.id].due;
      const db = progress[b.id].due;
      return da < db ? -1 : da > db ? 1 : 0;
    });

  for (const w of dueCards) {
    if (queue.length >= settings.sessionSize) break;
    queue.push(w.id);
  }

  // 2. 新規カードで補充（登録日の古い順、日次上限あり）
  const newAvailable = countNewAvailableToday();
  if (queue.length < settings.sessionSize && newAvailable > 0) {
    const newCards = targets
      .filter(w => {
        const p = progress[w.id];
        return !p || p.box === 0;  // 未学習
      })
      .sort((a, b) => {
        // 自分で選んだ単語を先に出す。登録日順だけだと5000語以上の後ろに回ってしまうため
        if (Boolean(a.isUser) !== Boolean(b.isUser)) return a.isUser ? -1 : 1;
        // 登録日の古い順
        if (a.regDate < b.regDate) return -1;
        if (a.regDate > b.regDate) return 1;
        return a.id - b.id;
      });

    let newAdded = 0;
    for (const w of newCards) {
      if (queue.length >= settings.sessionSize) break;
      if (newAdded >= newAvailable) break;
      queue.push(w.id);
      newAdded++;
    }
  }

  return queue;
}

// ============================================================
// 採点ロジック（§3.3） - grade(cardId, '正解' or '不正解')
// ============================================================

/**
 * カードを採点し、進捗を更新する。
 * @param {number} cardId - カードのID
 * @param {boolean} isCorrect - true=正解、false=不正解
 */
function grade(cardId, isCorrect) {
  const today = getToday();
  const p = progress[cardId] || { box: 0, due: today, correct: 0, wrong: 0, last: today };

  if (isCorrect) {
    // 正解: 箱を1つ上げ、次回出題日を先に延ばす
    p.box = Math.min(p.box + 1, 5);
    p.due = addDays(today, INTERVAL_DAYS[p.box]);
    p.correct += 1;
    sessionStats.correct++;
  } else {
    // 不正解: 箱を1にリセット、即復習対象に
    p.box = 1;
    p.due = today;
    p.wrong += 1;
    sessionStats.wrong++;
  }

  p.last = today;
  progress[cardId] = p;
  saveProgress();
}

// ============================================================
// 画面切り替え
// ============================================================

const screens = {
  home: document.getElementById('screen-home'),
  study: document.getElementById('screen-study'),
  result: document.getElementById('screen-result'),
  settings: document.getElementById('screen-settings'),
};

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    if (key === name) {
      el.classList.remove('hidden');
      el.classList.add('active');
    } else {
      el.classList.remove('active');
      el.classList.add('hidden');
    }
  }
}

// ============================================================
// ホーム画面の更新
// ============================================================

function updateHomeScreen() {
  const stats = countStats();
  const dueCount = countDueToday();
  const newAvail = countNewAvailableToday();
  const total = stats.total;

  document.getElementById('stat-due').textContent = dueCount;
  document.getElementById('stat-new').textContent = newAvail;

  document.getElementById('count-mastered').textContent = stats.mastered;
  document.getElementById('count-learning').textContent = stats.learning;
  document.getElementById('count-new').textContent = stats.newCards;
  document.getElementById('count-total').textContent = total;

  // 進捗バー（全体幅に対する割合）
  const masteredPct = total > 0 ? (stats.mastered / total * 100).toFixed(1) : 0;
  const learningPct = total > 0 ? (stats.learning / total * 100).toFixed(1) : 0;
  document.getElementById('bar-mastered').style.width = masteredPct + '%';
  document.getElementById('bar-learning').style.width = learningPct + '%';

  // 学習開始ボタンの有効/無効
  const canStart = dueCount > 0 || newAvail > 0;
  const btnStart = document.getElementById('btn-start');
  const noMsg = document.getElementById('no-cards-message');
  btnStart.textContent = `学習を始める（${settings.sessionSize}語）`;
  btnStart.disabled = !canStart;
  noMsg.classList.toggle('hidden', canStart);
}

// ============================================================
// 学習画面 - カード表示
// ============================================================

function escapeHtml(str) {
  // XSS対策: HTML特殊文字をエスケープ
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** キューの先頭のカードを表示する */
function showNextCard() {
  if (sessionQueue.length === 0 || sessionProcessed >= MAX_SESSION_CARDS) {
    finishSession();
    return;
  }

  currentCardId = sessionQueue.shift();
  const word = allWords.find(w => w.id === currentCardId);
  if (!word) {
    // データが見つからない場合は次へ
    showNextCard();
    return;
  }

  isFront = true;

  // 進捗インジケータ更新
  const total = settings.sessionSize;
  const done = sessionProcessed;
  document.getElementById('progress-text').textContent = `${done} / ${total}`;
  const pct = total > 0 ? (done / total * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';

  // カード内容をセット
  document.getElementById('dict-badge').textContent = word.dict;

  if (word.dict === '英和') {
    // 英和: 表=英単語、裏=日本語の意味
    document.getElementById('word-front').textContent = word.headword;
    document.getElementById('word-front-back').textContent = word.headword;
  } else {
    // 和英: 表=日本語、裏=英語表現
    document.getElementById('word-front').textContent = word.headword;
    document.getElementById('word-front-back').textContent = word.headword;
  }

  document.getElementById('word-meaning').innerHTML = escapeHtml(word.meaning);
  document.getElementById('word-meta').textContent =
    `${word.dict} / 登録日: ${word.regDate}`;
  showUserCardExtras(word);

  // 表面のみ表示、裏面と採点ボタンを隠す
  document.querySelector('.card-front').classList.remove('hidden');
  document.querySelector('.card-back').classList.add('hidden');
  document.getElementById('grade-buttons').classList.add('hidden');
}

/** 取りこんだ単語だけ、例文・訳文と「意味を書き足す」欄を出す */
function showUserCardExtras(word) {
  const box = document.getElementById('user-card-extras');
  box.classList.toggle('hidden', !word.isUser);
  document.getElementById('meaning-edit').classList.add('hidden');
  if (!word.isUser) return;
  if (!word.meaning) {
    document.getElementById('word-meaning').textContent = '（意味はまだありません）';
  }
  document.getElementById('word-example').textContent = word.example;
  document.getElementById('word-example-ja').textContent = word.translation ? `訳: ${word.translation}` : '';
  document.getElementById('word-meta').textContent = `文型クイズ / ${word.source} / 登録日: ${word.regDate}`;
  document.getElementById('btn-edit-meaning').textContent = word.meaning ? '意味を直す' : '意味を書き足す';
}

function openMeaningEdit(event) {
  event.stopPropagation();
  const word = allWords.find(w => w.id === currentCardId);
  document.getElementById('input-meaning').value = word.meaning;
  document.getElementById('meaning-edit').classList.remove('hidden');
  document.getElementById('input-meaning').focus();
}

function saveMeaning(event) {
  event.stopPropagation();
  const word = allWords.find(w => w.id === currentCardId);
  const meaning = document.getElementById('input-meaning').value.trim();
  word.meaning = meaning;
  userWords[word.id - USER_ID_BASE].meaning = meaning;
  saveUserWords();
  document.getElementById('word-meaning').textContent = meaning || '（意味はまだありません）';
  document.getElementById('meaning-edit').classList.add('hidden');
  document.getElementById('btn-edit-meaning').textContent = meaning ? '意味を直す' : '意味を書き足す';
}

/** カードをめくる（表→裏） */
function flipCard() {
  if (!isFront) return;  // すでに裏面なら何もしない
  isFront = false;
  document.querySelector('.card-front').classList.add('hidden');
  document.querySelector('.card-back').classList.remove('hidden');
  document.getElementById('grade-buttons').classList.remove('hidden');
}

// ============================================================
// セッション開始 / 終了
// ============================================================

function startSession() {
  const queue = buildSessionQueue();

  if (queue.length === 0) {
    return;  // ホーム画面でボタンが無効化されているはずだが念のため
  }

  sessionQueue = queue;
  sessionProcessed = 0;
  sessionStats = { correct: 0, wrong: 0, newCards: 0, reviewCards: 0 };

  // 新規 / 復習の内訳を記録
  const today = getToday();
  for (const id of queue) {
    const p = progress[id];
    if (!p || p.box === 0) {
      sessionStats.newCards++;
    } else {
      sessionStats.reviewCards++;
    }
  }

  // 今日の新規導入カウントを増やす
  const newCardsInSession = sessionStats.newCards;
  introCount[today] = (introCount[today] || 0) + newCardsInSession;
  saveIntroCount();

  showScreen('study');
  showNextCard();
}

function finishSession() {
  // 結果画面を組み立てる
  const total = sessionStats.correct + sessionStats.wrong;

  document.getElementById('result-correct').textContent = sessionStats.correct;
  document.getElementById('result-total').textContent = total;
  document.getElementById('result-new').textContent = sessionStats.newCards;
  document.getElementById('result-review').textContent = sessionStats.reviewCards;

  // 次回の復習スケジュールを計算
  const today = getToday();
  const schedule = {};  // { 'YYYY-MM-DD': 件数 }

  for (const w of allWords) {
    const p = progress[w.id];
    if (!p || p.box >= 5) continue;
    if (p.due > today) {
      schedule[p.due] = (schedule[p.due] || 0) + 1;
    }
  }

  const scheduleEl = document.getElementById('result-schedule');
  const sortedDates = Object.keys(schedule).sort();

  if (sortedDates.length > 0) {
    let html = '<p style="font-weight:600;margin-bottom:6px;">次の復習予定</p>';
    // 最大5件まで表示
    for (const date of sortedDates.slice(0, 5)) {
      const diff = Math.round((new Date(date) - new Date(today + 'T00:00:00')) / 86400000);
      const label = diff === 1 ? '明日' : `${diff}日後`;
      html += `<p>${label} (${date}): ${schedule[date]} 語</p>`;
    }
    scheduleEl.innerHTML = html;
  } else {
    scheduleEl.innerHTML = '<p>現在、スケジュールされた復習はありません。</p>';
  }

  showScreen('result');
}

// ============================================================
// 採点ボタン押下時の処理
// ============================================================

function handleGrade(isCorrect) {
  if (currentCardId === null) return;

  const wasNew = !progress[currentCardId] || progress[currentCardId].box === 0;

  grade(currentCardId, isCorrect);
  sessionProcessed++;

  if (!isCorrect) {
    // 不正解: セッションキューの末尾に戻す（§3.3 / §3.5）
    sessionQueue.push(currentCardId);
  }

  showNextCard();
}

// ============================================================
// 設定画面
// ============================================================

function openSettings() {
  // 現在の設定値をフォームに反映
  document.getElementById('setting-session-size').value = settings.sessionSize;
  document.getElementById('setting-new-per-day').value = settings.newPerDay;
  document.getElementById('setting-direction').value = settings.direction;

  const info = document.getElementById('settings-word-count');
  info.textContent = `読み込み済み: ${allWords.length} 語`;

  showScreen('settings');
}

function saveSettingsUI() {
  settings.sessionSize = parseInt(document.getElementById('setting-session-size').value, 10) || 20;
  settings.newPerDay   = parseInt(document.getElementById('setting-new-per-day').value, 10) || 10;
  settings.direction   = document.getElementById('setting-direction').value;
  saveSettings();

  // 「保存しました」メッセージを一時表示
  const msg = document.getElementById('settings-saved-msg');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 2000);
}

// ============================================================
// エクスポート / インポート / リセット（§4-D）
// ============================================================

function exportProgress() {
  const data = {
    exportedAt: new Date().toISOString(),
    progress,
    introCount,
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `flashcard-progress-${getToday()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importProgress(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.progress) {
        progress = data.progress;
        saveProgress();
      }
      if (data.introCount) {
        introCount = data.introCount;
        saveIntroCount();
      }
      alert('インポートが完了しました。');
    } catch {
      alert('ファイルの読み込みに失敗しました。正しい形式のJSONファイルを選択してください。');
    }
  };
  reader.readAsText(file);
}

function resetProgress() {
  if (!confirm('本当に進捗をすべてリセットしますか？\nこの操作は元に戻せません。')) return;
  progress = {};
  introCount = {};
  saveProgress();
  saveIntroCount();
  alert('進捗をリセットしました。');
  updateHomeScreen();
}

// ============================================================
// 文型クイズからの取りこみ
// ============================================================

/** コピーされた文字列から単語の配列を取り出す。形が違えば null */
function parseQuizWords(text) {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith(WORDS_HEADER)) return null;
  try {
    const list = JSON.parse(trimmed.slice(WORDS_HEADER.length));
    return Array.isArray(list) ? list.filter(w => w && typeof w.word === 'string' && w.word.trim()) : null;
  } catch {
    return null;
  }
}

/** まだ英和カードにない単語だけ追加する。すでにある語（CSV・取りこみ済み）は飛ばす */
function addQuizWords(list) {
  const known = new Set(allWords.filter(w => w.dict === '英和').map(w => w.headword.toLowerCase()));
  let added = 0;
  for (const w of list) {
    const headword = w.word.trim();
    if (known.has(headword.toLowerCase())) continue;
    known.add(headword.toLowerCase());
    userWords.push({
      headword,
      meaning: '',
      example: String(w.sentence || ''),
      translation: String(w.translation || ''),
      source: String(w.source || ''),
      regDate: getToday(),
    });
    added++;
  }
  saveUserWords();
  allWords = allWords.filter(w => !w.isUser).concat(toUserCards());
  return { added, skipped: list.length - added };
}

function importQuizText(text) {
  const msg = document.getElementById('import-words-msg');
  const list = parseQuizWords(text);
  if (!list) {
    msg.textContent = '文型クイズの単語が見つかりませんでした。クイズで「単語帳へ送る」を押してから、もう一度お試しください。';
    return false;
  }
  const { added, skipped } = addQuizWords(list);
  msg.textContent = `${added}語を追加しました。` + (skipped > 0 ? `（${skipped}語はすでに登録済み）` : '');
  document.getElementById('paste-box').classList.add('hidden');
  updateHomeScreen();
  return true;
}

/** クリップボードを読めない環境では、貼り付け欄を出して手で貼ってもらう */
async function handleImportQuizWords() {
  try {
    const text = await navigator.clipboard.readText();
    if (importQuizText(text)) return;
  } catch {
    /* 読み取りを断られた・未対応 */
  }
  document.getElementById('paste-box').classList.remove('hidden');
  document.getElementById('input-paste').focus();
}

// ============================================================
// キーボード操作（§4-B）
// ============================================================

document.addEventListener('keydown', (e) => {
  const studyScreen = document.getElementById('screen-study');
  if (!studyScreen.classList.contains('active')) return;
  // 意味の入力中にスペースやEnterでカードが進まないようにする
  if (e.target.tagName === 'TEXTAREA') return;

  switch (e.key) {
    case ' ':
    case 'Enter':
      e.preventDefault();
      if (isFront) flipCard();
      break;
    case '1':
    case 'ArrowLeft':
      if (!isFront) handleGrade(false);  // ✗
      break;
    case '2':
    case 'ArrowRight':
      if (!isFront) handleGrade(true);   // ◯
      break;
  }
});

// ============================================================
// イベントリスナーの設定
// ============================================================

function setupEventListeners() {
  // ホーム
  document.getElementById('btn-start').addEventListener('click', startSession);
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-import-words').addEventListener('click', handleImportQuizWords);
  document.getElementById('btn-paste-import').addEventListener('click', () => {
    importQuizText(document.getElementById('input-paste').value);
  });

  // 学習
  document.getElementById('flashcard').addEventListener('click', () => {
    if (isFront) flipCard();
  });
  document.getElementById('btn-correct').addEventListener('click', () => handleGrade(true));
  document.getElementById('btn-wrong').addEventListener('click', () => handleGrade(false));
  document.getElementById('btn-edit-meaning').addEventListener('click', openMeaningEdit);
  document.getElementById('btn-save-meaning').addEventListener('click', saveMeaning);
  document.getElementById('meaning-edit').addEventListener('click', e => e.stopPropagation());
  document.getElementById('btn-quit').addEventListener('click', () => {
    if (confirm('学習を終了してホームに戻りますか？')) {
      showScreen('home');
      updateHomeScreen();
    }
  });

  // 結果
  document.getElementById('btn-home').addEventListener('click', () => {
    showScreen('home');
    updateHomeScreen();
  });
  document.getElementById('btn-more').addEventListener('click', () => {
    showScreen('home');
    updateHomeScreen();
    // 少し遅らせてセッション開始（UIが更新されてから）
    setTimeout(startSession, 100);
  });

  // 設定
  document.getElementById('btn-settings-back').addEventListener('click', () => {
    showScreen('home');
    updateHomeScreen();
  });
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsUI);
  document.getElementById('btn-export').addEventListener('click', exportProgress);
  document.getElementById('input-import').addEventListener('change', (e) => {
    if (e.target.files[0]) importProgress(e.target.files[0]);
    e.target.value = '';  // 同じファイルを再選択できるようリセット
  });
  document.getElementById('btn-reset').addEventListener('click', resetProgress);
}

// ============================================================
// アプリの起動
// ============================================================

async function init() {
  // localStorage からデータを読み込む
  loadProgress();
  loadSettings();
  loadIntroCount();
  loadUserWords();

  try {
    // CSV を読み込む
    allWords = (await loadCSV()).concat(toUserCards());

    // ホーム画面のローディング表示を消して、コンテンツを表示
    document.getElementById('loading-message').classList.add('hidden');
    document.getElementById('home-content').classList.remove('hidden');

    // イベントリスナーを設定
    setupEventListeners();

    // ホーム画面の統計を更新
    updateHomeScreen();

    // PWA: Service Worker を登録
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js')
        .then(() => console.log('Service Worker 登録完了'))
        .catch(e => console.warn('Service Worker 登録失敗:', e));
    }

    console.log('✅ アプリ起動完了');
  } catch (err) {
    document.getElementById('loading-message').innerHTML =
      '<p style="color:red;">単語データの読み込みに失敗しました。<br>' +
      '<small>ローカルサーバー経由でアクセスしてください</small></p>';
    console.error('起動エラー:', err);
  }
}

// DOMが読み込まれてから起動
document.addEventListener('DOMContentLoaded', init);
