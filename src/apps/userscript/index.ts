import { AudioAnalyzer } from "#lib/audio-analysis/AudioAnalyzer";
import { ReccoBeatsAnalyzer } from "#lib/audio-analysis/ReccoBeatsAnalyzer";
import { config } from "#lib/config";
import { onMutation, waitForElem } from "#lib/html";
import { log } from "#lib/log";
import { SequentialProcessor } from "#lib/queue/SequentialProcessor";
import { SpotifyWebPage } from "#lib/spotify-web/SpotifyWebPage";
import { Cache } from "#lib/storage/Cache";
import { CacheStats } from "#lib/storage/CacheStats";
import { LocalStorageAdapter } from "#lib/storage/LocalStorageAdapter";

config.appName = "SpotAVibe Lite";
config.appId = "spotavibe-lite";

const storage = await LocalStorageAdapter.create();
const cacheProvider = new Cache(storage);
const cacheStats = new CacheStats(storage);

window.spotavibelite = {
  clearCache: async () => {
    await cacheProvider.clear();
  },

  cachedItemCount: async () => {
    return await cacheStats.getNamespaceItemCount();
  },

  cachedItemSizeInBytes: async () => {
    return await cacheStats.getNamespaceUsageInBytes();
  },

  donate: () => {
    console.log(
      log.namespace,
      `Show your support for ${config.appName} by donating: https://www.paypal.com/ncp/payment/EZHV3YMSZFQ4G.`,
    );
  },

  help: () => {
    console.log(`
      ${log.namespace} Console Commands

      - clearCache(): Empties the cache (removes all items).
      - cachedItemCount(): The count of all cached items.
      - cachedItemSizeInBytes(): The total size of cached items, in bytes.
      - donate(): Displays a donation link to help support this project.
      - help(): Displays this message.
    `);
  },
};

window.spotavibelite.donate();

await cacheProvider.prune();
await cacheProvider.enforceQuota();

console.debug(
  log.namespace,
  `Cache count: ${await cacheStats.getNamespaceItemCount()} (namespaced) / ${await cacheStats.getAllItemCount()} (total) items.`,
);

console.debug(
  log.namespace,
  `Cache usage: ${await cacheStats.getNamespaceUsageInBytes()} (namespaced) / ${await cacheStats.getAllUsageInBytes()} (total) bytes.`,
);

const audioAnalyzer = new AudioAnalyzer(
  new ReccoBeatsAnalyzer(fetch),
  cacheProvider,
);

const seqProcessor = new SequentialProcessor(enrichTrack, 150);

const spotifyWebPage = new SpotifyWebPage();

async function enrichNowPlaying() {
  const trackId = spotifyWebPage.getNowPlayingTrackId();
  const enrichedTrack = await audioAnalyzer.getEnrichedTrack(trackId);
  console.log(
    log.namespace,
    "Now playing track:",
    enrichedTrack.getHumanReadableString(),
  );

  console.groupCollapsed(log.namespace, "Now Playing - Enriched Track Data");
  console.log(enrichedTrack.details);
  console.log(enrichedTrack.features);
  console.groupEnd();

  spotifyWebPage.insertNowPlayingTrackStats(enrichedTrack.getStatsString());
}

async function enrichTracks(mutationRecord: MutationRecord) {
  for (const node of mutationRecord.addedNodes) {
    if (node instanceof Element) {
      const links = node.querySelectorAll<HTMLAnchorElement>(
        spotifyWebPage.trackLink,
      );

      links.forEach((link) => {
        seqProcessor.enqueue(link);
      });
    }
  }
}

async function enrichTrack(element: HTMLAnchorElement) {
  const trackId = element.href.split("/").at(-1)!;
  const enrichedTrack = await audioAnalyzer.getEnrichedTrack(trackId);
  console.log(log.namespace, enrichedTrack.getHumanReadableString());

  console.groupCollapsed(log.namespace, "Enriched Track Data");
  console.log(enrichedTrack.details);
  console.log(enrichedTrack.features);
  console.groupEnd();

  spotifyWebPage.insertTrackStats(element, enrichedTrack.getStatsString());
}

function main() {
  waitForElem(spotifyWebPage.nowPlayingTrack).then((elem) => {
    onMutation(elem, enrichNowPlaying, { attributes: true, childList: false });
    enrichNowPlaying();
  });

  waitForElem(spotifyWebPage.mainView).then((elem) => {
    onMutation(elem, enrichTracks, {
      attributes: false,
      childList: true,
      subtree: true,
    });
  });
}

main();
