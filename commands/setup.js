// commands/setup.js
// คอมเมนต์: /setup ใช้ได้เฉพาะ SETUP_OWNER_ID
// - ตั้ง control/log/default category
// - ระบุ (หรือให้บอทสร้าง) JTC ห้องแรก และผูกกับ category ที่เลือก
// - ส่งแผงควบคุม (Embed+Buttons) ไปห้อง control
// - ใช้ flags: MessageFlags.Ephemeral (แก้ warning)

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} = require("discord.js");

const { upsertConfig, addJtcChannel } = require("../db");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("ตั้งค่า Voice Create + แผงควบคุม + ห้อง Log + Join-to-Create (แยก Category ต่อห้องได้)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt
        .setName("control_text_channel")
        .setDescription("ห้องข้อความแผงควบคุม (Embed+Buttons)")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addChannelOption((opt) =>
      opt
        .setName("log_text_channel")
        .setDescription("ห้องข้อความ Log (ส่งเป็น Embed เท่านั้น)")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addChannelOption((opt) =>
      opt
        .setName("default_category")
        .setDescription("Category เริ่มต้น (ใช้เป็น fallback ถ้า JTC ไม่มี category)")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true)
    )
    .addChannelOption((opt) =>
      opt
        .setName("create_voice_channel")
        .setDescription("ห้องเสียง Join-to-Create ห้องแรก (ไม่เลือก = บอทสร้างให้)")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(false)
    ),

  async execute(interaction) {
    try {
      const allowedId = process.env.SETUP_OWNER_ID;

      if (!allowedId) {
        return interaction.reply({
          content: "❌ ยังไม่ได้ตั้งค่า SETUP_OWNER_ID ใน .env",
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.user.id !== allowedId) {
        return interaction.reply({
          content: "❌ คำสั่งนี้ให้เฉพาะแอดมินที่กำหนดไว้ใช้เท่านั้น",
          flags: MessageFlags.Ephemeral
        });
      }

      const controlText = interaction.options.getChannel("control_text_channel");
      const logText = interaction.options.getChannel("log_text_channel");
      const defaultCategory = interaction.options.getChannel("default_category");
      let createVoice = interaction.options.getChannel("create_voice_channel");

      // คอมเมนต์: เช็ค permission ห้อง control ก่อนส่ง (กัน Missing Access 50001)
      const me = interaction.guild.members.me;
      const need = ["ViewChannel", "SendMessages", "EmbedLinks"];
      const perms = controlText.permissionsFor(me);
      if (!perms || !perms.has(need)) {
        return interaction.reply({
          content:
            "❌ บอทไม่มีสิทธิ์ส่งข้อความในห้อง Control ที่เลือก\n" +
            `ห้อง: <#${controlText.id}>\n` +
            "ต้อง Allow ให้บอท: View Channel, Send Messages, Embed Links",
          flags: MessageFlags.Ephemeral
        });
      }

      // คอมเมนต์: ถ้าไม่ส่ง createVoice มา -> สร้างใหม่ 1 ห้อง JTC
      if (!createVoice) {
        createVoice = await interaction.guild.channels.create({
          name: "➕ เข้าเพื่อสร้างห้อง",
          type: ChannelType.GuildVoice,
          parent: defaultCategory.id,
          reason: "Setup Join-to-Create"
        });
      }

      // คอมเมนต์: บันทึก config หลัก (default category)
      await upsertConfig(interaction.guild.id, controlText.id, defaultCategory.id, logText.id);

      // ✅ ผูก JTC ห้องแรกกับ category ที่เลือก (defaultCategory)
      await addJtcChannel(interaction.guild.id, createVoice.id, defaultCategory.id);

      // คอมเมนต์: ส่งแผงควบคุม
      const embed = new EmbedBuilder()
        .setTitle("🎛️ แผงควบคุมห้องเสียง")
        .setDescription(
          [
            "ปุ่มด้านล่างใช้คุม **ห้องที่ระบบสร้าง**",
            "✅ เจ้าของห้องกดได้",
            "✅ แอดมินกดคุมได้ด้วย",
            "",
            "🔒 ล็อคห้อง | 🔓 ปลดล็อค | 👥 จำกัดจำนวนคน | ✏️ เปลี่ยนชื่อ",
            "",
            "📌 วิธีใช้: เข้าไปอยู่ในห้องเสียงนั้นก่อน แล้วค่อยกดปุ่ม"
          ].join("\n")
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("vc_lock").setLabel("ล็อคห้อง").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("vc_unlock").setLabel("ปลดล็อค").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("vc_limit").setLabel("จำกัดจำนวนคน").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("vc_rename").setLabel("เปลี่ยนชื่อ").setStyle(ButtonStyle.Secondary)
      );

      await controlText.send({ embeds: [embed], components: [row] });

      return interaction.reply({
        content:
          `✅ ตั้งค่าเสร็จแล้ว!\n` +
          `- JTC ห้องแรก: <#${createVoice.id}> → หมวด: <#${defaultCategory.id}>\n` +
          `- แผงควบคุม: <#${controlText.id}>\n` +
          `- ห้อง Log: <#${logText.id}>\n\n` +
          `เพิ่ม JTC ห้องอื่นพร้อมหมวดแยกได้ด้วย /jtc_add`,
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      console.error("setup command error:", err);
      return interaction.reply({ content: "❌ เกิดข้อผิดพลาดตอน setup", flags: MessageFlags.Ephemeral });
    }
  }
};
