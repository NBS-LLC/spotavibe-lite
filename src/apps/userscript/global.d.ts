interface Window {
  spotavibelite: {
    clearCache: () => Promise<void>;
    cachedItemCount: () => Promise<number>;
    cachedItemSizeInBytes: () => Promise<number>;
    help: () => void;
  };
}
