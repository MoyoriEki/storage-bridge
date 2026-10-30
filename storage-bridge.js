/**
 * StorageBridge — Dropbox認証・読み書きの共通JSライブラリ
 * 各ブラウザアプリが <script src="storage-bridge.js"> で読み込んで使う。
 * 個人利用前提。アプリ側は save/load/list 等の抽象関数だけ呼ぶ。
 *
 * 既存資産: ムーンライター（メモアプリ）のDropbox API連携コードから抽出・汎用化
 */

/* ========================================================================
   TokenManager — localStorage永続化 + 期限切れ検知 + 自動リフレッシュ
   ======================================================================== */
class TokenManager {
  constructor(prefix) {
    this._prefix = prefix;
  }

  // ── キー名 ──
  _key(name) { return `${this._prefix}_dbx_${name}`; }

  // ── getter / setter ──
  get token()        { return localStorage.getItem(this._key('token')); }
  set token(v)       { v ? localStorage.setItem(this._key('token'), v) : localStorage.removeItem(this._key('token')); }

  get refreshToken() { return localStorage.getItem(this._key('refresh')); }
  set refreshToken(v){ v ? localStorage.setItem(this._key('refresh'), v) : localStorage.removeItem(this._key('refresh')); }

  get appKey()       { return localStorage.getItem(this._key('key')) || ''; }
  set appKey(v)      { v ? localStorage.setItem(this._key('key'), v) : localStorage.removeItem(this._key('key')); }

  get verifier()     { return localStorage.getItem(this._key('verifier')); }
  set verifier(v)    { v ? localStorage.setItem(this._key('verifier'), v) : localStorage.removeItem(this._key('verifier')); }

  // 次回の認証でDropboxに再ログインを強制するか（切断後のアカウント切り替え用）
  get reauth()       { return localStorage.getItem(this._key('reauth')) === '1'; }
  set reauth(v)      { v ? localStorage.setItem(this._key('reauth'), '1') : localStorage.removeItem(this._key('reauth')); }

  get isConnected()  { return !!this.token; }

  // ── 全トークン破棄 ──
  clear() {
    this.token = null;
    this.refreshToken = null;
    this.verifier = null;
  }

  // ── レスポンスが期限切れかどうか判定（メモアプリの isExpiredToken を汎用化） ──
  async isExpired(response) {
    if (response.status === 401) return true;
    // Dropbox は 401 以外でも body に expired_access_token を返すことがある
    if (!response.ok) {
      try {
        const body = await response.clone().text();
        if (body.includes('expired_access_token')) return true;
      } catch (_) {}
    }
    return false;
  }

  // ── リフレッシュトークンでアクセストークン更新（メモアプリの refreshAccessToken を汎用化） ──
  async refresh() {
    if (!this.refreshToken || !this.appKey) {
      throw new Error('再認証が必要です');
    }
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.appKey,
      }),
    });
    const d = await r.json();
    if (!d.access_token) {
      throw new Error('トークン更新失敗');
    }
    this.token = d.access_token;
    return d.access_token;
  }
}

/* ========================================================================
   PersonalAuth — PKCE認証フロー（メモアプリの genPKCE / checkAuth / startAuth を汎用化）
   ======================================================================== */
class PersonalAuth {
  constructor(tokenManager) {
    this._tm = tokenManager;
  }

  // ── PKCE ペア生成（メモアプリの b64url + genPKCE をそのまま移植） ──
  static _b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async _genPKCE() {
    const v = PersonalAuth._b64url(crypto.getRandomValues(new Uint8Array(32)));
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    return { verifier: v, challenge: PersonalAuth._b64url(d) };
  }

  // ── OAuth開始 → Dropbox認証画面にリダイレクト ──
  // forceReauth（または切断後の初回）は force_reauthentication を付け、
  // ブラウザに残っているDropboxのログインを使い回さずにアカウントを選び直させる
  async start(opts = {}) {
    const { verifier, challenge } = await this._genPKCE();
    this._tm.verifier = verifier;
    const params = new URLSearchParams({
      client_id: this._tm.appKey,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: location.origin + location.pathname,
      token_access_type: 'offline',
    });
    if (opts.forceReauth || this._tm.reauth) {
      params.set('force_reauthentication', 'true');
    }
    location.href = 'https://www.dropbox.com/oauth2/authorize?' + params;
  }

