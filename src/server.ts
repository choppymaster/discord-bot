// Check for environmental variables.
import discord = require('discord.js');
import path = require('path');
import fs = require('fs');

import logger from './logging';
import state from './state';
import * as data from './data';
import { IModule, ITrigger } from './models/interfaces';

require('checkenv').check();

interface IModuleMap {
  [name: string]: IModule;
}

let cachedModules: IModuleMap = {};
let cachedTriggers: ITrigger[] = [];
const client = new discord.Client({ intents: discord.Intents.FLAGS.GUILD_MEMBERS | discord.Intents.FLAGS.GUILDS | discord.Intents.FLAGS.GUILD_BANS | discord.Intents.FLAGS.GUILD_MESSAGES });
const rulesTrigger = process.env.DISCORD_RULES_TRIGGER;
const rluesRole = process.env.DISCORD_RULES_ROLE;
const mediaUsers = new Map();

logger.info('Application startup. Configuring environment.');
if (!rulesTrigger) {
  throw new Error('DISCORD_RULES_TRIGGER somehow became undefined.');
}
if (!rluesRole) {
  throw new Error('DISCORD_RULES_ROLE somehow became undefined.');
}

function findArray (haystack: string | any[], arr: any[]) {
  return arr.some(function (v: any) {
    return haystack.indexOf(v) >= 0;
  });
}

function IsIgnoredCategory (categoryName: string) {
  const IgnoredCategory = ['internal', 'team', 'development'];
  return IgnoredCategory.includes(categoryName);
}

client.on('ready', async () => {
  // Initialize app channels.
  if (!process.env.DISCORD_LOG_CHANNEL || !process.env.DISCORD_MSGLOG_CHANNEL) {
    throw new Error('DISCORD_LOG_CHANNEL or DISCORD_MSGLOG_CHANNEL not defined.');
  }
  const logChannel = await client.channels.fetch(process.env.DISCORD_LOG_CHANNEL) as discord.TextChannel;
  const msglogChannel = await client.channels.fetch(process.env.DISCORD_MSGLOG_CHANNEL) as discord.TextChannel;
  if (!logChannel.send) throw new Error('DISCORD_LOG_CHANNEL is not a text channel!');
  if (!msglogChannel.send) throw new Error('DISCORD_MSGLOG_CHANNEL is not a text channel!');
  state.logChannel = logChannel;
  state.msglogChannel = msglogChannel;

  logger.info('Bot is now online and connected to server.');
});

client.on('error', (x) => {
  logger.error(x);
  logger.error('Restarting process.');
  process.exit(1);
});
client.on('warn', (x) => {
  logger.warn(x);
});

client.on('disconnect', () => {
  logger.warn('Disconnected from Discord server.');
});

client.on('guildMemberAdd', async (member) => {
  if (process.env.DISCORD_RULES_ROLE) { await member.roles.add(process.env.DISCORD_RULES_ROLE); }
});

