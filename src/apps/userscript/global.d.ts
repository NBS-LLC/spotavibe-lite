interface Window {
  spotavibelite: {
    clearCache: () => Promise<void>;
    cachedItemCount: () => Promise<number>;
    cachedItemSizeInBytes: () => Promise<number>;
    donate: () => void;
    help: () => void;
  };
}
