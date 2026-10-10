const page = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>コンパニオン運用状況</title>
    <style nonce="__NONCE__">
      :root {
        color-scheme: dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Yu Gothic UI", sans-serif;
        background: #0d1420;
        color: #eef3f8;
        font-synthesis: none;
        text-rendering: optimizeLegibility;
        --surface: #151f2d;
        --surface-raised: #1a2737;
        --border: #344356;
        --muted: #b4c1ce;
        --accent: #89d5bd;
        --danger: #ff9b98;
        --warning: #f3ce79;
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 320px; background: radial-gradient(ellipse at 72% -12%, #1d3040 0, transparent 36rem), #0d1420; }
      button, input { font: inherit; }
      button { min-height: 44px; padding: 0 16px; border: 1px solid #537a71; border-radius: 9px; background: #23483f; color: #f1fff9; cursor: pointer; transition: background-color 160ms ease, border-color 160ms ease; }
      button:hover { background: #2c5b4e; border-color: #8fd2bd; }
      button:focus-visible, input:focus-visible { outline: 3px solid #b7eddc; outline-offset: 3px; }
      input { width: 100%; min-height: 46px; padding: 10px 12px; color: #f1f5f9; background: #0f1824; border: 1px solid #46576b; border-radius: 8px; }
      input::placeholder { color: #a2afbd; }
      header, main { width: min(1120px, calc(100% - 40px)); margin-inline: auto; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 30px 0 24px; border-bottom: 1px solid #2a3848; }
      .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
      .mark { display: grid; width: 42px; height: 42px; place-items: center; flex: 0 0 auto; border: 1px solid #537a71; border-radius: 12px; color: var(--accent); font-size: 20px; font-weight: 750; }
      h1, h2, p { margin: 0; }
      h1 { font-size: clamp(21px, 3vw, 28px); line-height: 1.25; letter-spacing: -.02em; }
      .subtitle { margin-top: 5px; color: var(--muted); font-size: 14px; }
      .header-actions { display: flex; align-items: center; gap: 10px; }
      .updated { min-width: 120px; color: var(--muted); font-size: 13px; text-align: right; }
      main { padding: 26px 0 52px; }
      .auth-card { max-width: 520px; margin: 48px auto; padding: 28px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
      .auth-card h2 { font-size: 20px; }
      .auth-card p { margin-top: 8px; color: var(--muted); line-height: 1.6; }
      .auth-form { display: grid; gap: 12px; margin-top: 20px; }
      .auth-form label, .field-label { color: var(--muted); font-size: 13px; font-weight: 650; }
      .auth-form button { justify-self: start; }
      .notice { min-height: 24px; margin-top: 10px; color: var(--warning); font-size: 14px; }
      .overview { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
      .overview h2 { font-size: 16px; font-weight: 650; }
      .overview p { margin-top: 4px; color: var(--muted); font-size: 13px; }
      .status-pill { display: inline-flex; align-items: center; min-height: 34px; gap: 8px; padding: 4px 12px; border: 1px solid #546173; border-radius: 999px; color: #e7edf3; background: #202b39; font-size: 14px; font-weight: 700; white-space: nowrap; }
      .status-pill::before { width: 8px; height: 8px; border-radius: 50%; background: #b4c1ce; content: ""; }
      .status-pill[data-state="active"] { border-color: #477869; background: #18352f; color: #b8f0dd; }
      .status-pill[data-state="active"]::before { background: #89d5bd; }
      .status-pill[data-state="busy"] { border-color: #8a713a; background: #3a301b; color: #ffe5a6; }
      .status-pill[data-state="busy"]::before { background: #f3ce79; }
      .status-pill[data-state="stopped"] { border-color: #7f5555; background: #382426; color: #ffc2bf; }
      .status-pill[data-state="stopped"]::before { background: #ff9b98; }
      .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 14px; }
      .card { min-width: 0; padding: 20px; border: 1px solid var(--border); border-radius: 12px; background: linear-gradient(145deg, #182433, #131d2a); }
      .goal-card { grid-column: span 7; }
      .outcome-card { grid-column: span 5; }
      .usage-card { grid-column: span 7; }
      .memory-card { grid-column: 1 / -1; }
      .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
      .card h2 { font-size: 15px; font-weight: 700; letter-spacing: .01em; }
      .eyebrow { color: var(--accent); font-size: 11px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
      .value { overflow-wrap: anywhere; color: #f4f7fb; font-size: 18px; font-weight: 700; line-height: 1.55; }
      .detail { margin-top: 10px; color: #d1dbe4; font-size: 15px; line-height: 1.7; overflow-wrap: anywhere; }
      .muted { color: var(--muted); }
      .meta { color: var(--muted); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
      .rule { height: 1px; margin: 16px 0; background: #2e3c4c; }
      .status-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
      .tag { display: inline-flex; min-height: 30px; align-items: center; padding: 3px 10px; border: 1px solid #46576b; border-radius: 7px; color: #dce5ed; background: #1a2736; font-size: 13px; }
      .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .stat { padding: 13px; border: 1px solid #2d3d4e; border-radius: 9px; background: #111b27; }
      .stat .field-label { display: block; }
      .stat strong { display: block; margin-top: 7px; color: #f2f6fa; font-size: 19px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
      .list { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
      .memory { padding: 14px 0; border-top: 1px solid #2a3949; }
      .memory:first-child { padding-top: 0; border-top: 0; }
      .memory p { color: #e2e9ef; font-size: 15px; line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; }
      .memory-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 7px; }
      .memory-source { color: #a9dacb; font-size: 12px; }
      .error-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid #2a3949; }
      .error-row:first-child { border-top: 0; padding-top: 0; }
      .error-code { color: #ffc0bd; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; }
      .search-row { display: flex; align-items: end; gap: 12px; max-width: 640px; margin-bottom: 18px; }
      .search-field { flex: 1; min-width: 0; }
      .search-field label { display: block; margin-bottom: 7px; }
      .empty { color: var(--muted); font-size: 14px; line-height: 1.6; }
      .footnote { margin-top: 13px; color: var(--muted); font-size: 12px; line-height: 1.6; }
      [hidden] { display: none !important; }
      @media (max-width: 760px) {
        header, main { width: min(100% - 32px, 640px); }
        header { align-items: flex-start; padding-top: 22px; }
        .updated { display: none; }
        .goal-card, .outcome-card, .usage-card, .memory-card { grid-column: 1 / -1; }
        .card { padding: 17px; }
      }
      @media (max-width: 440px) {
        header, main { width: calc(100% - 28px); }
        header { gap: 10px; }
        .mark { width: 36px; height: 36px; }
        .subtitle { font-size: 13px; }
        .header-actions button { padding-inline: 10px; font-size: 13px; }
        .overview { align-items: flex-start; flex-direction: column; }
        .search-row { align-items: stretch; flex-direction: column; }
        .search-row button { align-self: flex-start; }
        .stats { grid-template-columns: 1fr 1fr; }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="brand">
        <div class="mark" aria-hidden="true">C</div>
        <div>
          <h1>コンパニオン運用状況</h1>
          <p class="subtitle">目標、行動、記憶、モデル利用状況を確認</p>
        </div>
      </div>
      <div class="header-actions">
        <time class="updated" id="updated-at">更新待ち</time>
        <button id="logout" type="button" hidden>認証情報を消す</button>
      </div>
    </header>
    <main>
      <section id="auth-panel" class="auth-card" aria-labelledby="auth-title">
        <h2 id="auth-title">ダッシュボード認証</h2>
        <p>設定済みの場合は、環境変数のダッシュボード認証トークンを入力してください。トークンはこのページ内だけで使います。</p>
        <form id="auth-form" class="auth-form">
          <label for="token-input">認証トークン</label>
          <input id="token-input" name="token" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false">
          <button type="submit">接続</button>
        </form>
        <p id="auth-notice" class="notice" role="status" aria-live="polite">接続を確認しています。</p>
      </section>
      <section id="dashboard" hidden>
        <div class="overview">
          <div>
            <h2>現在の稼働状態</h2>
            <p id="connection-label">接続・判断・停止状態を取得しています。</p>
            <div class="status-row">
              <span id="connection-state" class="tag">接続状態を取得中</span>
              <span id="thinking-state" class="tag">判断状態を取得中</span>
              <span id="stopped-state" class="tag">停止状態を取得中</span>
            </div>
          </div>
          <span id="runtime-status" class="status-pill" data-state="idle" role="status" aria-live="polite">確認中</span>
        </div>
        <div class="grid">
          <section class="card goal-card" aria-labelledby="goal-heading">
            <div class="card-head"><h2 id="goal-heading">目標と計画</h2><span class="eyebrow">Goal / Plan</span></div>
            <p id="goal-title" class="value">取得中</p>
            <div class="rule"></div>
            <p class="field-label">成功条件</p>
            <p id="goal-condition" class="detail">—</p>
            <div class="rule"></div>
            <p class="field-label">計画</p>
            <p id="plan-purpose" class="value">—</p>
            <div class="status-row"><span id="action-state" class="tag">操作なし</span></div>
            <p id="action-description" class="detail">—</p>
            <p id="next-wake" class="meta"></p>
          </section>
          <section class="card outcome-card" aria-labelledby="outcome-heading">
            <div class="card-head"><h2 id="outcome-heading">最後に観測した結果</h2><span class="eyebrow">Observed</span></div>
            <p id="outcome-summary" class="detail">まだ結果はありません。</p>
            <p id="outcome-meta" class="meta"></p>
          </section>
          <section class="card usage-card" aria-labelledby="usage-heading">
            <div class="card-head"><h2 id="usage-heading">LLM利用とエラー（起動後）</h2><span class="eyebrow">Usage</span></div>
            <div class="stats">
              <div class="stat"><span class="field-label">呼び出し</span><strong id="usage-requests">—</strong></div>
              <div class="stat"><span class="field-label">利用量応答</span><strong id="usage-reports">—</strong></div>
              <div class="stat"><span class="field-label">入力トークン</span><strong id="input-tokens">—</strong></div>
              <div class="stat"><span class="field-label">出力トークン</span><strong id="output-tokens">—</strong></div>
            </div>
            <p id="usage-note" class="footnote">利用量が未報告の場合は、不明として表示します。</p>
            <div class="rule"></div>
            <div class="card-head"><h2 id="errors-heading">最近のエラーコード</h2><span id="error-count" class="tag">0 件</span></div>
            <ul id="error-list" class="list"></ul>
            <p id="error-empty" class="empty">記録されたエラーはありません。</p>
          </section>
          <section class="card memory-card" aria-labelledby="memory-heading">
            <div class="card-head"><h2 id="memory-heading">有効な記憶</h2><span class="eyebrow">Memory</span></div>
            <form id="search-form" class="search-row">
              <div class="search-field">
                <label for="memory-query" class="field-label">記憶を検索</label>
                <input id="memory-query" type="search" maxlength="200" placeholder="目標や出来事の語句">
              </div>
              <button type="submit">検索</button>
            </form>
            <ul id="memory-list" class="list"></ul>
            <p id="memory-empty" class="empty">一致する有効な記憶はありません。</p>
          </section>
        </div>
      </section>
      <p id="page-notice" class="notice" role="status" aria-live="polite"></p>
    </main>
    <script nonce="__NONCE__">
      (() => {
        const byId = (id) => document.getElementById(id);
        const authPanel = byId("auth-panel");
        const dashboard = byId("dashboard");
        const tokenInput = byId("token-input");
        const authNotice = byId("auth-notice");
        const pageNotice = byId("page-notice");
        const queryInput = byId("memory-query");
        let bearerToken = "";
        let refreshTimer = 0;
        let searchTimer = 0;
        let loading = false;
        let hasSnapshot = false;

        const setText = (id, value) => {
          byId(id).innerText = value === null || value === undefined || value === "" ? "—" : String(value);
        };
        const formatCount = (value) => value === null || value === undefined ? "未報告" : Number(value).toLocaleString("ja-JP");
        const formatTime = (value) => {
          if (!value) return "";
          const date = new Date(value);
          return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ja-JP");
        };
        const sourceLabels = {
          player_stated: "本人の発言",
          minecraft_observed: "Minecraftで観測",
          bot_inferred: "コンパニオンの推測",
          system: "システム",
        };
        const connectionLabels = {
          idle: "未接続",
          connecting: "接続中",
          connected: "接続済み",
          reconnecting: "再接続中",
          failed: "接続失敗",
          stopped: "終了",
        };
        const operationLabels = {
          move_to: "指定位置へ移動",
          move_relative: "相対移動",
          look: "視線を向ける",
          look_sweep: "周囲を見回す",
          control: "移動操作",
          equip: "装備",
          use: "アイテムを使う",
          attack: "攻撃",
          dig: "採掘",
          place: "設置",
          craft: "クラフト",
          collect_item: "アイテムを回収",
          consume: "食べる",
          sleep: "眠る",
          trade: "取引",
          fish: "釣り",
        };
        const outcomeLabels = {
          successful: "確認済み",
          failed: "失敗",
          interrupted: "中断",
          cancelled: "取消",
          unverified: "未確認",
        };
        function showLogin(message) {
          dashboard.hidden = true;
          authPanel.hidden = false;
          authNotice.innerText = message;
          byId("logout").hidden = true;
          if (hasSnapshot) tokenInput.focus();
        }
        function scheduleRefresh(delay) {
          window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => {
            if (!document.hidden) void loadSnapshot();
            else scheduleRefresh(30000);
          }, delay);
        }
        function renderSnapshot(snapshot) {
          const runtime = snapshot.runtime;
          const state = runtime.stopped
            ? ["停止中", "stopped"]
            : runtime.currentOperation !== null || snapshot.activeOperation !== null
              ? ["操作中", "busy"]
              : runtime.thinking
                ? ["判断中", "busy"]
                : runtime.running
                  ? ["待機中", "active"]
                  : ["未起動", "idle"];
          const statusPill = byId("runtime-status");
          statusPill.innerText = state[0];
          statusPill.dataset.state = state[1];
          setText("connection-label", "現在の状態を表示しています。");
          setText("connection-state", connectionLabels[snapshot.connectionState] || "不明");
          setText("thinking-state", runtime.thinking ? "判断中" : runtime.running ? "待機中" : "停止中");
          setText("stopped-state", runtime.stopped ? "停止中" : "自律実行を許可");

          const goal = runtime.goal;
          setText("goal-title", goal ? goal.title : "目標なし");
          setText("goal-condition", goal ? goal.successCondition : "現在設定されている目標はありません。");
          setText("plan-purpose", snapshot.plan ? snapshot.plan.purpose : "実行計画はありません。");
          const action = snapshot.activeOperation
            ? { value: snapshot.activeOperation, state: "実行中の操作" }
            : snapshot.plan && snapshot.plan.firstStep
              ? { value: snapshot.plan.firstStep, state: "次の操作" }
              : null;
          setText("action-state", action ? action.state : "操作なし");
          setText("action-description", action ? (operationLabels[action.value.kind] || action.value.kind) + " — " + action.value.expectedOutcome : "目標の再判断または待機中です。");
          setText("next-wake", runtime.nextWakeAt ? "次の確認予定: " + formatTime(runtime.nextWakeAt) : "");

          const outcome = runtime.lastOutcome;
          setText("outcome-summary", outcome ? outcome.summary : "まだ観測された結果はありません。");
          setText("outcome-meta", outcome ? (outcomeLabels[outcome.status] || "結果") + " · " + (operationLabels[outcome.operationKind] || outcome.operationKind) + " · " + formatTime(outcome.observedAt) : "");

          const usage = runtime.usage;
          setText("usage-requests", formatCount(usage.requests));
          setText("usage-reports", formatCount(usage.usageResponses));
          setText("input-tokens", formatCount(usage.inputTokens));
          setText("output-tokens", formatCount(usage.outputTokens));
          const missingUsage = Number(usage.missingUsageRequests || 0);
          const cacheLabel = formatCount(usage.cachedInputTokens);
          setText("usage-note", "エラー " + formatCount(usage.errors) + " 件 · キャッシュ入力 " + cacheLabel + (missingUsage > 0 ? " · " + missingUsage.toLocaleString("ja-JP") + " 回は利用量未報告" : " · 利用量は起動後の累計"));

          const errors = Array.isArray(runtime.recentErrors) ? runtime.recentErrors : [];
          const errorList = byId("error-list");
          errorList.replaceChildren();
          for (const error of errors) {
            const item = document.createElement("li");
            item.className = "error-row";
            const code = document.createElement("span");
            code.className = "error-code";
            code.innerText = String(error.code || "UNKNOWN");
            const time = document.createElement("time");
            time.className = "meta";
            time.dateTime = String(error.at || "");
            time.innerText = formatTime(error.at) || "時刻不明";
            item.append(code, time);
            errorList.append(item);
          }
          byId("error-empty").hidden = errors.length > 0;
          setText("error-count", errors.length.toLocaleString("ja-JP") + " 件");

          const memories = Array.isArray(snapshot.memories) ? snapshot.memories : [];
          const memoryList = byId("memory-list");
          memoryList.replaceChildren();
          for (const memory of memories) {
            const item = document.createElement("li");
            item.className = "memory";
            const content = document.createElement("p");
            content.innerText = String(memory.content || "");
            const metadata = document.createElement("div");
            metadata.className = "memory-meta";
            const source = document.createElement("span");
            source.className = "memory-source";
            source.innerText = sourceLabels[memory.source] || "出典不明";
            const time = document.createElement("time");
            time.className = "meta";
            time.dateTime = String(memory.updatedAt || "");
            time.innerText = formatTime(memory.updatedAt) || "日時不明";
            metadata.append(source, time);
            item.append(content, metadata);
            memoryList.append(item);
          }
          byId("memory-empty").hidden = memories.length > 0;
          setText("updated-at", formatTime(snapshot.generatedAt) || "更新済み");
          dashboard.hidden = false;
          authPanel.hidden = true;
          byId("logout").hidden = bearerToken.length === 0;
          pageNotice.innerText = "";
          hasSnapshot = true;
        }
        async function loadSnapshot() {
          if (loading) return;
          loading = true;
          try {
            const headers = new Headers();
            if (bearerToken.length > 0) headers.set("Authorization", "Bearer " + bearerToken);
            const query = queryInput.value.trim();
            const suffix = query.length === 0 ? "" : "?q=" + encodeURIComponent(query);
            const response = await fetch("/api/snapshot" + suffix, {
              method: "GET",
              headers,
              cache: "no-store",
              credentials: "omit",
              redirect: "error",
            });
            if (response.status === 401) {
              bearerToken = "";
              showLogin("認証トークンを入力してください。");
              return;
            }
            if (!response.ok) throw new Error("dashboard_unavailable");
            const snapshot = await response.json();
            renderSnapshot(snapshot);
            scheduleRefresh(15000);
          } catch {
            if (!hasSnapshot) showLogin("接続できません。ローカルサーバーの状態を確認してください。");
            else pageNotice.innerText = "最新情報を取得できません。表示中の内容は前回の取得時点です。";
            scheduleRefresh(30000);
          } finally {
            loading = false;
          }
        }
        byId("auth-form").addEventListener("submit", (event) => {
          event.preventDefault();
          bearerToken = tokenInput.value;
          tokenInput.value = "";
          authNotice.innerText = "認証を確認しています。";
          void loadSnapshot();
        });
        byId("search-form").addEventListener("submit", (event) => {
          event.preventDefault();
          void loadSnapshot();
        });
        queryInput.addEventListener("input", () => {
          window.clearTimeout(searchTimer);
          searchTimer = window.setTimeout(() => void loadSnapshot(), 350);
        });
        byId("logout").addEventListener("click", () => {
          bearerToken = "";
          showLogin("認証情報を消去しました。再接続するにはトークンを入力してください。");
          window.clearTimeout(refreshTimer);
        });
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden && hasSnapshot) void loadSnapshot();
        });
        void loadSnapshot();
      })();
    </script>
  </body>
</html>`;

export function renderDashboardPage(nonce: string): string {
  return page.replaceAll("__NONCE__", nonce);
}
