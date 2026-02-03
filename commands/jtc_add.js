// commands/jtc_add.js
// คอมเมนต์: เพิ่มห้อง Join-to-Create และกำหนด Category ของห้องนั้น
// ใช้ได้เฉพาะ SETUP_OWNER_ID

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require("discord.js");
const { addJtcChannel, listJtcChannels, getConfig } = require("../db");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("jtc_add")
    .setDescription("เพิ่มห้อง Join-to-Create (กำหนด Category ต่อห้องได้)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt
        .setName("voice_channel")
        .setDescription("เลือกห้องเสียงที่จะใช้เป็น Join-to-Create")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    )
    .addChannelOption((opt) =>
      opt
        .setName("category")
        .setDescription("Category ที่ให้ JTC ห้องนี้สร้างห้องใหม่ลงไป")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false)
    ),

  async execute(interaction) {
    try {
      const allowedId = process.env.SETUP_OWNER_ID;
      if (!allowedId || interaction.user.id !== allowedId) {
        return interaction.reply({ content: "❌ คำสั่งนี้ให้เฉพาะแอดมินที่กำหนดไว้ใช้เท่านั้น", flags: MessageFlags.Ephemeral });
      }

      const vc = interaction.options.getChannel("voice_channel");
      const categoryOpt = interaction.options.getChannel("category");

      // คอมเมนต์: ถ้าไม่ส่ง category มา -> ใช้ default category จาก config
      const cfg = await getConfig(interaction.guild.id);
      const categoryId = categoryOpt?.id || cfg?.category_id;

      if (!categoryId) {
        return interaction.reply({
          content: "❌ ยังไม่มี default category (ให้ใช้ /setup ก่อน หรือระบุ category ใน /jtc_add)",
          flags: MessageFlags.Ephemeral
        });
      }

      await addJtcChannel(interaction.guild.id, vc.id, categoryId);

      const all = await listJtcChannels(interaction.guild.id);
      const list = all
        .map((x) => `• <#${x.channel_id}> → หมวด: ${x.category_id ? `<#${x.category_id}>` : "ไม่ระบุ"}`)
        .join("\n") || "-";

      return interaction.reply({
        content: `✅ เพิ่ม JTC แล้ว: <#${vc.id}> → หมวด: <#${categoryId}>\n\n**รายการทั้งหมด:**\n${list}`,
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      console.error("jtc_add error:", err);
      return interaction.reply({ content: "❌ เพิ่ม Join-to-Create ไม่สำเร็จ", flags: MessageFlags.Ephemeral });
    }
  }
};
