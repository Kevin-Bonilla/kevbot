import fs from 'fs';
import path from 'path';
import { Client } from 'discord.js';

const dataPath = path.resolve(__dirname, '../../data/inactive_users.json');

export class InactiveUserService {
  /**
   * Scans all text channels to find users who haven't messaged in over a year.
   * It fetches messages in batches until it hits the 1-year cutoff date.
   * @param client The Discord client instance
   * @returns {Promise<Array>} List of inactive user objects
   */
  static async scanInactiveUsers(client: Client): Promise<Array> {
    console.log("Starting inactive user scan...");
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);
    
    console.log(`Cutoff date set to: ${cutoffDate.toISOString()}`);
    
    const lastSeen = new Map<number, Date>(); // Map of userId to latest message date

    const channels = client.channels.cache.filter(c => c.isTextBased());
    console.log(`Found ${channels.size} text channels.`);
    
    for (const channel of channels) {
      // Check if we have permissions to read messages in this channel
      if (!client.guilds.cache.get(channel.guildId)?.members.me?.permissions.has('ViewChannel')) {
        console.log(`Skipping channel ${channel.name} (ID: ${channel.id}) due to lack of ViewChannel permission.`);
        continue;
      }

      if (!channel.messages || typeof channel.messages.fetch !== 'function') {
        console.log(`Skipping channel ${channel.name} (ID: ${channel.id}) because messages.fetch is not a function.`);
        continue;
      }

      try {
        let lastId: string | null = null;
        let foundOldEnough = false;
        let messagesFromThisChannel = 0;

        while (!foundOldEnough) {
          const messages = await channel.messages.fetch({ 
            limit: 100,
            before: lastId 
          });

          if (messages.size === 0) break;

          messagesFromThisChannel += messages.size;
          for (const msg of messages) {
            if (!msg.author.bot) {
              const currentLastSeen = lastSeen.get(msg.author.id);
              if (!currentLastSeen || msg.created_at > currentLastSeen) {
                lastSeen.set(msg.author.id, msg.created_at);
              }
            }

            if (msg.created_at < cutoffDate) {
              foundOldEnough = true;
            }
          }

          lastId = messages.last().id;
          if (messages.size < 100) break;
        }
        console.log(`Successfully scanned channel: ${channel.name} (${channel.id}) - Fetched ${messagesFromThisChannel} messages.`);
      } catch (err) {
        console.error(`Error reading history for channel ${channel?.name || channel?.id}:`, err);
      }
    }

    console.log(`Total unique users found in messages: ${lastSeen.size}`);
    
    const guild = client.guilds.cache.first();
    if (!guild) {
      console.error("No guild found. Could not check members.");
      return [];
    }

    const members = await guild.members.fetch();
    console.log(`Total members in guild: ${members.size}`);

    const inactiveUsers = [];
    for (const [userId, lastDate] of lastSeen.entries()) {
      const member = members.get(userId);
      if (member && member.user.bot === false) {
        if (lastDate < cutoffDate) {
          inactiveUsers.push({
            username: member.user.username,
            id: member.id,
            lastActive: lastDate.toISOString()
          });
        }
      }
    }

    console.log(`Inactive users identified: ${inactiveUsers.length}`);
    fs.writeFileSync(dataPath, JSON.stringify(inactiveUsers, null, 2));
    return inactiveUsers;
  }
}
