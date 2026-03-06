# StorageBridge

Dropbox認証・読み書きの共通JSライブラリ。  
各ブラウザアプリが `<script src="storage-bridge.js">` で読み込んで使う。

## クイックスタート

```html
<link rel="stylesheet" href="storage-bridge.css">
<script src="storage-bridge.js"></script>
<div id="dbx-ui"></div>

<script>
const storage = new StorageBridge({
  basePath: '/メガ無人島',
  storagePrefix: 'megaisland',
  ui: true,
  uiTarget: '#dbx-ui',
});

storage.on('connected', async () => {
  const files = await storage.list();
  console.log(files);
});

// 保存・読み込み
await storage.save('library.json', JSON.stringify(data));
const raw = await storage.load('library.json');
</script>
```

## コンストラクタオプション

| キー | 型 | デフォルト | 説明 |
|------|------|-----------|------|
| `basePath` | string | `''` | Dropbox上のルートフォルダ |
| `storagePrefix` | string | `'sb'` | localStorageキー接頭辞 |
| `ui` | boolean | `true` | デフォルト接続UIを表示するか |
| `uiTarget` | string \| Element | `null` | UIの差し込み先（CSSセレクタ or DOM要素） |
| `appKey` | string | `null` | Dropbox AppKey（省略時はUI入力） |
| `authProvider` | object | `PersonalAuth` | 認証プロバイダ |

## API

```js
await storage.save(path, content)     // テキスト/バイナリ保存
await storage.load(path)              // テキスト読み込み → string
await storage.loadBinary(path)        // バイナリ読み込み → ArrayBuffer
await storage.list(folderPath?)       // フォルダ一覧 → Entry[]
await storage.delete(path)            // 削除
await storage.createFolder(path)      // フォルダ作成
await storage.move(from, to)          // 移動/リネーム
storage.connect()                     // 認証開始
storage.disconnect()                  // 切断
storage.isConnected                   // boolean
storage.getToken()                    // トークン取得（同期XHR用）
```

パスは全て **basePath からの相対パス**。先頭 `/` は禁止（エラーになる）。

## イベント

```js
storage.on('connected', () => { ... })
storage.on('disconnected', () => { ... })
storage.on('error', (e) => { ... })
```

## UI無しパターン

```js
const storage = new StorageBridge({
  basePath: '/カスタムアプリ',
  storagePrefix: 'myapp',
  ui: false,
});

storage.on('connected', () => updateMyUI('接続中'));
myButton.onclick = () => storage.connect();
```

## beforeunload での同期保存

```js
window.addEventListener('beforeunload', () => {
  if (!storage.isConnected || !needsSave) return;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://content.dropboxapi.com/2/files/upload', false);
  xhr.setRequestHeader('Authorization', 'Bearer ' + storage.getToken());
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('Dropbox-API-Arg', StorageBridge._dbxArg({
    path: '/アプリ/file.json', mode: 'overwrite', autorename: false
  }));
  xhr.send(content);
});
```

## CSSカスタマイズ

DefaultUIのスタイルはCSS変数で上書きできる。

```css
:root {
  --sb-accent: #e8cf6a;
  --sb-bg: #1a1a1a;
  --sb-text: #eee;
  --sb-border: #444;
}
```

## ファイル構成

```
storage-bridge/
├── storage-bridge.js    ← 本体（単体で動く）
├── storage-bridge.css   ← DefaultUI用スタイル
├── README.md            ← このファイル
└── example.html         ← 動作確認ページ
```
