// register-commands.js
// คอมเมนต์: ลงทะเบียน slash commands แบบ global
// รัน: npm run register

require("dotenv").config();
const { REST, Routes } = require("discord.js");
const fs = require("fs");
const path = require("path");

const commands = [];
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));

// ✅ เช็คชื่อซ้ำก่อนส่งขึ้น Discord
const seen = new Map(); // name -> file

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  const json = command.data.toJSON();

  if (seen.has(json.name)) {
    console.error(
      `❌ Duplicate command name: "${json.name}"\n` +
      `- First: ${seen.get(json.name)}\n` +
      `- Second: ${file}\n` +
      `👉 แก้โดยเปลี่ยนชื่อ .setName(...) หรือเอาไฟล์ซ้ำออก`
    );
    process.exit(1);
  }

  seen.set(json.name, file);
  commands.push(json);
}

const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    if (!process.env.BOT_TOKEN || !process.env.CLIENT_ID) {
      throw new Error("Missing BOT_TOKEN or CLIENT_ID in .env");
    }

    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("✅ Done registering commands.");
  } catch (error) {
    console.error("register commands error:", error);
  }
})();