  // ── コールバック処理（URLにcode付きで戻ってきた時） ──
  async checkCallback() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code) return false;

    const verifier = this._tm.verifier;
    const ak = this._tm.appKey;
    if (!verifier || !ak) return false;

    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: ak,
        code_verifier: verifier,
        redirect_uri: location.origin + location.pathname,
      }),
    });
    const d = await r.json();
    if (!d.access_token) return false;

    this._tm.token = d.access_token;
    if (d.refresh_token) {
      this._tm.refreshToken = d.refresh_token;
    }
    this._tm.verifier = null;
    this._tm.reauth = null;
    window.history.replaceState({}, '', location.pathname);
    return true;
  }

  // ── 保存済みトークンからの復帰 ──
  tryRestore() {
    return this._tm.isConnected;
  }
}

/* ========================================================================
   DefaultUI — オプションの接続UI（sb- プレフィックス）
   ======================================================================== */
class DefaultUI {
  constructor(bridge, target) {
    this._bridge = bridge;
    this._root = null;
    this._modal = null;
    this._statusEl = null;
    this._btnEl = null;
    this._build(target);
  }

  _build(target) {
    // ルート要素
    const container = typeof target === 'string'
      ? document.querySelector(target)
      : target;
    const root = document.createElement('div');
    root.className = 'sb-ui';

    // 接続ボタン + ステータス
    const status = document.createElement('span');
    status.className = 'sb-status';
    status.textContent = '未接続';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sb-connect-btn';
    btn.textContent = 'Dropbox 接続';
    btn.addEventListener('click', () => this._onBtnClick());

    root.appendChild(status);
    root.appendChild(btn);

    this._statusEl = status;
    this._btnEl = btn;
    this._root = root;

    // AppKey入力モーダル
    const overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div class="sb-modal">
        <p>
          <a href="https://www.dropbox.com/developers/apps" target="_blank"
             style="color:inherit;text-decoration:underline">
            dropbox.com/developers/apps
          </a>
          でアプリを作成し、App keyを入力してください。
        </p>
        <input class="sb-appkey-input" placeholder="App key" type="text">
        <div class="sb-modal-actions">
          <button type="button" class="sb-modal-cancel">キャンセル</button>
          <button type="button" class="sb-modal-ok">接続する</button>
        </div>
      </div>
    `;
    overlay.querySelector('.sb-modal-cancel').addEventListener('click', () => {
      overlay.style.display = 'none';
    });
    overlay.querySelector('.sb-modal-ok').addEventListener('click', () => {
      const input = overlay.querySelector('.sb-appkey-input');
      const key = input.value.trim();
      if (!key) return;
      this._bridge._tm.appKey = key;
      overlay.style.display = 'none';
      this._bridge.connect();
    });

    this._modal = overlay;

    // DOMに挿入
    if (container) {
      container.appendChild(root);
      container.appendChild(overlay);
    } else {
      document.body.appendChild(root);
      document.body.appendChild(overlay);
    }
  }

  _onBtnClick() {
    if (this._bridge.isConnected) {
      this._bridge.disconnect();
    } else {
      // AppKeyが無ければモーダルを出す
      if (!this._bridge._tm.appKey) {
        this._modal.querySelector('.sb-appkey-input').value = '';
        this._modal.style.display = '';
      } else {
        this._bridge.connect();
      }
    }
  }

  setConnected() {
    this._statusEl.textContent = '接続中';
    this._statusEl.classList.add('sb-on');
    this._btnEl.textContent = '切断';
    this._btnEl.classList.add('sb-on');
  }

  setDisconnected() {
    this._statusEl.textContent = '未接続';
    this._statusEl.classList.remove('sb-on');
    this._btnEl.textContent = 'Dropbox 接続';
    this._btnEl.classList.remove('sb-on');
  }

  destroy() {
    this._root?.remove();
    this._modal?.remove();
  }
}

/* ========================================================================
   StorageBridge — アプリが触る唯一の窓口
   ======================================================================== */
class StorageBridge {
  /**
   * @param {Object} opts
   * @param {string}  [opts.basePath='']         Dropbox上のルートフォルダ
   * @param {string}  [opts.storagePrefix='sb']  localStorage キー接頭辞
   * @param {boolean} [opts.ui=true]             DefaultUI を表示するか
   * @param {string|Element} [opts.uiTarget=null] UI差し込み先
   * @param {string}  [opts.appKey=null]         Dropbox AppKey
   * @param {object}  [opts.authProvider=null]   カスタム AuthProvider
   */
  constructor(opts = {}) {
    this._basePath = (opts.basePath || '').replace(/\/+$/, '');
    this._listeners = { connected: [], disconnected: [], error: [] };

    // TokenManager
    this._tm = new TokenManager(opts.storagePrefix || 'sb');
    if (opts.appKey) {
      this._tm.appKey = opts.appKey;
    }

    // AuthProvider
    this._auth = opts.authProvider || new PersonalAuth(this._tm);

    // DefaultUI
    this._ui = null;
    if (opts.ui !== false) {
      this._ui = new DefaultUI(this, opts.uiTarget || null);
    }

    // ページ読み込み時に自動復帰
    this._autoRestore();
  }

  // ── イベント ──
  on(event, fn) {
    if (this._listeners[event]) this._listeners[event].push(fn);
  }
  off(event, fn) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(f => f !== fn);
    }
  }
  _emit(event, data) {
    (this._listeners[event] || []).forEach(fn => {
      try { fn(data); } catch (e) { console.error(`[StorageBridge] ${event} handler error`, e); }
    });
  }

  // ── 状態 ──
  get isConnected() { return this._tm.isConnected; }

  /** 同期XHR用（beforeunload等）にトークンを公開 */
  getToken() { return this._tm.token; }

  // ── 認証 ──
  // opts.forceReauth: Dropboxに再ログインを求める（別アカウントへの切り替え用）
  async connect(opts = {}) {
    try {
      await this._auth.start(opts);
    } catch (e) {
      this._emitError(e);
    }
  }

  // ユーザー操作による切断。次の connect() ではDropboxに再ログインを求め、
  // 間違ったアカウントで繋いだ場合でも別アカウントを選び直せるようにする
  disconnect() {
    this._tm.reauth = true;
    this._resetConnection();
  }

  _resetConnection() {
    this._tm.clear();
    this._ui?.setDisconnected();
    this._emit('disconnected');
  }

  // ── 自動復帰（コンストラクタから呼ばれる） ──
  async _autoRestore() {
    try {
      // OAuthコールバック（URLに code がある場合）
      if (typeof this._auth.checkCallback === 'function') {
        const ok = await this._auth.checkCallback();
        if (ok) {
          await this._onConnected();
          return;
        }
      }
      // 保存済みトークンからの復帰
      if (typeof this._auth.tryRestore === 'function' && this._auth.tryRestore()) {
        await this._onConnected();
      }
    } catch (e) {
      this._emitError(e);
    }
  }

  async _onConnected() {
    await this._ensureBasePath();
    this._ui?.setConnected();
    this._emit('connected');
  }

  // ── basePath が存在しなければ自動作成 ──
  async _ensureBasePath() {
    if (!this._basePath) return;
    try {
      await this._apiFetch('files/get_metadata', { path: this._basePath });
    } catch (e) {
      // path/not_found → フォルダ作成
      if (typeof e.message === 'string' && e.message.includes('not_found')) {
        try {
          await this._apiFetch('files/create_folder_v2', {
            path: this._basePath,
            autorename: false,
          });
        } catch (e2) {
          // conflict（既に別の並行処理で作られた等）は無視
          if (!e2.message?.includes('conflict')) throw e2;
        }
      }
    }
  }

  _emitError(e) {
    if (this._listeners.error.length > 0) {
      this._emit('error', e);
    } else {
      console.error('[StorageBridge]', e);
    }
  }

  // ── パス解決 ──
  _resolve(path) {
    if (!path) throw new Error('パスが空です');
    if (path.startsWith('/')) {
      throw new Error('絶対パスは使えません。相対パスで指定してください: ' + path);
    }
    return this._basePath ? `${this._basePath}/${path}` : `/${path}`;
  }

  // ── 日本語パス対応（メモアプリの dbxArg をそのまま移植） ──
  static _dbxArg(obj) {
    return JSON.stringify(obj).replace(/[\u0080-\uFFFF]/g,
      c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }

  // ── 期限切れ自動リトライ付き fetch（メモアプリの dbxFetch / handleAuth401 パターンを汎用化） ──
  async _apiFetch(endpoint, body) {
    const doReq = async () => fetch('https://api.dropboxapi.com/2/' + endpoint, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + this._tm.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    let r = await doReq();
    if (await this._tm.isExpired(r)) {
      await this._handleExpiry();
      r = await doReq();
    }
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  async _contentDownload(path) {
    const doReq = async () => fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + this._tm.token,
        'Dropbox-API-Arg': StorageBridge._dbxArg({ path }),
      },
    });

    let r = await doReq();
    if (await this._tm.isExpired(r)) {
      await this._handleExpiry();
      r = await doReq();
    }
    if (!r.ok) throw new Error(await r.text());
    return r;
  }

  async _contentUpload(path, content) {
    const doReq = async () => fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + this._tm.token,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': StorageBridge._dbxArg({
          path,
          mode: 'overwrite',
          autorename: false,
        }),
      },
      body: content,
    });

    let r = await doReq();
    if (await this._tm.isExpired(r)) {
      await this._handleExpiry();
      r = await doReq();
    }
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  async _handleExpiry() {
    try {
      await this._tm.refresh();
    } catch (_) {
      // セッション切れは同じアカウントで繋ぎ直すだけなので再ログインは強制しない
      this._resetConnection();
      throw new Error('セッション切れ。再接続してください');
    }
  }

  // ════════════════════════════════════════════
  // パブリック API
  // ════════════════════════════════════════════

  /**
   * テキストファイルを保存
   * @param {string} path  相対パス
   * @param {string|ArrayBuffer|Blob} content
   */
  async save(path, content) {
    return this._contentUpload(this._resolve(path), content);
  }

  /**
   * テキストファイルを読み込み → string
   * @param {string} path 相対パス
   * @returns {Promise<string>}
   */
  async load(path) {
    const r = await this._contentDownload(this._resolve(path));
    return r.text();
  }

  /**
   * バイナリファイルを読み込み → ArrayBuffer
   * （メモアプリには無かった機能。.clip等のバイナリ用）
   * @param {string} path 相対パス
   * @returns {Promise<ArrayBuffer>}
   */
  async loadBinary(path) {
    const r = await this._contentDownload(this._resolve(path));
    return r.arrayBuffer();
  }

  /**
   * フォルダ内のエントリ一覧（has_more ページネーション対応、メモアプリの list_folder ループを移植）
   * @param {string} [folderPath=''] 相対パス（省略でbasePath直下）
   * @returns {Promise<Array>} Dropbox entries 配列
   */
  async list(folderPath) {
    const resolved = folderPath
      ? this._resolve(folderPath).replace(/\/+$/, '')
      : (this._basePath || '');

    let entries = [];
    let cursor = null;
    let hasMore = true;

    try {
      while (hasMore) {
        let d;
        if (!cursor) {
          d = await this._apiFetch('files/list_folder', {
            path: resolved,
            recursive: false,
            include_non_downloadable_files: false,
          });
        } else {
          d = await this._apiFetch('files/list_folder/continue', { cursor });
        }
        entries = [...entries, ...d.entries];
        cursor = d.cursor;
        hasMore = d.has_more;
      }
    } catch (e) {
      // path/not_found → フォルダを自動作成して空配列を返す
      if (typeof e.message === 'string' && e.message.includes('not_found')) {
        try {
          await this._apiFetch('files/create_folder_v2', {
            path: resolved,
            autorename: false,
          });
        } catch (_) { /* conflict等は無視 */ }
        return [];
      }
      throw e;
    }
    return entries;
  }

  /**
   * ファイル/フォルダ削除
   * @param {string} path 相対パス
   */
  async delete(path) {
    return this._apiFetch('files/delete_v2', { path: this._resolve(path) });
  }

  /**
   * フォルダ作成
   * @param {string} path 相対パス
   */
  async createFolder(path) {
    return this._apiFetch('files/create_folder_v2', {
      path: this._resolve(path),
      autorename: false,
    });
  }

  /**
   * ファイル/フォルダ移動（リネーム兼用）
   * @param {string} from 相対パス
   * @param {string} to   相対パス
   */
  async move(from, to) {
    return this._apiFetch('files/move_v2', {
      from_path: this._resolve(from),
      to_path: this._resolve(to),
      autorename: false,
    });
  }
}

// グローバルに公開
window.StorageBridge = StorageBridge;
window.PersonalAuth = PersonalAuth;
window.TokenManager = TokenManager;
