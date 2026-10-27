// Command registry. Every .js file in this folder (except this one) is loaded automatically.
//
// A command file exports an array of command objects:
//   export default [
//     { name: 'hello', aliases: ['hi'], run: async ({ reply, name }) => reply(`Hello ${name}!`) },
//   ];
// Optional fields: owner: true (owner only), hidden: true (silent for non-owners), react: '👋' (emoji on the command message).
// run() receives: sock, msg, jid, sessionId, args, command, name, footer, reply(text), isOwner, isAdmin, targetJid().
// Also add the command to the menu text in lib/menu.js and (optionally) an emoji in REACTIONS in lib/card.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const registry = new Map(); // command name or alias -> command object

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js').sort()) {
  try {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    for (const cmd of [].concat(mod.default || [])) {
      for (const n of [cmd.name, ...(cmd.aliases || [])]) {
        if (!n || typeof cmd.run !== 'function') { console.error(`commands/${file}: invalid command`, n); continue; }
        if (registry.has(n)) console.warn(`commands/${file}: "${n}" is already defined, the later one wins`);
        registry.set(n.toLowerCase(), cmd);
      }
    }
  } catch (err) {
    console.error(`Could not load commands/${file}:`, err?.message || err); // one broken file never stops the other commands
  }
}
console.log(`Loaded ${new Set(registry.values()).size} commands (${registry.size} names)`);
