---
name: companion-conversation-inspection
description: "ユーザーやBotの発話を、Minecraftコンパニオンの保存履歴とserver側の記録で確認する。"
---

# コンパニオン会話の確認

## 発動条件

ユーザーやBotの発話有無、内容、時間を確認する時に使います。
まずjournalを範囲指定で読み、DBにない場合やserver送信を確かめる時はserver logで補います。

実環境の観測とcode上の推測は[production-investigation](../production-investigation/SKILL.md)に従います。
公開時は[security-publication](../security-publication/SKILL.md)と[checklist](../../../docs/security-publication-checklist.md)を参照します。

## 何が保存されるか

- `DATABASE_PATH` の既定は `data/companion.sqlite` です。相対pathは起動時の作業directoryを基準にします。
  実値は依頼者指定かsecretを含まない設定から特定し、`.env`やcredentialを表示しません。DBを確定できなければ推測せず止めます。
- 現行schemaは `companion_journal` の `kind`, `role`, `content`, `recorded_at` を使います。
  会話のroleは `owner` / `companion` で、ownerのMinecraft usernameやserver identityはmessage rowに保存されません。
  現在の `OWNER_USERNAME` や `DATABASE_PATH` だけでは過去のowner/runtimeを確定できません。
  `recorded_at` はSQLiteへの保存時刻で、ゲーム内発話時刻や表示時刻とは限りません。
- owner発話はBotのchat eventからowner identityを照合し、前後空白を除去して最大2,000文字にした後に記録します。
  空文、他player、Bot自身のechoは会話履歴に入りません。
  停止中の通常発話や重複follow要求も記録されない分岐があります。
- companion発話は送信関数が戻った後に記録されます。
  `minecraft.say()` はMineflayerの `bot.chat()` を呼び、server受信・配信確認を待ちません。
  DB行は送信関数が戻った後の保存を示します。正規化後が空ならclient送信は省略されます。
  それ以外でもserver受信やplayer画面表示は証明せず、保存失敗後に送信済みの場合もあります。
- 送信前のsanitizeは改行を空白へまとめ、空白を正規化し、slash command guardを加え、本文を最大2,000文字に切り詰めます。
  送信処理はprotocol/configに応じてpacketを分割します。journalにはsanitize前のruntime本文がstore上限内で記録されるため、表示文はjournal本文と異なることがあります。
  根拠は[application wiring](../../../src/app/application.ts)と[Mineflayer transport](../../../src/minecraft/mineflayer-client.ts)です。
- journalはmessageとoperation outcomeを合わせた上限付きです。
  既定256件、最大2,000件で、追加時に古い行から削除されます。
  履歴が見つからないことは発話がなかった証拠になりません。

実装根拠: [config](../../../src/config/schema.ts)、[journal](../../../src/player/store.ts)、
[runtime](../../../src/player/runtime.ts)、[Mineflayer](../../../src/minecraft/mineflayer-client.ts)、[application](../../../src/app/application.ts)。

## read-onlyで履歴を調べる

対象speaker、UTCの開始・終了、必要なら検索語を先に依頼範囲から確定します。
相対pathはアプリ起動directoryを基準に解決し、recipeには確認済みの絶対pathを渡します。
`CompanionStore.open()` はschema作成、legacy migration、interrupted operation recoveryを行うので、調査に使いません。
他playerの発話はDBに保存されません。対象instanceとhistorical owner/runtimeを独立したread-only根拠で対応づけられない場合は、帰属を未確認とし、server logで補います。

次のPython recipeはURIの `mode=ro` と `query_only` を併用し、確認済みの絶対path、speaker、UTC時間を設定します。
SQL値はすべてparameterで渡します。
対話型Python REPLで実行し、本文は最大20件をローカル変数へ保持して自動表示しません。
件数が上限を超えたら期間を狭めて再照会し、全件を見ていない状態で不在判定をしません。

