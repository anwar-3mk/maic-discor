const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');
const express = require('express');
const app = express();

// إعدادات البوت (سيتم قراءتها من ريندر)
const CONFIG = {
    TOKEN: process.env.BOT_TOKEN,
    GUILD_ID: process.env.GUILD_ID,
    LOBBY_CHANNEL_ID: process.env.LOBBY_CHANNEL_ID,
    CATEGORY_ID: process.env.CATEGORY_ID,
    PROXIMITY_DISTANCE: parseInt(process.env.PROXIMITY_DISTANCE) || 40,
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

app.use(express.json());

// البيانات المخزنة
let playerPositions = {}; // { userId: { pos, discordId } }
let discordToRoblox = {}; // { discordId: userId }
let activeProximityChannels = {}; // { channelId: [userIds] }

// --- [ منطق الحسابات والمسافات ] ---

function calculateDistance(pos1, pos2) {
    return Math.sqrt(
        Math.pow(pos1.x - pos2.x, 2) +
        Math.pow(pos1.y - pos2.y, 2) +
        Math.pow(pos1.z - pos2.z, 2)
    );
}

// تحديث المواقع من روبلوكس
app.post('/update', async (req, res) => {
    const { players } = req.body;
    if (!players) return res.status(400).send("No data");

    players.forEach(p => {
        if (playerPositions[p.userId]) {
            playerPositions[p.userId].pos = p.pos;
        }
    });

    handleProximityMoves();
    res.send("OK");
});

// دالة تحريك اللاعبين بناءً على التقارب
async function handleProximityMoves() {
    const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
    if (!guild) return;

    let playersList = Object.values(playerPositions).filter(p => p.discordId);
    let handled = new Set();

    for (let i = 0; i < playersList.length; i++) {
        let p1 = playersList[i];
        if (handled.has(p1.userId)) continue;

        let cluster = [p1];
        for (let j = i + 1; j < playersList.length; j++) {
            let p2 = playersList[j];
            if (calculateDistance(p1.pos, p2.pos) < CONFIG.PROXIMITY_DISTANCE) {
                cluster.push(p2);
                handled.add(p2.userId);
            }
        }

        if (cluster.length > 1) {
            // يوجد تجمع للاعبين
            await manageVoiceGroup(guild, cluster);
        } else {
            // اللاعب وحيد، يرجع للروم العام
            await moveToLobby(guild, p1);
        }
        handled.add(p1.userId);
    }
}

async function manageVoiceGroup(guild, cluster) {
    const memberIds = cluster.map(p => p.discordId);
    const clusterKey = memberIds.sort().join('-');

    // هل يوجد روم لهذا التجمع حالياً؟
    let existingChannelId = Object.keys(activeProximityChannels).find(id => activeProximityChannels[id] === clusterKey);

    if (!existingChannelId) {
        // إنشاء روم جديد
        const channel = await guild.channels.create({
            name: `🔊 | مجموعة ${cluster.length} لاعبين`,
            type: ChannelType.GuildVoice,
            parent: CONFIG.CATEGORY_ID,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionsBitField.Flags.Connect] }, // منع الجميع
                ...memberIds.map(id => ({ id: id, allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] })) // السماح للمجموعة فقط
            ]
        });
        existingChannelId = channel.id;
        activeProximityChannels[existingChannelId] = clusterKey;
    }

    // تحريك اللاعبين للروم
    for (let p of cluster) {
        const member = await guild.members.fetch(p.discordId).catch(() => null);
        if (member && member.voice.channelId !== existingChannelId) {
            member.voice.setChannel(existingChannelId).catch(e => console.log("Move Error:", e.message));
        }
    }
}

async function moveToLobby(guild, player) {
    const member = await guild.members.fetch(player.discordId).catch(() => null);
    if (member && member.voice.channelId && member.voice.channelId !== CONFIG.LOBBY_CHANNEL_ID) {
        // إذا كان في روم بروكسيميتي، يرجع للوبي
        if (Object.keys(activeProximityChannels).includes(member.voice.channelId)) {
            member.voice.setChannel(CONFIG.LOBBY_CHANNEL_ID).catch(() => {});
        }
    }
}

// تنظيف الرومات الفارغة
setInterval(async () => {
    const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
    if (!guild) return;

    for (let channelId in activeProximityChannels) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.members.size === 0) {
            if (channel) await channel.delete().catch(() => {});
            delete activeProximityChannels[channelId];
        }
    }
}, 5000);

// --- [ أوامر الديسكورد ] ---

let tempLinkCodes = {}; // { code: userId }

// استقبال كود الربط من روبلوكس
app.post('/generate_link', (req, res) => {
    const { userId, code } = req.body;
    tempLinkCodes[code] = userId;
    // تنظيف الكود بعد 5 دقائق
    setTimeout(() => { delete tempLinkCodes[code]; }, 5 * 60 * 1000);
    res.send("OK");
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!link')) {
        const code = message.content.split(' ')[1];
        if (!code) return message.reply("الرجاء إدخال كود الربط الظاهر في روبلوكس: `!link 123456` ");
        
        const userId = tempLinkCodes[code];
        if (userId) {
            playerPositions[userId] = { 
                discordId: message.author.id, 
                userId: userId, 
                pos: { x: 0, y: 0, z: 0 } 
            };
            discordToRoblox[message.author.id] = userId;
            delete tempLinkCodes[code];
            message.reply(`✅ تم ربط حسابك بنجاح! لاعب روبلوكس: ${userId}`);
        } else {
            message.reply("❌ الكود خاطئ أو انتهت صلاحيته.");
        }
    }
});

const PORT = process.env.PORT || 3000; // ريندر يحدد البورت تلقائياً
client.login(CONFIG.TOKEN);
app.listen(PORT, () => console.log(`API Server running for Roblox on port ${PORT}`));
