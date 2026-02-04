// index.js
// ✅ ไม่ใช้ privileged intents
// ใช้แค่ Guilds + GuildVoiceStates
//
// ฟีเจอร์:
// - Join-to-Create หลายห้อง + แยก Category ต่อห้องได้
// - สร้างห้อง + ย้ายเจ้าของเข้าไป (เพิ่ม overwrite ให้ตัวบอทกัน category deny)
// - ลบห้องเมื่อว่าง
// - Controls: lock/unlock/limit/rename (Buttons + Modals)
// - แอดมินคุมห้องคนอื่นได้ (admin override)
// - Log ละเอียด: DB + ส่ง Embed ไปห้อง log
//
// ✅ Fix สำคัญ:
// - Modal (showModal) ต้องเป็น "การตอบครั้งแรก" ของ interaction เท่านั้น
// - ดังนั้น ห้าม deferReply() ก่อน showModal()
// - แก้โดย "แยก flow" ตามปุ่ม: lock/unlock -> deferReply, limit/rename -> showModal ทันที

require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const {
  pool,
  initDb,
  getConfig,
  isJtcChannel,
  getJtcCategory,
  setRoomOwner,
  getRoomOwner,
  deleteRoom,
  insertLogDetailed
} = require("./db");

// =========================
// 0) สร้าง Client
// =========================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel]
});

// =========================
// 1) โหลด Commands
// =========================
client.commands = new Map();
const commandsPath = path.join(__dirname, "commands");

for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"))) {
  const cmd = require(path.join(commandsPath, file));
  client.commands.set(cmd.data.name, cmd);
}

// =========================
// 2) Helper: ส่ง Embed ไปห้อง log
// =========================
async function sendLogEmbed(guild, cfg, embed) {
  try {
    if (!cfg?.log_text_id) return;

    const ch =
      guild.channels.cache.get(cfg.log_text_id) ||
      (await guild.channels.fetch(cfg.log_text_id).catch(() => null));

    if (!ch) return;
    return ch.send({ embeds: [embed] });
  } catch (err) {
    console.error("sendLogEmbed error:", err);
  }
}

// =========================
// 3) Helper: สร้าง Embed log
// =========================
function buildLogEmbed({ title, action, channelId, ownerId, actorId, targetUserId, metadata }) {
  const e = new EmbedBuilder()
    .setTitle(title)
    .addFields(
      { name: "Action", value: `\`${action}\``, inline: true },
      { name: "Channel", value: channelId ? `<#${channelId}>` : "N/A", inline: true },
      { name: "Owner", value: ownerId ? `<@${ownerId}>` : "N/A", inline: true }
    )
    .setFooter({ text: "Xerl Voice • Detailed Logs" })
    .setTimestamp();

  if (actorId) e.addFields({ name: "Actor", value: `<@${actorId}>`, inline: true });
  if (targetUserId) e.addFields({ name: "Target", value: `<@${targetUserId}>`, inline: true });

  if (metadata && Object.keys(metadata).length) {
    const lines = Object.entries(metadata)
      .slice(0, 10)
      .map(([k, v]) => `• **${k}**: ${String(v)}`);

    e.addFields({ name: "Details", value: lines.join("\n"), inline: false });
  }

  return e;
}

// =========================
// 4) Helper: ตรวจว่า user คุมห้องนี้ได้ไหม (owner หรือ admin)
// =========================
async function getUserControllableVoiceChannel(interaction) {
  const member = interaction.member;
  const vc = member?.voice?.channel;

  if (!vc) return { ok: false, msg: "❌ คุณต้องอยู่ในห้องเสียงก่อน" };

  const room = await getRoomOwner(vc.id);
  if (!room) return { ok: false, msg: "❌ ห้องนี้ไม่ใช่ห้องที่ระบบสร้างไว้" };

  const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
  const isOwner = room.owner_id === interaction.user.id;

  if (!isOwner && !isAdmin) {
    return { ok: false, msg: "❌ คุณไม่ใช่เจ้าของห้อง (หรือไม่ใช่แอดมิน)" };
  }

  return { ok: true, channel: vc, ownerId: room.owner_id, isAdmin, isOwner };
}

