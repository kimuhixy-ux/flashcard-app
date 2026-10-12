/* ============================================================
   Service Worker - オフライン対応キャッシュ
   ============================================================ */

const CACHE_NAME = 'flashcard-v3';

// 初回インストール時にキャッシュするファイル一覧
const FILES_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './data/words.csv',
  './data/examples.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
];

// インストール時: 全ファイルをキャッシュに保存
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] キャッシュを作成します');
      // 個別にキャッシュ（1つ失敗しても他は続行）
      return Promise.allSettled(
        FILES_TO_CACHE.map(url => cache.add(url).catch(e => {
          console.warn('[SW] キャッシュ失敗:', url, e);
        }))
      );
    })
  );
  self.skipWaiting();  // 即座にアクティベート
});

// アクティベート時: 古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] 古いキャッシュを削除:', key);
            return caches.delete(key);
          })
      );
    })
  );
  self.clients.claim();  // 開いているページに即反映
});

// フェッチ時: キャッシュ優先、なければネットワークにフォールバック
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      // キャッシュになければネットワークから取得し、キャッシュに追加
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        return response;
      }).catch(() => {
        // オフラインでキャッシュもない場合
        return new Response('オフラインです。キャッシュされたページを使用してください。', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      });
    })
  );
});