```python
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

database_path = Path("/absolute/path/provided-for-this-investigation")
speaker = "companion"  # "owner" or "companion"
since_utc = "2026-10-10T00:00:00.000Z"
until_utc = "2026-10-11T00:00:00.000Z"  # exclusive
limit = 20
body_limit = 500  # 1-2,000; use 2,000 only with a very small row limit
connection = None
timestamp_format = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"

try:
    if (
        not database_path.is_absolute()
        or speaker not in {"owner", "companion"}
        or not 1 <= limit <= 20
        or not 1 <= body_limit <= 2000
        or limit * body_limit > 10000
    ):
        print("Invalid path or bounded query parameters.")
        raise SystemExit(0)
    if any(
        re.fullmatch(timestamp_format, value) is None
        for value in (since_utc, until_utc)
    ):
        print("Use canonical UTC timestamps with millisecond precision.")
        raise SystemExit(0)
    datetime.fromisoformat(since_utc.replace("Z", "+00:00"))
    datetime.fromisoformat(until_utc.replace("Z", "+00:00"))
    if since_utc >= until_utc:
        print("Use an ordered UTC ISO-8601 interval ending in Z.")
        raise SystemExit(0)

    uri = "file:" + quote(str(database_path.resolve()), safe="/") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=1)
    connection.execute("PRAGMA query_only = ON")
    connection.execute("BEGIN")
    columns = {
        row[1] for row in connection.execute("PRAGMA table_info(companion_journal)")
    }
    required = {"journal_id", "kind", "role", "content", "recorded_at"}
    if not required.issubset(columns):
        print("Conversation schema is unavailable; no migration was attempted.")
        raise SystemExit(0)

    timestamps = connection.execute(
        "SELECT recorded_at FROM companion_journal "
        "WHERE kind = 'message' AND role = ? ORDER BY journal_id DESC LIMIT ?",
        (speaker, 2001),
    ).fetchall()
    if len(timestamps) > 2000:
        print("Journal history exceeds the bounded scan; time scope is incomplete.")
        raise SystemExit(0)
    for (recorded_at,) in timestamps:
        if re.fullmatch(timestamp_format, recorded_at) is None:
            raise ValueError
        datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))

    where = "kind = 'message' AND role = ? AND recorded_at >= ? AND recorded_at < ?"
    parameters = (speaker, since_utc, until_utc)
    total = connection.execute(
        f"SELECT COUNT(*) FROM companion_journal WHERE {where}", parameters
    ).fetchone()[0]
    rows = connection.execute(
        f"SELECT role, recorded_at, content FROM companion_journal WHERE {where} "
        "ORDER BY recorded_at, journal_id LIMIT ?",
        (*parameters, limit),
    ).fetchall()
    selected_rows = [
        (role, recorded_at, content[:body_limit], len(content) > body_limit)
        for role, recorded_at, content in rows
    ]
    match_summary = {
        "matches": total,
        "shown": len(selected_rows),
        "output_truncated": total > len(rows),
    }
except sqlite3.Error:
    print("Read-only SQLite query unavailable.")
except (ValueError, TypeError, AttributeError, OverflowError):
    print("Timestamp format is unsupported; UTC time scope is unavailable.")
except Exception:
    print("Read-only extraction failed; inspect locally.")
finally:
    if connection is not None:
        try:
            connection.close()
        except sqlite3.Error:
            pass
```

現行writerは `toISOString()` によるUTC ISO-8601を保存します。
recipeはspeakerごとに最大2,001件の時刻だけを先に読み、全件が現行形式か確かめてから本文を取得します。
異なるtimestamp形式、schema不足、2,000件を超える履歴は時間範囲を未確認としてserver logへ切り替えます。
時刻変換を推測したりDBをmigrationしたりしません。

`selected_rows` と `match_summary` はローカル変数として扱います。まずprivateな実行環境内で必要な行だけを確認し、
credentialらしい内容や判断できない機密があれば本文を出力せず、固定の失敗分類だけを返します。
本文を返す場合も依頼で必要なspeaker・時刻・範囲だけを選び、raw DBや例外文を出力しません。

## server記録との照合

DB行がない場合やserverへの到達を確かめる場合は、対象instanceとtimezoneをread-onlyで確定します。
該当時間帯・speakerのserver-side logだけをローカル処理で抽出します。
server製品ごとに形式が異なるため、確認済みのlog pathとparserを使い、無関係な範囲を走査・表示しません。
raw logを会話へ貼らず、必要なspeaker・時刻・本文だけに絞り、出力件数と本文長を制限します。

このアプリのloggerはchat本文を記録しません。server logがchatを記録しない設定なら不在から発話有無を判断できず、
一致もそのlogの記録だけを示し、全playerの画面表示までは示しません。

## 判定と報告

- DB結果は「確認したruntimeのDBに残る保存履歴」、server logは「対象serverが記録した事実」、
  Mineflayer `bot.chat()` は「client側の送信呼出」として区別します。
  DB照会の現在時刻はMinecraft内の現在表示を意味しません。
- 該当行がなければ「指定した保持範囲のDBに一致する保存行なし」と報告します。
  retention、owner/Bot filtering、送信後の保存失敗、期間やschemaの不一致を含むため、
  「発話なし」とは結論しません。
- 該当行があればspeaker、`recorded_at`、必要な本文範囲と証拠種別を示します。
  公開用Issue、PR、artifactへ会話本文やraw logを転記せず、公開基準に沿った要約だけを使います。