// =========================
// 5) Helper: เช็ค owned room
// =========================
async function isOwnedRoom(channelId) {
  if (!channelId) return null;
  return await getRoomOwner(channelId);
}

// =========================
// 6) Ready (clientReady)
// =========================
client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    await initDb();
    console.log("✅ Database initialized.");
  } catch (err) {
    console.error("❌ Database init failed:", err);
    console.log("⚠️ Running without database (some features may not work).");
  }
});

// =========================
// 7) VoiceStateUpdate
// =========================
client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    // คอมเมนต์: ถ้า channel ไม่เปลี่ยน ไม่ต้องทำอะไร
    if (oldState.channelId === newState.channelId) return;

    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    // คอมเมนต์: ต้อง /setup ก่อนถึงจะมี config
    const cfg = await getConfig(guild.id);
    if (!cfg?.category_id) return;

    // ---------------------------------
    // 7.1 JOIN-TO-CREATE (หลายห้อง)
    // ---------------------------------
    if (newState.channelId) {
      const isJtc = await isJtcChannel(guild.id, newState.channelId);

      if (isJtc) {
        const member = newState.member;
        if (!member) return;

        // คอมเมนต์: ใช้ category ตาม JTC ห้องนั้น (ถ้าไม่มี -> ใช้ default category)
        const jtcCategoryId = await getJtcCategory(guild.id, newState.channelId);
        const parentCategoryId = jtcCategoryId || cfg.category_id;

        // คอมเมนต์: สร้างห้องใหม่
        const createdChannel = await guild.channels.create({
          name: `🎧 ${member.user.username}`,
          type: ChannelType.GuildVoice,
          parent: parentCategoryId,

          // ✅ สำคัญ: ใส่ overwrite ให้ bot ด้วยกัน category deny ทับ
          permissionOverwrites: [
            // everyone: เริ่มต้นเข้าได้
            {
              id: guild.roles.everyone.id,
              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]
            },
            // owner: จัดการห้องได้
            {
              id: member.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.ManageChannels,
                PermissionsBitField.Flags.MoveMembers
              ]
            },
            // bot: กันโดน deny จาก category และให้ย้ายคนได้ชัวร์
            {
              id: guild.members.me.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.ManageChannels,
                PermissionsBitField.Flags.MoveMembers
              ]
            }
          ],

          reason: "Auto create voice channel (per-JTC category)"
        });

        // คอมเมนต์: บันทึก owner
        await setRoomOwner(guild.id, createdChannel.id, member.id);

        // คอมเมนต์: log สร้างห้อง
        await insertLogDetailed(guild.id, "CREATE_ROOM", createdChannel.id, member.id, member.id, null, {
          created_channel_name: createdChannel.name,
          joined_jtc_channel_id: newState.channelId,
          parent_category_id: parentCategoryId
        });

        await sendLogEmbed(
          guild,
          cfg,
          buildLogEmbed({
            title: "🎧 สร้างห้องเสียง",
            action: "CREATE_ROOM",
            channelId: createdChannel.id,
            ownerId: member.id,
            actorId: member.id,
            targetUserId: null,
            metadata: {
              created_channel_name: createdChannel.name,
              joined_jtc_channel_id: newState.channelId,
              parent_category_id: parentCategoryId
            }
          })
        );

        // คอมเมนต์: ย้ายเจ้าของเข้าไป (ถ้าพังให้ log)
        try {
          await member.voice.setChannel(createdChannel);

          await insertLogDetailed(
            guild.id,
            "MOVE_OWNER_SUCCESS",
            createdChannel.id,
            member.id,
            guild.members.me.id,
            member.id,
            { from: newState.channelId, to: createdChannel.id }
          );
        } catch (e) {
          console.error("MOVE OWNER FAILED:", e);

          await insertLogDetailed(
            guild.id,
            "MOVE_OWNER_FAILED",
            createdChannel.id,
            member.id,
            guild.members.me.id,
            member.id,
            { from: newState.channelId, to: createdChannel.id, error: e?.message || String(e) }
          );

          await sendLogEmbed(
            guild,
            cfg,
            buildLogEmbed({
              title: "⚠️ ย้ายเจ้าของไม่สำเร็จ",
              action: "MOVE_OWNER_FAILED",
              channelId: createdChannel.id,
              ownerId: member.id,
              actorId: guild.members.me.id,
              targetUserId: member.id,
              metadata: { error: e?.message || String(e) }
            })
          );
        }

        return; // ✅ จบ flow JTC
      }
    }

    // ---------------------------------
    // 7.2 MEMBER JOIN/LEAVE/MOVE (เฉพาะ owned rooms)
    // ---------------------------------
    const memberId = newState.member?.id || oldState.member?.id;

    // Join
    if (!oldState.channelId && newState.channelId && memberId) {
      const room = await isOwnedRoom(newState.channelId);
      if (room) {
        await insertLogDetailed(guild.id, "MEMBER_JOIN", newState.channelId, room.owner_id, memberId, memberId, { event: "join" });

        await sendLogEmbed(
          guild,
          cfg,
          buildLogEmbed({
            title: "➡️ สมาชิกเข้าห้อง",
            action: "MEMBER_JOIN",
            channelId: newState.channelId,
            ownerId: room.owner_id,
            actorId: memberId,
            targetUserId: memberId,
            metadata: { event: "join" }
          })
        );
      }
    }

    // Leave
    if (oldState.channelId && !newState.channelId && memberId) {
      const room = await isOwnedRoom(oldState.channelId);
      if (room) {
        await insertLogDetailed(guild.id, "MEMBER_LEAVE", oldState.channelId, room.owner_id, memberId, memberId, { event: "leave" });

        await sendLogEmbed(
          guild,
          cfg,
          buildLogEmbed({
            title: "⬅️ สมาชิกออกห้อง",
            action: "MEMBER_LEAVE",
            channelId: oldState.channelId,
            ownerId: room.owner_id,
            actorId: memberId,
            targetUserId: memberId,
            metadata: { event: "leave" }
          })
        );
      }
    }

    // Move
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId && memberId) {
      const fromRoom = await isOwnedRoom(oldState.channelId);
      const toRoom = await isOwnedRoom(newState.channelId);

      if (fromRoom || toRoom) {
        const ownerId = toRoom?.owner_id || fromRoom?.owner_id || null;

        await insertLogDetailed(guild.id, "MEMBER_MOVE", newState.channelId, ownerId, memberId, memberId, {
          from: oldState.channelId,
          to: newState.channelId
        });

        await sendLogEmbed(
          guild,
          cfg,
          buildLogEmbed({
            title: "🔀 สมาชิกย้ายห้อง",
            action: "MEMBER_MOVE",
            channelId: newState.channelId,
            ownerId,
            actorId: memberId,
            targetUserId: memberId,
            metadata: { from: oldState.channelId, to: newState.channelId }
          })
        );
      }
    }

    // ---------------------------------
    // 7.3 AUTO DELETE ห้องที่ว่าง
    // ---------------------------------
    if (oldState.channelId) {
      const leftChannel = oldState.guild.channels.cache.get(oldState.channelId);
      if (!leftChannel || leftChannel.type !== ChannelType.GuildVoice) return;

      const ownerRow = await getRoomOwner(leftChannel.id);
      if (!ownerRow) return;

      if (leftChannel.members.size === 0) {
        await insertLogDetailed(guild.id, "DELETE_ROOM", leftChannel.id, ownerRow.owner_id, null, null, {
          reason: "empty_room",
          deleted_channel_name: leftChannel.name || "unknown"
        });

        await sendLogEmbed(
          guild,
          cfg,
          buildLogEmbed({
            title: "🗑️ ลบห้องเสียง (ห้องว่าง)",
            action: "DELETE_ROOM",
            channelId: leftChannel.id,
            ownerId: ownerRow.owner_id,
            actorId: null,
            targetUserId: null,
            metadata: { reason: "empty_room", deleted_channel_name: leftChannel.name || "unknown" }
          })
        );

        await leftChannel.delete("Auto delete empty owned voice channel");
        await deleteRoom(leftChannel.id);
      }
    }
  } catch (err) {
    console.error("voiceStateUpdate error:", err);
  }
});

