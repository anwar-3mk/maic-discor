const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');
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
        GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages
    ]
});

app.use(express.json());

let playerPositions = {}; 
let voiceCodes = {}; // { code: discordId }
let activeProximityChannels = {};

// --- [ منطق الربط الجديد ] ---

// عندما يدخل شخص للروم الصوتي العام
client.on('voiceStateUpdate', async (oldState, newState) => {
    // التحقق من دخول الشخص للروم العام
    if (newState.channelId === CONFIG.LOBBY_CHANNEL_ID && oldState.channelId !== CONFIG.LOBBY_CHANNEL_ID) {
        const member = newState.member;
        const code = Math.floor(100 + Math.random() * 900).toString(); // رمز من 3 أرقام
        
        voiceCodes[code] = member.id;
        
        try {
            await member.send(`👋 أهلاً بك في نظام المايك! رمز الربط الخاص بك هو: **${code}**\nاكتبه الآن داخل روبلوكس لتفعيل المايك المحيطي.`);
            console.log(`Sent code ${code} to ${member.user.tag}`);
        } catch (e) {
            console.log(`Failed to send DM to ${member.user.tag}`);
        }
    }
});

// التحقق من الرمز من روبلوكس
app.post('/verify_code', (req, res) => {
    const { userId, code } = req.body;
    const discordId = voiceCodes[code];

    if (discordId) {
        playerPositions[userId] = {
            discordId: discordId,
            userId: userId,
            pos: { x: 0, y: 0, z: 0 }
        };
        delete voiceCodes[code]; // مسح الرمز بعد الاستخدام
        res.send({ success: true });
    } else {
        res.send({ success: false, message: "الرمز خاطئ أو غير موجود" });
    }
});

// --- [ منطق المزامنة والتحريك ] ---

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

app.post('/update', (req, res) => {
    const { players } = req.body;
    players.forEach(p => {
        if (playerPositions[p.userId]) playerPositions[p.userId].pos = p.pos;
    });
    handleProximityMoves();
    res.send("OK");
});

async function handleProximityMoves() {
    const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
    if (!guild) return;

    // فقط اللاعبين الذين أكملوا عملية الربط
    let playersList = Object.values(playerPositions).filter(p => p.discordId);
    let handled = new Set();

    for (let i = 0; i < playersList.length; i++) {
        let p1 = playersList[i];
        if (handled.has(p1.userId)) continue;

        let cluster = [p1];
        for (let j = i + 1; j < playersList.length; j++) {
            let p2 = playersList[j];
            const d = Math.sqrt(Math.pow(p1.pos.x-p2.pos.x,2)+Math.pow(p1.pos.y-p2.pos.y,2)+Math.pow(p1.pos.z-p2.pos.z,2));
            if (d < CONFIG.PROXIMITY_DISTANCE) cluster.push(p2);
        }

        if (cluster.length > 1) {
            await manageVoiceGroup(guild, cluster);
            cluster.forEach(p => handled.add(p.userId));
        } else {
            await moveToLobby(guild, p1);
            handled.add(p1.userId);
        }
    }
}

async function manageVoiceGroup(guild, cluster) {
    const memberIds = cluster.map(p => p.discordId).sort().join('-');
    let channelId = Object.keys(activeProximityChannels).find(id => activeProximityChannels[id] === memberIds);

    if (!channelId) {
        const channel = await guild.channels.create({
            name: `🔊 | مجموعة ${cluster.length} لاعبين`,
            type: ChannelType.GuildVoice,
            parent: CONFIG.CATEGORY_ID,
            permissionOverwrites: [{ id: guild.id, deny: [PermissionsBitField.Flags.Connect] }]
        });
        channelId = channel.id;
        activeProximityChannels[channelId] = memberIds;
    }

    for (let p of cluster) {
        const member = await guild.members.fetch(p.discordId).catch(() => null);
        if (member && member.voice.channelId) {
            if (member.voice.serverMute) member.voice.setMute(false).catch(() => {});
            if (member.voice.channelId !== channelId) member.voice.setChannel(channelId).catch(() => {});
        }
    }
}

async function moveToLobby(guild, player) {
    const member = await guild.members.fetch(player.discordId).catch(() => null);
    if (member && member.voice.channelId && member.voice.channelId !== CONFIG.LOBBY_CHANNEL_ID) {
        if (activeProximityChannels[member.voice.channelId]) {
            member.voice.setMute(true).catch(() => {});
            member.voice.setChannel(CONFIG.LOBBY_CHANNEL_ID).catch(() => {});
        }
    } else if (member && member.voice.channelId === CONFIG.LOBBY_CHANNEL_ID && !member.voice.serverMute) {
        member.voice.setMute(true).catch(() => {});
    }
}

// تنظيف القنوات الفارغة
setInterval(async () => {
    const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
    if (!guild) return;
    for (const id in activeProximityChannels) {
        const channel = guild.channels.cache.get(id);
        if (!channel || channel.members.size === 0) {
            if (channel) await channel.delete().catch(() => {});
            delete activeProximityChannels[id];
        }
    }
}, 5000);

const PORT = process.env.PORT || 3000;
client.login(CONFIG.TOKEN);
app.listen(PORT, () => console.log(`Discord API running on ${PORT}`));
