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
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

app.use(express.json());

let playerPositions = {}; 
let tempLinkCodes = {}; // { code: robloxUserId }
let activeProximityChannels = {};

// --- [ API Routes ] ---

// توليد كود الربط من روبلوكس
app.post('/generate_link', (req, res) => {
    const { userId, code } = req.body;
    tempLinkCodes[code] = userId;
    console.log(`[Roblox] New Link Code: ${code} for User: ${userId}`);
    res.send({ success: true });
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

app.post('/update', (req, res) => {
    const { players } = req.body;
    if (players) {
        players.forEach(p => {
            if (playerPositions[p.userId]) playerPositions[p.userId].pos = p.pos;
        });
        handleProximityMoves();
    }
    res.send("OK");
});

// تحقق هل اللاعب مرتبط أم لا
app.get('/is_linked/:userId', (req, res) => {
    const isLinked = !!playerPositions[req.params.userId];
    res.send({ linked: isLinked });
});

// --- [ Discord Logic ] ---

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!link')) {
        const code = message.content.split(' ')[1];
        if (!code) return message.reply("⚠️ اكتب الكود هكذا: `!link 123456` ");

        const robloxUserId = tempLinkCodes[code];
        if (robloxUserId) {
            playerPositions[robloxUserId] = {
                discordId: message.author.id,
                userId: robloxUserId,
                pos: { x: 0, y: 0, z: 0 }
            };
            delete tempLinkCodes[code];
            message.reply(`✅ **تم الربط بنجاح!** حساب روبلوكس المرتبط: ${robloxUserId}`);
            console.log(`[Success] Linked Discord ${message.author.id} to Roblox ${robloxUserId}`);
        } else {
            message.reply("❌ الكود خاطئ أو انتهت صلاحيته.");
        }
    }
});

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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