// =========================
// 8) Interactions (Slash / Buttons / Modals)
// =========================
client.on("interactionCreate", async (interaction) => {
  try {
    // -------------------------
    // 8.1 Slash Commands
    // -------------------------
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      return cmd.execute(interaction);
    }

    // -------------------------
    // 8.2 Buttons
    // -------------------------
    if (interaction.isButton()) {
      const cfg = await getConfig(interaction.guild.id);

      // ✅ สำคัญมาก:
      // - lock/unlock: deferReply ได้
      // - limit/rename: ต้อง showModal เป็น response แรก ห้าม defer

      // 8.2.1 LOCK
      if (interaction.customId === "vc_lock") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const res = await getUserControllableVoiceChannel(interaction);
        if (!res.ok) return interaction.editReply(res.msg);

        const before = res.channel.permissionOverwrites.cache
          .get(interaction.guild.roles.everyone.id)
          ?.deny?.has(PermissionsBitField.Flags.Connect)
          ? "locked"
          : "unlocked";

        await res.channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { Connect: false });
        const after = "locked";

        await insertLogDetailed(interaction.guild.id, "LOCK", res.channel.id, res.ownerId, interaction.user.id, null, { before, after });

        await sendLogEmbed(
          interaction.guild,
          cfg,
          buildLogEmbed({
            title: "🔒 ล็อคห้องเสียง",
            action: "LOCK",
            channelId: res.channel.id,
            ownerId: res.ownerId,
            actorId: interaction.user.id,
            targetUserId: null,
            metadata: { before, after }
          })
        );

        return interaction.editReply("🔒 ล็อคห้องแล้ว");
      }

      // 8.2.2 UNLOCK
      if (interaction.customId === "vc_unlock") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const res = await getUserControllableVoiceChannel(interaction);
        if (!res.ok) return interaction.editReply(res.msg);

        const before = res.channel.permissionOverwrites.cache
          .get(interaction.guild.roles.everyone.id)
          ?.deny?.has(PermissionsBitField.Flags.Connect)
          ? "locked"
          : "unlocked";

        await res.channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { Connect: null });
        const after = "unlocked";

        await insertLogDetailed(interaction.guild.id, "UNLOCK", res.channel.id, res.ownerId, interaction.user.id, null, { before, after });

        await sendLogEmbed(
          interaction.guild,
          cfg,
          buildLogEmbed({
            title: "🔓 ปลดล็อคห้องเสียง",
            action: "UNLOCK",
            channelId: res.channel.id,
            ownerId: res.ownerId,
            actorId: interaction.user.id,
            targetUserId: null,
            metadata: { before, after }
          })
        );

        return interaction.editReply("🔓 ปลดล็อคห้องแล้ว");
      }

      // 8.2.3 LIMIT (Modal) ✅ ห้าม deferReply ก่อน
      if (interaction.customId === "vc_limit") {
        const res = await getUserControllableVoiceChannel(interaction);
        if (!res.ok) {
          return interaction.reply({ content: res.msg, flags: MessageFlags.Ephemeral });
        }

        const modal = new ModalBuilder().setCustomId("modal_vc_limit").setTitle("ตั้งค่าจำนวนคนสูงสุด");

        const input = new TextInputBuilder()
          .setCustomId("limit_value")
          .setLabel("ใส่เลข 0-99 (0 = ไม่จำกัด)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(2);

        modal.addComponents(new ActionRowBuilder().addComponents(input));

        // ✅ showModal ต้องเป็น response แรก
        return interaction.showModal(modal);
      }

      // 8.2.4 RENAME (Modal) ✅ ห้าม deferReply ก่อน
      if (interaction.customId === "vc_rename") {
        const res = await getUserControllableVoiceChannel(interaction);
        if (!res.ok) {
          return interaction.reply({ content: res.msg, flags: MessageFlags.Ephemeral });
        }

        const modal = new ModalBuilder().setCustomId("modal_vc_rename").setTitle("เปลี่ยนชื่อห้องเสียง");

        const input = new TextInputBuilder()
          .setCustomId("rename_value")
          .setLabel("ชื่อใหม่ (1-100 ตัวอักษร)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100);

        modal.addComponents(new ActionRowBuilder().addComponents(input));

        // ✅ showModal ต้องเป็น response แรก
        return interaction.showModal(modal);
      }

      // 8.2.5 Unknown button
      return interaction.reply({ content: "❌ ปุ่มนี้ยังไม่รองรับ", flags: MessageFlags.Ephemeral });
    }

    // -------------------------
    // 8.3 Modals
    // -------------------------
    if (interaction.isModalSubmit()) {
      const cfg = await getConfig(interaction.guild.id);

      // 8.3.1 SET_LIMIT
      if (interaction.customId === "modal_vc_limit") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const res = await getUserControllableVoiceChannel(interaction);
        if (!res.ok) return interaction.editReply(res.msg);

        const raw = interaction.fields.getTextInputValue("limit_value");
        const limit = Number(raw);

        if (Number.isNaN(limit) || limit < 0 || limit > 99) {
          return interaction.editReply("❌ ใส่ได้เฉพาะเลข 0 ถึง 99");
        }

        const before = res.channel.userLimit ?? 0;
        await res.channel.edit({ userLimit: limit });
        const after = limit;

        await insertLogDetailed(interaction.guild.id, "SET_LIMIT", res.channel.id, res.ownerId, interaction.user.id, null, { before, after });

        await sendLogEmbed(
          interaction.guild,
          cfg,
          buildLogEmbed({
            title: "👥 ตั้งค่าจำนวนคนในห้อง",
            action: "SET_LIMIT",
            channelId: res.channel.id,
            ownerId: res.ownerId,
            actorId: interaction.user.id,
            targetUserId: null,
            metadata: { before, after }
          })
        );

        return interaction.editReply(`👥 ตั้งค่าจำนวนคนสูงสุดเป็น ${limit} แล้ว`);
      }

      // 8.3.2 RENAME
      if (interaction.customId === "modal_vc_rename") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const res = await getUserControllableVoiceChannel(interaction);
        if (!res.ok) return interaction.editReply(res.msg);

        const name = interaction.fields.getTextInputValue("rename_value").trim();
        if (!name) return interaction.editReply("❌ ชื่อห้องห้ามว่าง");

        const before = res.channel.name;
        await res.channel.setName(name);
        const after = name;

        await insertLogDetailed(interaction.guild.id, "RENAME", res.channel.id, res.ownerId, interaction.user.id, null, { before, after });

        await sendLogEmbed(
          interaction.guild,
          cfg,
          buildLogEmbed({
            title: "✏️ เปลี่ยนชื่อห้องเสียง",
            action: "RENAME",
            channelId: res.channel.id,
            ownerId: res.ownerId,
            actorId: interaction.user.id,
            targetUserId: null,
            metadata: { before, after }
          })
        );

        return interaction.editReply(`✏️ เปลี่ยนชื่อห้องเป็น "${name}" แล้ว`);
      }
    }
  } catch (err) {
    console.error("interactionCreate error:", err);

    // คอมเมนต์: กันกรณีตอบซ้ำ
    if (interaction?.isRepliable?.()) {
      try {
        if (interaction.deferred || interaction.replied) {
          return interaction.followUp({ content: "❌ เกิดข้อผิดพลาดภายในบอท", flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: "❌ เกิดข้อผิดพลาดภายในบอท", flags: MessageFlags.Ephemeral });
      } catch {}
    }
  }
});

// =========================
// 9) กันบอทล้มจาก error ที่ไม่ได้จับ
// =========================
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

// =========================
// 10) ปิด DB สวย ๆ
// =========================
process.on("SIGINT", async () => {
  try {
    console.log("Shutting down...");
    await pool.end();
  } finally {
    process.exit(0);
  }
});

client.login(process.env.BOT_TOKEN);
