// commands/jtc_list.js
// คอมเมนต์: ดูรายการ Join-to-Create ทั้งหมด (พร้อม Category ต่อห้อง)
// ใช้ได้เฉพาะ SETUP_OWNER_ID

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");
const { listJtcChannels } = require("../db");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("jtc_list")
    .setDescription("ดูรายการ Join-to-Create ทั้งหมด")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    try {
      const allowedId = process.env.SETUP_OWNER_ID;
      if (!allowedId || interaction.user.id !== allowedId) {
        return interaction.reply({ content: "❌ คำสั่งนี้ให้เฉพาะแอดมินที่กำหนดไว้ใช้เท่านั้น", flags: MessageFlags.Ephemeral });
      }

      const all = await listJtcChannels(interaction.guild.id);
      const list =
        all.map((x) => `• <#${x.channel_id}> → หมวด: ${x.category_id ? `<#${x.category_id}>` : "ไม่ระบุ"}`).join("\n") || "-";

      return interaction.reply({ content: `📌 **Join-to-Create ทั้งหมด:**\n${list}`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error("jtc_list error:", err);
      return interaction.reply({ content: "❌ โหลดรายการ Join-to-Create ไม่สำเร็จ", flags: MessageFlags.Ephemeral });
    }
  }
};
