import fs from 'fs';
import path from 'path';
import { Client, Collection, Message } from 'discord.js';

const dataPath = path.resolve(__dirname, '../../data/inactive_users.json');

type InactiveUser = {
  username: string;
  id: string;
  lastActive: string | null;
};

export class InactiveUserService {
  /**
   * Scans all text channels to find users who haven't messaged in over a year.
   * It fetches the complete available history to identify each user's latest message.
   * @param client The Discord client instance
   * @returns List of inactive user objects
   */
  static async scanInactiveUsers(client: Client): Promise<InactiveUser[]> {
    console.log("Starting inactive user scan...");
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);
    
    console.log(`Cutoff date set to: ${cutoffDate.toISOString()}`);
    
    const lastSeen = new Map<string, Date>();

    const guild = client.guilds.cache.first();
    if (!guild) {
      console.error("No guild found. Could not check members.");
      return [];
    }

    const channels = guild.channels.cache.filter(c => c.isTextBased());
    console.log(`Found ${channels.size} text channels.`);
    
    for (const channel of channels.values()) {
      if (!('messages' in channel) || typeof channel.messages.fetch !== 'function') {
        console.log(`Skipping channel ${channel.name || 'Unknown'} (ID: ${channel.id}) - Reason: messages.fetch is not a function.`);
        continue;
      }

      try {
        let lastId: string | null = null;
        let messagesFromThisChannel = 0;

        while (true) {
          const messages: Collection<string, Message> = await channel.messages.fetch({
            limit: 100,
            ...(lastId ? { before: lastId } : {}),
          });

          if (messages.size === 0) break;

          messagesFromThisChannel += messages.size;
          for (const msg of messages.values()) {
            if (!msg.author.bot) {
              const currentLastSeen = lastSeen.get(msg.author.id);
              if (!currentLastSeen || msg.createdAt > currentLastSeen) {
                lastSeen.set(msg.author.id, msg.createdAt);
              }
            }
          }

          const oldestMessageId: string | undefined = messages.last()?.id;
          if (!oldestMessageId || messages.size < 100) break;
          lastId = oldestMessageId;
        }
        console.log(`Successfully scanned channel: ${channel.name} (${channel.id}) - Fetched ${messagesFromThisChannel} messages.`);
      } catch (err) {
        console.error(`Error reading history for channel ${channel?.name || channel?.id}:`, err);
      }
    }

    console.log(`Total unique users found in messages: ${lastSeen.size}`);
    
    const members = await guild.members.fetch();
    console.log(`Total members in guild: ${members.size}`);

    const inactiveUsers: InactiveUser[] = [];
    for (const member of members.values()) {
      if (member.user.bot) continue;

      const lastDate = lastSeen.get(member.id);
      if (!lastDate || lastDate < cutoffDate) {
        inactiveUsers.push({
          username: member.user.username,
          id: member.id,
          lastActive: lastDate?.toISOString() ?? null,
        });
      }
    }

    console.log(`Inactive users identified: ${inactiveUsers.length}`);
    fs.writeFileSync(dataPath, JSON.stringify(inactiveUsers, null, 2));
    return inactiveUsers;
  }
}
