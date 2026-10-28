import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Lower only ASCII, just like the final LIKE predicate. A case-sensitive trigram
// tokenizer preserves non-ASCII distinctions and literal punctuation in substrings.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existing =
    yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'`;
  if (existing.length > 0) return;
  yield* sql`CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(text, tokenize='trigram case_sensitive 1')`;
  yield* sql`INSERT INTO orchestration_v2_message_search(rowid, text)
    SELECT rowid, lower(json_extract(payload_json, '$.text'))
    FROM orchestration_v2_projection_messages
    WHERE streaming = 0 AND role IN ('user', 'assistant')`;
  yield* sql`CREATE TRIGGER orchestration_v2_message_search_insert
    AFTER INSERT ON orchestration_v2_projection_messages
    WHEN new.streaming = 0 AND new.role IN ('user', 'assistant') BEGIN
      INSERT INTO orchestration_v2_message_search(rowid, text)
      VALUES (new.rowid, lower(json_extract(new.payload_json, '$.text')));
    END`;
  yield* sql`CREATE TRIGGER orchestration_v2_message_search_delete
    AFTER DELETE ON orchestration_v2_projection_messages BEGIN
      DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid;
    END`;
  yield* sql`CREATE TRIGGER orchestration_v2_message_search_update
    AFTER UPDATE ON orchestration_v2_projection_messages
    WHEN old.streaming = 0 OR new.streaming = 0 BEGIN
      DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid;
      INSERT INTO orchestration_v2_message_search(rowid, text)
      SELECT new.rowid, lower(json_extract(new.payload_json, '$.text'))
      WHERE new.streaming = 0 AND new.role IN ('user', 'assistant');
    END`;
});
