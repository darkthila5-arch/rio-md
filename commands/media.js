// Media / sticker commands.
// Add a new command by adding one more object to this array (or create a new file in commands/).
import { PREFIX } from '../lib/config.js';

export default [
  {
    name: 'media', aliases: ['sticker'],
    async run({ command, reply }) {
        return reply(`🎨 *MEDIA MENU*\n${PREFIX}sticker — sticker help\n${PREFIX}media — media command guide\n\nMedia conversion plugins can be added later.`);
    },
  },
];
