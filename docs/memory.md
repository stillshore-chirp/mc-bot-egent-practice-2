# 人格と記憶

人格設定は `PERSONA_PATH` のJSONから読み、コンパニオンの名前、話し方、価値観、行動原則、禁止事項を提供します。人格とownerとの関係は別の保存状態です。

`CompanionStore` は `DATABASE_PATH` のSQLiteに一つのruntime snapshot、意味検索用の記憶、owner/companion会話、Body結果の上限付きjournalを保存します。snapshotには停止ラッチ、目標、計画、次回判断時刻、進行中操作、直近結果、関係概要、関心が含まれます。記憶は種類、由来、状態、重要度、作成・更新時刻を持ちます。

起動時に既存DBを開く際、Storeは対象ownerの既存状態を新しいschemaへ取り込みます。`OWNER_USERNAME` をStoreへ渡し、別のownerの記憶を混在させません。移行前に既存DBとpersona設定を通常の停止後にバックアップしてください。入力DBを直接書き換える移行が失敗した場合、元ファイルを保全して原因を確認します。

Agentへ渡す記憶と会話は検索と件数で制限されます。ownerが明示した発言の証拠だけをowner発の記憶として扱い、モデルの推測を観測済み事実へ変換しません。journalは上限を持ち、生の会話を無制限に保管しません。

自分の死亡・復活は既存の `life` memoryに、Bodyが確認した時刻と `minecraft_observed` の出所を付けて最新8件まで保存します。時刻はBodyがイベントを受け取った時のUTC時刻で、Minecraft内の時刻ではありません。復活は同じBotの確認済み死亡後に届いたspawnだけを記録し、初回spawnやreconnect、現在の体力、ownerの報告から復活を補いません。遅れて届いた死因は元の `deathAt` と一致する保持中の記録だけへ結び付けます。停止中も事実の保存は行いますが、停止ラッチを変えたり判断やBody操作を起動したりしません。8件より古い記録や旧形式の記憶にない事実はunknownです。Agent入力では現在の体力、過去にBodyが確認した事実、ownerの報告を分けて渡します。

## 操作結果の履歴

`companion_journal` は `message` と `outcome` を別々に保持します。既定256件、設定上限は種類ごとに最大2,000件です。outcomeにはBody dispatch前に保存した宣言目的と限定観測、選択操作、Body開始・完了時刻と出所、前後の限定観測、状態・成否・失敗理由を記録し、未観測値はunknownとして扱います。active markerの `bodyStartedAt` はdispatch前にmarkerを保存した時刻であり、Bodyが実際に開始した証拠ではありません。通常の `bodyEvidence.startedAt` はBody結果に含まれる値を使い、stop/restartで結果を受け取っていない場合は `null` のままです。前後観測は位置・dimension・yaw/pitch・health/food/oxygen・水中等の状態だけです。任意NBT、全inventory、owner会話やcredentialを複製しません。

Agentには直近5件のoutcomeを毎回渡し、それより古い目的は宣言目的を含めた既存episode memoryのlexical recallで参照できます。記憶件数・会話入力上限と256件のoutcome保持境界を超える履歴の到達は保証しません。欠けた記録から目的や過去の理由を推測しません。

家の記憶は、村人と同じHOME基準であるbedのhead位置をHOME POIとして扱い、Bodyが確認できるload済み範囲の128ブロック以内を調べて保存します。Agent入力には最新8件までを参照として渡します。これは建物形状や居住者の確定ではありません。平床と閉じた木製ドアの限定観測はHOMEとdoorの対応を示す補助証拠で、屋根はHOME成立基準ではありません。未ロード、上限到達、複雑な構造、曖昧な対応はunknownとし、固定TTLを設けません。保存したdoor関係は観測時点の記録です。利用時はfreshなBody観測で確かめ、既存の`move_to` / `use`操作を判断します。

すでに開いている `CompanionStore` では `readOutcomeHistory({ from, to, limit })` を使い、ミリ秒付きUTC形式 `YYYY-MM-DDTHH:mm:ss.sssZ` の半開区間 `[from, to)` と1〜200件の上限を指定します。戻り値の `matchedCount` / `truncatedByLimit` は件数不足を、`retained` の `coverageFrom` / `evictedThrough` / `evictedCount` と `unavailableBefore` は保証範囲を示します。`truncatedByLimit=true` は照会上限で結果が切り詰められたこと、`unavailableBefore=true` は保持境界より前やevictionと重なるため過去期間を確認できないことを示し、どちらかがtrueなら `complete=false` です。後者は実際に欠落した証明ではありません。`complete=true` が示すのは保持されたoutcomeの範囲だけで、待機中・未記録の操作がなかった証明にはなりません。`recorded_at` は `outcome.observedAt` 由来で、通常のBody結果では `completedAt`、stop/restartではその判定時刻です。期間検索の基準であり、DBへの実書込時刻やBody開始時刻と同一視しません。古いoutcomeに `purpose`、`preActionObservation`、`bodyEvidence` がなければ、欠けた項目はunknownです。`bodyEvidence.startedAt` がnullまたは未記録の場合、実際のBody開始時刻はunknownです。

