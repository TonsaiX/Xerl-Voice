// db.js
// คอมเมนต์: ชั้นฐานข้อมูล PostgreSQL
// ✅ รองรับ migration schema เก่า -> ใหม่ โดยไม่ต้องลบตาราง
//
// ตาราง:
// - guild_config: config หลักของ guild (control/log/default category)
// - jtc_channels: ห้อง join-to-create (หลายห้อง) + category ต่อห้อง
// - voice_rooms: ห้องที่สร้าง + owner
// - voice_room_logs: log ละเอียด (actor/target/metadata JSONB)

require("dotenv").config();
const { Pool } = require("pg");

// คอมเมนต์: เปิด SSL เฉพาะเมื่อ URL ระบุ sslmode=...
const url = process.env.DATABASE_URL || "";
const wantsSSL = /sslmode=(require|verify-full|verify-ca)/i.test(url);

const pool = new Pool({
  connectionString: url,
  ssl: wantsSSL ? { rejectUnauthorized: false } : false
});

// คอมเมนต์: helper query
async function q(text, params = []) {
  return pool.query(text, params);
}

async function initDb() {
  // ===== guild_config =====
  await q(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      control_text_id TEXT,
      category_id TEXT,
      log_text_id TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ✅ migrate columns เผื่อเป็นตารางเก่า
  await q(`
    ALTER TABLE guild_config
      ADD COLUMN IF NOT EXISTS control_text_id TEXT,
      ADD COLUMN IF NOT EXISTS category_id TEXT,
      ADD COLUMN IF NOT EXISTS log_text_id TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  `);

  // ===== jtc_channels (หลายห้อง + category ต่อห้อง) =====
  await q(`
    CREATE TABLE IF NOT EXISTS jtc_channels (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      category_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (guild_id, channel_id)
    );
  `);

  // ✅ migrate: เพิ่ม category_id ถ้าเคยมีตารางเก่า
  await q(`
    ALTER TABLE jtc_channels
      ADD COLUMN IF NOT EXISTS category_id TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
  `);

  await q(`
    CREATE INDEX IF NOT EXISTS idx_jtc_channels_guild
    ON jtc_channels (guild_id);
  `);

  // ✅ migrate: ถ้า JTC เก่า category_id ยังว่าง -> เติมด้วย default category จาก guild_config
  await q(`
    UPDATE jtc_channels jc
    SET category_id = gc.category_id
    FROM guild_config gc
    WHERE jc.guild_id = gc.guild_id
      AND (jc.category_id IS NULL OR jc.category_id = '');
  `);

  // ===== voice_rooms =====
  await q(`
    CREATE TABLE IF NOT EXISTS voice_rooms (
      guild_id TEXT NOT NULL,
      channel_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await q(`
    CREATE INDEX IF NOT EXISTS idx_voice_rooms_guild_owner
    ON voice_rooms (guild_id, owner_id);
  `);

  // ===== voice_room_logs =====
  await q(`
    CREATE TABLE IF NOT EXISTS voice_room_logs (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      action TEXT NOT NULL,
      channel_id TEXT,
      owner_id TEXT,
      actor_id TEXT,
      target_user_id TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ✅ migrate columns เผื่อเป็นตารางเก่า
  await q(`
    ALTER TABLE voice_room_logs
      ADD COLUMN IF NOT EXISTS channel_id TEXT,
      ADD COLUMN IF NOT EXISTS owner_id TEXT,
      ADD COLUMN IF NOT EXISTS actor_id TEXT,
      ADD COLUMN IF NOT EXISTS target_user_id TEXT,
      ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
  `);

  await q(`
    CREATE INDEX IF NOT EXISTS idx_voice_room_logs_guild_time
    ON voice_room_logs (guild_id, created_at DESC);
  `);
}

module.exports = {
  pool,
  initDb,

  // ===== CONFIG =====
  async getConfig(guildId) {
    const r = await q(
      `SELECT guild_id, control_text_id, category_id, log_text_id
       FROM guild_config
       WHERE guild_id = $1`,
      [guildId]
    );
    return r.rows[0] || null;
  },

  async upsertConfig(guildId, controlTextId, categoryId, logTextId) {
    await q(
      `INSERT INTO guild_config (guild_id, control_text_id, category_id, log_text_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id)
       DO UPDATE SET
         control_text_id = EXCLUDED.control_text_id,
         category_id     = EXCLUDED.category_id,
         log_text_id     = EXCLUDED.log_text_id,
         updated_at      = NOW()`,
      [guildId, controlTextId, categoryId, logTextId]
    );
  },

  // ===== JTC CHANNELS =====
  // ✅ เพิ่ม/อัปเดต JTC พร้อม category ต่อห้อง
  async addJtcChannel(guildId, channelId, categoryId) {
    await q(
      `INSERT INTO jtc_channels (guild_id, channel_id, category_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, channel_id)
       DO UPDATE SET category_id = EXCLUDED.category_id`,
      [guildId, channelId, categoryId]
    );
  },

  async removeJtcChannel(guildId, channelId) {
    await q(
      `DELETE FROM jtc_channels WHERE guild_id = $1 AND channel_id = $2`,
      [guildId, channelId]
    );
  },

  async isJtcChannel(guildId, channelId) {
    const r = await q(
      `SELECT 1 FROM jtc_channels WHERE guild_id = $1 AND channel_id = $2 LIMIT 1`,
      [guildId, channelId]
    );
    return r.rowCount > 0;
  },

  // ✅ ดึง category ของ JTC ห้องนี้
  async getJtcCategory(guildId, channelId) {
    const r = await q(
      `SELECT category_id
       FROM jtc_channels
       WHERE guild_id = $1 AND channel_id = $2`,
      [guildId, channelId]
    );
    return r.rows[0]?.category_id || null;
  },

  // ✅ list พร้อม category_id
  async listJtcChannels(guildId) {
    const r = await q(
      `SELECT channel_id, category_id
       FROM jtc_channels
       WHERE guild_id = $1
       ORDER BY created_at ASC`,
      [guildId]
    );
    return r.rows;
  },

  // ===== ROOMS =====
  async setRoomOwner(guildId, channelId, ownerId) {
    await q(
      `INSERT INTO voice_rooms (guild_id, channel_id, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel_id)
       DO UPDATE SET
         guild_id = EXCLUDED.guild_id,
         owner_id = EXCLUDED.owner_id`,
      [guildId, channelId, ownerId]
    );
  },

  async getRoomOwner(channelId) {
    const r = await q(
      `SELECT guild_id, channel_id, owner_id
       FROM voice_rooms
       WHERE channel_id = $1`,
      [channelId]
    );
    return r.rows[0] || null;
  },

  async deleteRoom(channelId) {
    await q(`DELETE FROM voice_rooms WHERE channel_id = $1`, [channelId]);
  },

  // ===== LOGS =====
  async insertLogDetailed(guildId, action, channelId, ownerId, actorId, targetUserId, metadata = {}) {
    await q(
      `INSERT INTO voice_room_logs
       (guild_id, action, channel_id, owner_id, actor_id, target_user_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [guildId, action, channelId, ownerId, actorId, targetUserId, JSON.stringify(metadata)]
    );
  }
};
