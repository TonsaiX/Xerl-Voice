-- schema.sql
-- Xerl-Voice: Join-to-Create (multi) + per-JTC category + voice room controls + detailed logs
-- Works for fresh install and safe migration for existing schemas.

BEGIN;

-- =========================
-- 1) guild_config
-- - เก็บ config ระดับ guild
--   control_text_id: ห้องแผงควบคุม (Embed + Buttons)
--   log_text_id: ห้อง log (Embed)
--   category_id: default category (fallback)
-- =========================
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id        TEXT PRIMARY KEY,
  control_text_id TEXT,
  category_id     TEXT,
  log_text_id     TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Migrate columns for older versions
ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS control_text_id TEXT,
  ADD COLUMN IF NOT EXISTS category_id     TEXT,
  ADD COLUMN IF NOT EXISTS log_text_id     TEXT,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW();

-- =========================
-- 2) jtc_channels
-- - Join-to-Create หลายห้องต่อ guild
-- - category_id ต่อห้อง (แยกหมวด)
-- =========================
CREATE TABLE IF NOT EXISTS jtc_channels (
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  category_id TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (guild_id, channel_id)
);

-- Migrate columns for older versions
ALTER TABLE jtc_channels
  ADD COLUMN IF NOT EXISTS category_id TEXT,
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_jtc_channels_guild
  ON jtc_channels (guild_id);

-- Backfill: ถ้าเป็นข้อมูลเก่า category_id ยังว่าง -> เติมด้วย default category ใน guild_config
UPDATE jtc_channels jc
SET category_id = gc.category_id
FROM guild_config gc
WHERE jc.guild_id = gc.guild_id
  AND (jc.category_id IS NULL OR jc.category_id = '');

-- =========================
-- 3) voice_rooms
-- - เก็บห้องที่ระบบสร้าง + เจ้าของ
-- =========================
CREATE TABLE IF NOT EXISTS voice_rooms (
  guild_id    TEXT NOT NULL,
  channel_id  TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_rooms_guild_owner
  ON voice_rooms (guild_id, owner_id);

-- =========================
-- 4) voice_room_logs
-- - log ละเอียดทุก action
-- - metadata เป็น JSONB เก็บรายละเอียดเพิ่ม
-- =========================
CREATE TABLE IF NOT EXISTS voice_room_logs (
  id             SERIAL PRIMARY KEY,
  guild_id        TEXT NOT NULL,
  action          TEXT NOT NULL,  -- CREATE_ROOM, DELETE_ROOM, LOCK, UNLOCK, SET_LIMIT, RENAME, MEMBER_JOIN, MEMBER_LEAVE, MEMBER_MOVE, MOVE_OWNER_SUCCESS, MOVE_OWNER_FAILED
  channel_id      TEXT,
  owner_id        TEXT,
  actor_id        TEXT,
  target_user_id  TEXT,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Migrate columns for older versions
ALTER TABLE voice_room_logs
  ADD COLUMN IF NOT EXISTS channel_id     TEXT,
  ADD COLUMN IF NOT EXISTS owner_id       TEXT,
  ADD COLUMN IF NOT EXISTS actor_id       TEXT,
  ADD COLUMN IF NOT EXISTS target_user_id TEXT,
  ADD COLUMN IF NOT EXISTS metadata       JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_voice_room_logs_guild_time
  ON voice_room_logs (guild_id, created_at DESC);

-- เพิ่ม index สำหรับค้นหา log ต่อห้อง/owner เร็วขึ้น (optional)
CREATE INDEX IF NOT EXISTS idx_voice_room_logs_channel_time
  ON voice_room_logs (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_voice_room_logs_owner_time
  ON voice_room_logs (owner_id, created_at DESC);

COMMIT;