client.on('messageDelete', async (message) => {
  const AllowedRoles = ['Administrators', 'Moderators', 'Team', 'Developer', 'Support', 'VIP'];
  const authorRoles = message.member?.roles?.cache?.map(x => x.name);
  if (!authorRoles) {
    logger.error(`Unable to get the roles for ${message.author}`);
    return;
  }
  if (!findArray(authorRoles, AllowedRoles)) {
    const parent = (message.channel as discord.TextChannel).parent;
    if (parent && IsIgnoredCategory(parent.name) === false) {
      if (((message.content && message.content.startsWith('.') === false) || (message.attachments.size > 0)) && message.author?.bot === false) {
        const messageAttachment = message.attachments.first()?.proxyURL;

        const deletionEmbed = new discord.MessageEmbed()
          .setAuthor(message.author?.tag, message.author?.displayAvatarURL())
          .setDescription(`Message deleted in ${message.channel.toString()}`)
          .addField('Content', message.cleanContent || '<no content>', false)
          .setTimestamp()
          .setColor('RED');

        if (messageAttachment) deletionEmbed.setImage(messageAttachment);

        const userInfo = `${message.author?.toString()} (${message.author?.username}) (${message.author})`;

        await state.msglogChannel?.send({ content: userInfo, embeds: [deletionEmbed] });
        logger.info(`${message.author?.username} ${message.author} deleted message: ${message.cleanContent}.`);
      }
    }
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  const AllowedRoles = ['Administrators', 'Moderators', 'Team', 'Developer', 'Support', 'VIP'];
  const authorRoles = oldMessage.member?.roles?.cache?.map(x => x.name);
  if (!authorRoles) {
    logger.error(`Unable to get the roles for ${oldMessage.author}`);
    return;
  }
  if (!findArray(authorRoles, AllowedRoles)) {
    const parent = (oldMessage.channel as discord.TextChannel).parent;
    if (parent && IsIgnoredCategory(parent.name) === false) {
      const oldM = oldMessage.cleanContent || '<no content>';
      const newM = newMessage.cleanContent;
      if (oldMessage.content !== newMessage.content && oldM && newM) {
        const messageAttachment = oldMessage.attachments.first()?.proxyURL;

        const editedEmbed = new discord.MessageEmbed()
          .setAuthor(oldMessage.author?.tag || '<unknown>', oldMessage.author?.displayAvatarURL())
          .setDescription(`Message edited in ${oldMessage.channel.toString()} [Jump To Message](${newMessage.url})`)
          .addField('Before', oldM, false)
          .addField('After', newM, false)
          .setTimestamp()
          .setColor('GREEN');

        if (messageAttachment) editedEmbed.setImage(messageAttachment);

        const userInfo = `${oldMessage.author?.toString()} (${oldMessage.author?.username}) (${oldMessage.author})`;

        await state.msglogChannel?.send({ content: userInfo, embeds: [editedEmbed] });
        logger.info(`${oldMessage.author?.username} ${oldMessage.author} edited message from: ${oldM} to: ${newM}.`);
      }
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot && message.content.startsWith('.ban') === false) { return; }

  if (message.guild == null && state.responses.pmReply) {
    // We want to log PM attempts.
    // logger.info(`${message.author.username} ${message.author} [PM]: ${message.content}`);
    // state.logChannel.send(`${message.author.toString()} [PM]: ${message.content}`);
    await message.reply(state.responses.pmReply);
    return;
  }

  logger.verbose(`${message.author.username} ${message.author} [Channel: ${(message.channel as discord.TextChannel).name} ${message.channel}]: ${message.content}`);

  const authorRoles = message.member?.roles?.cache?.map(x => x.name);

  if (message.channel.id === process.env.DISCORD_MEDIA_CHANNEL && !message.author.bot) {
    const AllowedMediaRoles = ['Administrators', 'Moderators', 'Team', 'VIP'];
    if (!authorRoles) {
      logger.error(`Unable to get the roles for ${message.author}`);
      return;
    }
    if (!findArray(authorRoles, AllowedMediaRoles)) {
      const urlRegex = new RegExp(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,4}\b([-a-zA-Z0-9@:%_+.~#?&\/=]*)/gi);
      if (message.attachments.size > 0 || message.content.match(urlRegex)) {
        mediaUsers.set(message.author.id, true);
      } else if (mediaUsers.get(message.author.id)) {
        mediaUsers.set(message.author.id, false);
      } else {
        await message.delete();
        mediaUsers.set(message.author.id, false);
      }
    }
  }

  // Check if the channel is #rules, if so we want to follow a different logic flow.
  if (message.channel.id === process.env.DISCORD_RULES_CHANNEL) {
    if (message.content.toLowerCase().includes(rulesTrigger)) {
      // We want to remove the 'Unauthorized' role from them once they agree to the rules.
      logger.verbose(`${message.author.username} ${message.author} has accepted the rules, removing role ${process.env.DISCORD_RULES_ROLE}.`);
      await message.member?.roles.remove(rluesRole, 'Accepted the rules.');
    }

    // Delete the message in the channel to force a cleanup.
    await message.delete();
  } else if (message.content.startsWith('.') && message.content.startsWith('..') === false) {
    // We want to make sure it's an actual command, not someone '...'-ing.
    const cmd = message.content.split(' ', 1)[0].slice(1);

    // Check by the name of the command.
    const cachedModule = cachedModules[`${cmd.toLowerCase()}`];
    let quoteResponse = null;
    // Check by the quotes in the configuration.
    if (!cachedModule) quoteResponse = state.responses.quotes[cmd];
    if (!cachedModule && !quoteResponse) return; // Not a valid command.

    // Check access permissions.
    if (!authorRoles) {
      logger.error(`Unable to get the roles for ${message.author}`);
      return;
    }
    if (cachedModule && cachedModule.roles && !findArray(authorRoles, cachedModule.roles)) {
      await state.logChannel?.send(`${message.author.toString()} attempted to use admin command: ${message.content}`);
      logger.info(`${message.author.username} ${message.author} attempted to use admin command: ${message.content}`);
      return;
    }

    logger.info(`${message.author.username} ${message.author} [Channel: ${message.channel}] executed command: ${message.content}`);
    await message.delete();

    try {
      if (cachedModule) {
        await cachedModule.command(message);
      } else if (cachedModules.quote) {
        await cachedModules.quote.command(message, quoteResponse?.reply);
      }
    } catch (err) { logger.error(err); }
  } else if (message.author.bot === false) {
    // This is a normal channel message.
    cachedTriggers.forEach(async function (trigger) {
      if (!trigger.roles || authorRoles && findArray(authorRoles, trigger.roles)) {
        if (trigger.trigger(message) === true) {
          logger.debug(`${message.author.username} ${message.author} [Channel: ${message.channel}] triggered: ${message.content}`);
          try {
            await trigger.execute(message);
          } catch (err) { logger.error(err); }
        }
      }
    });
  }
});

// Cache all command modules.
cachedModules = {};
fs.readdirSync('./commands/').forEach(function (file) {
  // Load the module if it's a script.
  if (path.extname(file) === '.js') {
    if (file.includes('.disabled')) {
      logger.info(`Did not load disabled module: ${file}`);
    } else {
      const moduleName = path.basename(file, '.js').toLowerCase();
      logger.info(`Loaded module: ${moduleName} from ${file}`);
      cachedModules[moduleName] = require(`./commands/${file}`);
    }
  }
});

// Cache all triggers.
cachedTriggers = [];
fs.readdirSync('./triggers/').forEach(function (file) {
  // Load the module if it's a script.
  if (path.extname(file) === '.js') {
    if (file.includes('.disabled')) {
      logger.info(`Did not load disabled trigger: ${file}`);
    } else {
      const moduleName = path.basename(file, '.js').toLowerCase();
      logger.info(`Loaded trigger: ${moduleName} from ${file}`);
      try {
        cachedTriggers.push(require(`./triggers/${file}`));
      } catch (e) {
        logger.error(`Could not load trigger ${moduleName}: ${e}`);
      }
    }
  }
});

data.readWarnings();
data.readBans();

// Load custom responses
if (process.env.DATA_CUSTOM_RESPONSES) {
  data.readCustomResponses();
}

client.login(process.env.DISCORD_LOGIN_TOKEN).catch(err => logger.error(err));
logger.info('Startup completed. Established connection to Discord.');
