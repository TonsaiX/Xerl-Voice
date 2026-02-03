// commands/jtc_remove.js
// คอมเมนต์: ลบห้อง Join-to-Create ออกจากระบบ
// ใช้ได้เฉพาะ SETUP_OWNER_ID

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require("discord.js");
const { removeJtcChannel, listJtcChannels } = require("../db");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("jtc_remove")
    .setDescription("ลบห้อง Join-to-Create ออกจากระบบ")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt
        .setName("voice_channel")
        .setDescription("เลือกห้องเสียง Join-to-Create ที่ต้องการลบ")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    ),

  async execute(interaction) {
    try {
      const allowedId = process.env.SETUP_OWNER_ID;
      if (!allowedId || interaction.user.id !== allowedId) {
        return interaction.reply({ content: "❌ คำสั่งนี้ให้เฉพาะแอดมินที่กำหนดไว้ใช้เท่านั้น", flags: MessageFlags.Ephemeral });
      }

      const vc = interaction.options.getChannel("voice_channel");
      await removeJtcChannel(interaction.guild.id, vc.id);

      const all = await listJtcChannels(interaction.guild.id);
      const list = all
        .map((x) => `• <#${x.channel_id}> → หมวด: ${x.category_id ? `<#${x.category_id}>` : "ไม่ระบุ"}`)
        .join("\n") || "-";

      return interaction.reply({
        content: `✅ ลบ JTC แล้ว: <#${vc.id}>\n\n**รายการที่เหลือ:**\n${list}`,
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      console.error("jtc_remove error:", err);
      return interaction.reply({ content: "❌ ลบ Join-to-Create ไม่สำเร็จ", flags: MessageFlags.Ephemeral });
    }
  }
};