停止済みの既存DBを調査する場合は `CompanionStore.open()` を使いません。起動時の作業directoryからDBの絶対pathを確定し、SQLite URIの `mode=ro` と `PRAGMA query_only=ON` で、期間・上限を指定して読むだけにします。下の例は件数・保持境界を集計し、outcome本体はローカル変数に留めます。pathと時刻は確認済みの値に置き換えます。調査時は標準出力・標準エラーをprivateなローカルartifactへ捕捉し、会話や公開先へ出すのは集計項目だけにします。失敗時は例外本文を表示せず、固定メッセージだけを返します。

```python
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

database_path = Path("/absolute/path/to/companion.sqlite")
from_utc = "2026-10-10T00:00:00.000Z"
to_utc = "2026-10-11T00:00:00.000Z"  # exclusive
limit = 20
timestamp_format = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z")


def parse_utc_millis(value):
    if not isinstance(value, str) or timestamp_format.fullmatch(value) is None:
        raise ValueError
    parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    if parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") != value:
        raise ValueError
    return parsed


connection = None
try:
    from_time = parse_utc_millis(from_utc)
    to_time = parse_utc_millis(to_utc)
    if (
        not database_path.is_absolute()
        or not 1 <= limit <= 200
        or from_time >= to_time
    ):
        raise ValueError

    uri = "file:" + quote(str(database_path.resolve()), safe="/") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=1)
    connection.execute("PRAGMA query_only = ON")
    connection.execute("BEGIN")
    state_row = connection.execute(
        "SELECT payload_json FROM companion_runtime_state WHERE singleton_id = 1"
    ).fetchone()
    retention = (
        None if state_row is None else json.loads(state_row[0]).get("outcomeRetention")
    )
    matched = connection.execute(
        "SELECT COUNT(*) FROM companion_journal WHERE kind='outcome' AND recorded_at >= ? AND recorded_at < ?",
        (from_utc, to_utc),
    ).fetchone()[0]
    rows = connection.execute(
        "SELECT payload_json, recorded_at FROM companion_journal WHERE kind='outcome' AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at, journal_id LIMIT ?",
        (from_utc, to_utc, limit + 1),
    ).fetchall()
    retained = connection.execute(
        "SELECT COUNT(*), MIN(recorded_at), MAX(recorded_at) FROM companion_journal WHERE kind='outcome'"
    ).fetchone()
    selected_outcomes = [json.loads(payload) for payload, _ in rows[:limit]]
    truncated = matched > limit or len(rows) > limit
    coverage = None if retention is None else retention.get("coverageFrom")
    evicted_through = None if retention is None else retention.get("evictedThrough")
    unavailable_before = (
        coverage is None
        or from_utc < coverage
        or (evicted_through is not None and from_utc <= evicted_through)
    )
    complete = not unavailable_before and not truncated
    summary = {
        "matched": matched,
        "shown": len(selected_outcomes),
        "truncated": truncated,
        "complete": complete,
        "retained": retained,
        "coverageFrom": coverage,
        "evictedCount": None if retention is None else retention.get("evictedCount"),
        "evictedThrough": evicted_through,
        "unavailableBefore": unavailable_before,
        "legacyUnknownShown": sum(
            "purpose" not in entry or "bodyEvidence" not in entry
            for entry in selected_outcomes
        ),
    }
except Exception:
    raise RuntimeError("Read-only history inspection failed.") from None
finally:
    if connection is not None:
        try:
            connection.close()
        except Exception:
            raise RuntimeError("Read-only history inspection failed.") from None
```

この手順はread-only照会です。`selected_outcomes` には位置などのprivate観測が含まれ得るため、必要な行をprivate環境内で確認し、raw行・会話・座標をIssue、PR、ログへ貼りません。metadataがない、期間が保持境界より古い、evictionと重なる、または `truncated` の場合は履歴の不足または確認不能を明記します。`complete` は保持されたoutcomeの範囲に限られ、Botが待機していた時間や未記録操作の不存在は示しません。

管理画面は現在の目標、記憶、履歴から安全な表示項目だけを読み出します。tokenやcredentialを記憶・画面へ出しません。運用手順は [operations](operations.md)、画面の認証は [dashboard](dashboard.md) を参照してください。
