// Group commands.
// Add a new command by adding one more object to this array (or create a new file in commands/).
import { PREFIX } from '../lib/config.js';

export default [
  {
    name: 'groupinfo',
    async run({ sock, jid, command, reply }) {
        if (!jid.endsWith('@g.us')) return reply('This command only works in groups.');
        const meta = await sock.groupMetadata(jid);
        return reply(`👥 *${meta.subject}*\nMembers: ${meta.participants.length}\nGroup ID: ${jid}`);
    },
  },
];
