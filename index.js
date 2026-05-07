const { Client, GatewayIntentBits, ChannelType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const app = express();

const CONFIG = {
    TOKEN: process.env.BOT_TOKEN,
    GUILD_ID: process.env.GUILD_ID,
    LOBBY_CHANNEL_ID: process.env.LOBBY_CHANNEL_ID,
    CATEGORY_ID: process.env.CATEGORY_ID,
    PROXIMITY_DISTANCE: parseInt(process.env.PROXIMITY_DISTANCE) || 40,
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

app.use(express.json());

let playerPositions = {}; 
let pendingLinks = {}; // { robloxUserId: discordId }

// --- [ مسارات الـ API ] ---

// طلب ربط عبر اسم المستخدم
app.post('/request_link', async (req, res) => {
    const { userId, discordTag } = req.body;
    const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
    if (!guild) return res.status(500).send({ success: false, message: "السيرفر غير موجود" });

    try {
        // البحث عن العضو في السيرفر بدقة (حتى لو لم يكن مسجلاً في الكاش)
        const members = await guild.members.fetch({ query: discordTag, limit: 1 });
        const member = members.first();
        
        if (member) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`link_${userId}`)
                    .setLabel('تأكيد ربط حساب روبلوكس ✅')
                    .setStyle(ButtonStyle.Success)
            );

            await member.send({
                content: `👋 أهلاً بك! لاعب برقم **${userId}** يحاول ربط حسابه بك في روبلوكس. هل أنت هذا الشخص؟`,
                components: [row]
            }).catch(() => {
                throw new Error("الخاص عندك مغلق");
            });
            
            res.send({ success: true, message: "تم إرسال رسالة في الخاص." });
        } else {
            res.send({ success: false, message: "لم يتم العثور على الاسم بالسيرفر" });
        }
    } catch (err) {
        res.send({ success: false, message: err.message || "خطأ غير متوقع" });
    }
});

// التعامل مع ضغط أزرار التأكيد
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith('link_')) {
        const userId = interaction.customId.split('_')[1];
        
        playerPositions[userId] = {
            discordId: interaction.user.id,
            userId: userId,
            pos: { x: 0, y: 0, z: 0 }
        };

        await interaction.update({ content: '✅ تم ربط حسابك بنجاح! يمكنك العودة للعبة الآن.', components: [] });
    }
});

app.post('/toggle_mic', async (req, res) => {
    const { userId, muted } = req.body;
    const player = playerPositions[userId];
    if (player && player.discordId) {
        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        const member = await guild.members.fetch(player.discordId).catch(() => null);
        if (member && member.voice.channelId) {
            member.voice.setMute(muted).catch(() => {});
            return res.send({ success: true });
        }
    }
    res.status(400).send({ success: false });
});

app.post('/update', async (req, res) => {
    const { players } = req.body;
    players.forEach(p => {
        if (playerPositions[p.userId]) playerPositions[p.userId].pos = p.pos;
    });
    handleProximityMoves();
    res.send("OK");
});

// --- [ منطق التحريك (كما هو سابقاً) ] ---
async function handleProximityMoves() {
    const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
    if (!guild) return;

    let playersList = Object.values(playerPositions).filter(p => p.discordId);
    let handled = new Set();
    let activeProximityChannels = {}; 

    // (نفس الكود السابق للتحريك والميوت التلقائي)
    // ملاحظة: قمت بتبسيطه هنا للاختصار ولكن سأحافظ على وظيفته
    for (let i = 0; i < playersList.length; i++) {
        let p1 = playersList[i];
        if (handled.has(p1.userId)) continue;
        let cluster = [p1];
        for (let j = i + 1; j < playersList.length; j++) {
            let p2 = playersList[j];
            if (dist(p1.pos, p2.pos) < CONFIG.PROXIMITY_DISTANCE) cluster.push(p2);
        }
        if (cluster.length > 1) {
            await manageVoiceGroup(guild, cluster);
            cluster.forEach(p => handled.add(p.userId));
        } else {
            await moveToLobby(guild, p1);
        }
    }
}

function dist(p1, p2) { return Math.sqrt(Math.pow(p1.x-p2.x,2)+Math.pow(p1.y-p2.y,2)+Math.pow(p1.z-p2.z,2)); }

async function manageVoiceGroup(guild, cluster) {
    const memberIds = cluster.map(p => p.discordId);
    const channelName = `🔊 | مجموعة ${cluster.length} لاعبين`;
    let channel = guild.channels.cache.find(c => c.name === channelName && c.parentId === CONFIG.CATEGORY_ID);

    if (!channel) {
        channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildVoice,
            parent: CONFIG.CATEGORY_ID,
            permissionOverwrites: [{ id: guild.id, deny: [PermissionsBitField.Flags.Connect] }]
        });
    }

    for (let p of cluster) {
        const member = await guild.members.fetch(p.discordId).catch(() => null);
        if (member && member.voice.channelId) {
            if (member.voice.serverMute) member.voice.setMute(false).catch(() => {});
            if (member.voice.channelId !== channel.id) member.voice.setChannel(channel.id).catch(() => {});
        }
    }
}

async function moveToLobby(guild, player) {
    const member = await guild.members.fetch(player.discordId).catch(() => null);
    if (member && member.voice.channelId && member.voice.channelId !== CONFIG.LOBBY_CHANNEL_ID) {
        member.voice.setMute(true).catch(() => {});
        member.voice.setChannel(CONFIG.LOBBY_CHANNEL_ID).catch(() => {});
    }
}

const PORT = process.env.PORT || 3000;
client.login(CONFIG.TOKEN);
app.listen(PORT, () => console.log(`Discord API running on ${PORT}`));
