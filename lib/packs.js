// Call packs: a named set of one audio + one video clip. Used by .callto to place an outgoing call.
import { getSetting, setSetting } from './storage.js';
import { deleteCallMedia, loadCallMedia, saveCallMedia } from './calls.js';
import { callbotApi } from './callbot.js';
import { state } from './config.js';

export const PACK_RE = /^[a-z0-9_-]{1,20}$/;
export const MAX_PACKS = 20;

const mediaKey = (pack, kind) => `pack_${pack}_${kind}`; // reuses the call media storage (disk + MongoDB)
export const listPackNames = (sid) => getSetting(sid, 'callPacks', []);
export const hasPackMedia = (sid, pack, kind) => !!getSetting(sid, `call_${mediaKey(pack, kind)}`, null);
export const packInfo = (sid, pack) => ({ audio: hasPackMedia(sid, pack, 'audio'), video: hasPackMedia(sid, pack, 'video') });
export const packExists = (sid, pack) => listPackNames(sid).includes(pack);

export async function savePackMedia(sid, pack, kind, buf, meta) {
  await saveCallMedia(sid, mediaKey(pack, kind), buf, meta);
  const names = listPackNames(sid);
  if (!names.includes(pack)) setSetting(sid, 'callPacks', [...names, pack]);
}

export async function deletePack(sid, pack) {
  for (const kind of ['audio', 'video']) await deleteCallMedia(sid, mediaKey(pack, kind));
  setSetting(sid, 'callPacks', listPackNames(sid).filter((n) => n !== pack));
  if (state.callbotAvailable) await callbotApi('DELETE', `/sessions/${sid}/packs/${pack}`).catch(() => {});
}

// Makes sure the call service has every clip of this pack (e.g. after a redeploy wiped its disk).
export async function pushPack(sid, pack) {
  const have = (await callbotApi('GET', `/sessions/${sid}/packs`)).packs?.[pack] || {};
  for (const kind of ['audio', 'video']) {
    if (!hasPackMedia(sid, pack, kind)) continue;
    const has = kind === 'audio' ? have.hasAudio : have.hasVideo;
    if (has) continue;
    const media = await loadCallMedia(sid, mediaKey(pack, kind));
    if (media) await callbotApi('PUT', `/sessions/${sid}/packs/${pack}/media/${kind}`, { body: media.buf, timeout: 180000 });
  }
}
