import axios, { AxiosInstance, AxiosError } from "axios";
import { Config } from "../config/Config";
import { Logger } from "../utils/Logger";
import { Track } from "../types/Track";
import winston from "winston";

export class SlskdService {
  private config: Config;
  private logger: winston.Logger;
  private client: AxiosInstance;

  // Cache pour éviter les téléchargements multiples
  private activeDownloads = new Map<
    string,
    { startTime: number; attempts: number }
  >();
  private completedDownloads = new Set<string>();
  private failedDownloads = new Set<string>();

  constructor() {
    this.config = Config.getInstance();
    this.logger = Logger.getInstance();
    this.client = axios.create({
      baseURL: this.config.slskdUrl,
      timeout: 30000,
      headers: {
        "X-API-Key": this.config.slskdApiKey,
        "Content-Type": "application/json",
      },
      validateStatus: (status) => status < 500,
    });

    this.logger.debug(
      `SlskdService initialized with URL: ${this.config.slskdUrl}`
    );
    this.logger.debug(
      `API Key configured: ${this.config.slskdApiKey ? "Yes" : "No"}`
    );
  }

  async testConnection(): Promise<void> {
    try {
      this.logger.debug(
        `Testing connection to: ${this.config.slskdUrl}/api/v0/session`
      );

      const response = await this.client.get("/api/v0/session");

      this.logger.debug(`Response status: ${response.status}`);
      this.logger.debug(`Response headers:`, response.headers);
      this.logger.debug(
        `Response data:`,
        JSON.stringify(response.data, null, 2)
      );

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      if (response.data === undefined || response.data === null) {
        throw new Error("Empty response from slskd");
      }

      this.logger.info("✅ Slskd connection test successful");
      this.logger.debug(
        `Connected to slskd version: ${response.data.version || "unknown"}`
      );

      // Vérifier les paramètres de recherche slskd
      try {
        this.logger.info("🔧 Checking slskd search configuration...");
        const optionsResponse = await this.client.get("/api/v0/options");

        if (optionsResponse.data?.searches) {
          const searchConfig = optionsResponse.data.searches;
          this.logger.info(`📊 Search configuration:`, {
            responseLimit: searchConfig.responseLimit,
            fileLimit: searchConfig.fileLimit,
            filterResponses: searchConfig.filterResponses,
            maximumPeerQueueLength: searchConfig.maximumPeerQueueLength,
          });

          if (searchConfig.responseLimit === 0) {
            this.logger.warn(
              `⚠️ WARNING: slskd responseLimit is set to 0 - this will prevent downloads!`
            );
            this.logger.warn(
              `⚠️ Please update slskd configuration to set searches.responseLimit > 0`
            );
          }
        }
      } catch (configError) {
        this.logger.debug(
          "Could not fetch slskd search configuration:",
          configError
        );
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        this.logger.error("Slskd connection test failed (Axios Error):");
        this.logger.error(`- URL: ${axiosError.config?.url}`);
        this.logger.error(`- Status: ${axiosError.response?.status}`);
        this.logger.error(`- Response Data:`, axiosError.response?.data);

        if (axiosError.code === "ECONNREFUSED") {
          throw new Error(
            `Connection refused to ${this.config.slskdUrl}. Is slskd running and accessible?`
          );
        } else if (axiosError.code === "ENOTFOUND") {
          throw new Error(
            `Host not found: ${this.config.slskdUrl}. Check the URL.`
          );
        } else if (axiosError.response?.status === 401) {
          throw new Error(`Unauthorized access to slskd. Check your API key.`);
        }
      }

      throw error;
    }
  }

  async downloadTrack(track: Track): Promise<boolean> {
    const trackKey = this.getTrackKey(track);

    // Vérifier si on a déjà traité ce track
    if (this.completedDownloads.has(trackKey)) {
      this.logger.info(
        `✅ Track already completed: ${track.artist} - ${track.title}`
      );
      return true;
    }

    if (this.failedDownloads.has(trackKey)) {
      this.logger.warn(
        `❌ Track already failed: ${track.artist} - ${track.title}`
      );
      return false;
    }

    if (this.activeDownloads.has(trackKey)) {
      const download = this.activeDownloads.get(trackKey)!;
      const elapsed = (Date.now() - download.startTime) / 1000;
      this.logger.info(
        `⏳ Track already in progress: ${track.artist} - ${
          track.title
        } (${elapsed.toFixed(0)}s ago)`
      );

      // Si le téléchargement est très ancien (>10min), on le considère comme bloqué
      if (elapsed > 600) {
        this.logger.warn(
          `🔄 Download seems stuck, will retry: ${track.artist} - ${track.title}`
        );
        this.activeDownloads.delete(trackKey);
      } else {
        // Monitorer le téléchargement existant
        return await this.monitorExistingDownload(track, download);
      }
    }

    // Vérifier si le track existe déjà dans slskd downloads
    const existingDownload = await this.findExistingDownload(track);
    if (existingDownload) {
      this.logger.info(
        `📥 Found existing download: ${track.artist} - ${track.title}`
      );
      this.activeDownloads.set(trackKey, {
        startTime: Date.now(),
        attempts: 1,
      });
      return await this.waitForDownloadCompletion(existingDownload, 10);
    }

    // Marquer comme téléchargement actif
    this.activeDownloads.set(trackKey, { startTime: Date.now(), attempts: 1 });

    try {
      this.logger.info(
        `⬇️ Starting new download: ${track.artist} - ${track.title}`
      );

      // Recherche avec timeout plus court pour éviter l'attente excessive
      const { searchResults, searchId } = await this.searchTrack(track);

      if (!searchResults || searchResults.length === 0) {
        this.logger.warn(
          `❌ No search results for: ${track.artist} - ${track.title}`
        );
        this.markTrackAsFailed(trackKey);
        return false;
      }

      // Sélectionner le meilleur match
      const bestMatch = this.selectBestMatch(searchResults, track);
      if (!bestMatch) {
        this.logger.warn(
          `❌ No suitable match found for: ${track.artist} - ${track.title}`
        );
        this.markTrackAsFailed(trackKey);
        return false;
      }

      this.logger.info(
        `✅ Selected: ${bestMatch.filename} from ${bestMatch.username}`
      );

      // Initier le téléchargement
      const downloadSuccess = await this.initiateDownload(bestMatch);

      if (!downloadSuccess) {
        this.logger.error(
          `❌ Failed to initiate download: ${track.artist} - ${track.title}`
        );
        this.markTrackAsFailed(trackKey);
        return false;
      }

      // Attendre un moment que slskd traite la demande
      await this.sleep(5000);

      // Vérifier que le téléchargement a bien été ajouté
      const downloadInQueue = await this.findDownloadInQueue(bestMatch);

      if (!downloadInQueue) {
        this.logger.warn(
          `❌ Download not found in queue: ${track.artist} - ${track.title}`
        );
        this.markTrackAsFailed(trackKey);
        return false;
      }

      // Attendre la completion avec timeout réduit
      const completed = await this.waitForDownloadCompletion(
        downloadInQueue,
        10
      );

      if (completed) {
        this.logger.info(
          `🎉 Successfully downloaded: ${track.artist} - ${track.title}`
        );
        this.markTrackAsCompleted(trackKey);
        return true;
      } else {
        this.logger.warn(
          `⏰ Download timeout: ${track.artist} - ${track.title}`
        );
        this.markTrackAsFailed(trackKey);
        return false;
      }
    } catch (error) {
      this.logger.error(
        `❌ Download failed: ${track.artist} - ${track.title}:`,
        error
      );
      this.markTrackAsFailed(trackKey);
      return false;
    }
  }

  private getTrackKey(track: Track): string {
    return `${track.artist.toLowerCase()}-${track.title.toLowerCase()}`.replace(
      /[^a-z0-9-]/g,
      ""
    );
  }

  private markTrackAsCompleted(trackKey: string): void {
    this.activeDownloads.delete(trackKey);
    this.completedDownloads.add(trackKey);
  }

  private markTrackAsFailed(trackKey: string): void {
    this.activeDownloads.delete(trackKey);
    this.failedDownloads.add(trackKey);
  }

  private async monitorExistingDownload(
    track: Track,
    download: { startTime: number; attempts: number }
  ): Promise<boolean> {
    // Chercher le téléchargement existant dans slskd
    const existingDownload = await this.findExistingDownload(track);
    if (!existingDownload) {
      this.logger.warn(
        `⚠️ Active download not found in queue, will retry: ${track.artist} - ${track.title}`
      );
      this.activeDownloads.delete(this.getTrackKey(track));
      return await this.downloadTrack(track);
    }

    // Surveiller avec timeout réduit
    return await this.waitForDownloadCompletion(existingDownload, 5);
  }

  private async findExistingDownload(track: Track): Promise<any | null> {
    try {
      const downloads = await this.getActiveDownloads();

      for (const download of downloads) {
        if (download.files) {
          for (const file of download.files) {
            if (this.isTrackMatch(file, track)) {
              return {
                ...file,
                username: download.username,
                downloadId: download.id,
              };
            }
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.debug("Error checking existing downloads:", error);
      return null;
    }
  }

  private isTrackMatch(file: any, track: Track): boolean {
    const normalize = (str: string) =>
      str.toLowerCase().replace(/[^a-z0-9]/g, "");
    const fileName = normalize(file.filename || "");
    const artist = normalize(track.artist);
    const title = normalize(track.title);

    return fileName.includes(artist) && fileName.includes(title);
  }

  private async findDownloadInQueue(file: any): Promise<any | null> {
    try {
      await this.sleep(3000);

      const downloads = await this.getActiveDownloads();

      for (const download of downloads) {
        if (download.username === file.username && download.files) {
          for (const queuedFile of download.files) {
            if (this.filesMatch(queuedFile.filename, file.filename)) {
              return {
                ...queuedFile,
                username: download.username,
                downloadId: download.id,
              };
            }
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.debug("Error finding download in queue:", error);
      return null;
    }
  }

  private filesMatch(filename1: string, filename2: string): boolean {
    const normalize = (str: string) => str.toLowerCase().replace(/[^\w]/g, "");
    return normalize(filename1) === normalize(filename2);
  }

  private async searchTrack(
    track: Track
  ): Promise<{ searchResults: any[]; searchId: string | null }> {
    try {
      const searchQuery = `${track.artist} ${track.title}`;
      this.logger.info(`🔍 Searching for: "${searchQuery}"`);

      const searchResponse = await this.client.post("/api/v0/searches", {
        searchText: searchQuery,
        timeout: 30000, // Timeout réduit
      });

      if (!searchResponse.data) {
        throw new Error("No data in search initiation response");
      }

      // Handle different response formats
      let searchId: string | null = null;
      if (searchResponse.data?.id) {
        searchId = searchResponse.data.id;
      } else if (searchResponse.data?.searchId) {
        searchId = searchResponse.data.searchId;
      } else if (typeof searchResponse.data === "string") {
        searchId = searchResponse.data;
      } else {
        throw new Error("No search ID returned - unexpected response format");
      }

      this.logger.debug(`Search initiated with ID: ${searchId}`);

      // Attendre les résultats avec timeout réduit
      let attempts = 0;
      const maxAttempts = 8; // 40 secondes max

      while (attempts < maxAttempts) {
        await this.sleep(5000);
        attempts++;

        try {
          const statusResponse = await this.client.get(
            `/api/v0/searches/${searchId}`
          );

          if (statusResponse.data?.state === "InProgress") {
            continue;
          }

          if (!statusResponse.data?.isComplete) {
            if (attempts < maxAttempts) {
              continue;
            }
            this.logger.warn(`❌ Search timeout after ${maxAttempts * 5}s`);
            return { searchResults: [], searchId };
          }

          // Récupérer les résultats
          const responsesResponse = await this.client.get(
            `/api/v0/searches/${searchId}/responses`
          );

          if (
            !responsesResponse.data ||
            !Array.isArray(responsesResponse.data)
          ) {
            return { searchResults: [], searchId };
          }

          // Traiter les résultats
          const allFiles: any[] = [];
          for (const response of responsesResponse.data) {
            if (response.files && Array.isArray(response.files)) {
              for (const file of response.files) {
                allFiles.push({
                  ...file,
                  username: response.username,
                  response: response,
                });
              }
            }
          }

          this.logger.info(
            `✅ Found ${allFiles.length} files in search results`
          );

          // Nettoyer la recherche immédiatement après récupération des résultats
          if (searchId !== null) {
            this.cleanupSearch(searchId);
          }

          return { searchResults: allFiles, searchId: null }; // searchId null car nettoyé
        } catch (resultsError) {
          if (attempts >= maxAttempts) {
            throw resultsError;
          }
        }
      }

      return { searchResults: [], searchId };
    } catch (error) {
      this.logger.error(
        `Search failed for ${track.artist} - ${track.title}:`,
        error
      );
      return { searchResults: [], searchId: null };
    }
  }

  private async cleanupSearch(searchId: string): Promise<void> {
    try {
      await this.client.delete(`/api/v0/searches/${searchId}`);
      this.logger.debug(`Search ${searchId} cleaned up`);
    } catch (error) {
      this.logger.debug(`Failed to cleanup search ${searchId}:`, error);
    }
  }

  private selectBestMatch(searchResults: any[], track: Track): any | null {
    if (searchResults.length === 0) {
      return null;
    }

    // Score et trier
    const scoredResults = searchResults.map((file) => ({
      file,
      score: this.calculateMatchScore(file, track),
    }));

    scoredResults.sort((a, b) => b.score - a.score);

    // Log top 3 results
    this.logger.info("📊 Top 3 search results:");
    scoredResults.slice(0, 3).forEach((result, index) => {
      this.logger.info(
        `  ${index + 1}. ${result.file.filename} (score: ${result.score.toFixed(
          2
        )})`
      );
    });

    // Filtrer par qualité
    const qualityFiltered = scoredResults.filter(
      (result) => result.score > 0.4 && this.isAcceptableQuality(result.file)
    );

    return qualityFiltered.length > 0 ? qualityFiltered[0].file : null;
  }

  private calculateMatchScore(file: any, track: Track): number {
    const normalize = (str: string) =>
      str
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const fileName = normalize(file.filename || "");
    const searchArtist = normalize(track.artist);
    const searchTitle = normalize(track.title);

    let score = 0;

    // Correspondances exactes
    if (fileName.includes(searchArtist)) score += 0.4;
    if (fileName.includes(searchTitle)) score += 0.4;

    // Correspondances partielles
    const artistWords = searchArtist
      .split(" ")
      .filter((word) => word.length > 2);
    const titleWords = searchTitle.split(" ").filter((word) => word.length > 2);

    let artistMatches = 0;
    let titleMatches = 0;

    artistWords.forEach((word) => {
      if (fileName.includes(word)) artistMatches++;
    });

    titleWords.forEach((word) => {
      if (fileName.includes(word)) titleMatches++;
    });

    if (artistWords.length > 0) {
      score += (artistMatches / artistWords.length) * 0.2;
    }

    if (titleWords.length > 0) {
      score += (titleMatches / titleWords.length) * 0.2;
    }

    // Bonus qualité
    if (file.filename?.match(/\.(flac|wav)$/i)) score += 0.1;
    else if (file.filename?.match(/\.mp3$/i)) score += 0.05;

    if (file.bitRate) {
      if (file.bitRate >= 320) score += 0.05;
      else if (file.bitRate >= 256) score += 0.03;
    }

    return Math.min(score, 1.0);
  }

  private isAcceptableQuality(file: any): boolean {
    // Extension valide
    if (!file.filename?.match(/\.(mp3|flac|wav|m4a|ogg|aac)$/i)) {
      return false;
    }

    // Bitrate minimum
    if (file.bitRate && file.bitRate < 128) {
      return false;
    }

    // Taille minimum
    if (file.size && file.size < 1024 * 1024) {
      return false;
    }

    return true;
  }

  private async initiateDownload(file: any): Promise<boolean> {
    try {
      if (!file.username || !file.filename) {
        return false;
      }

      const downloadRequest = [
        {
          filename: file.filename,
          size: file.size || 0,
        },
      ];

      this.logger.info(
        `🚀 Initiating download: ${file.filename} from ${file.username}`
      );

      const downloadUrl = `/api/v0/transfers/downloads/${encodeURIComponent(
        file.username
      )}`;
      const response = await this.client.post(downloadUrl, downloadRequest);

      const success =
        response.status === 200 ||
        response.status === 201 ||
        response.status === 204;

      if (success) {
        this.logger.info(
          `✅ Download request accepted (HTTP ${response.status})`
        );
      } else {
        this.logger.error(
          `❌ Download request rejected: HTTP ${response.status}`
        );
      }

      return success;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `❌ Download initiation failed: ${error.response?.status}`
        );
      }
      return false;
    }
  }

  private async waitForDownloadCompletion(
    file: any,
    maxWaitMinutes: number = 10
  ): Promise<boolean> {
    const maxWait = maxWaitMinutes * 60 * 1000;
    const startTime = Date.now();
    const checkInterval = 15000; // Check toutes les 15 secondes

    this.logger.info(`⏳ Monitoring download (max ${maxWaitMinutes}min)`);

    let lastStatus = "";
    let downloadFound = false;

    while (Date.now() - startTime < maxWait) {
      try {
        const response = await this.client.get("/api/v0/transfers/downloads");

        if (!response.data) {
          await this.sleep(checkInterval);
          continue;
        }

        const downloads = Array.isArray(response.data)
          ? response.data
          : [response.data];

        // Chercher notre téléchargement
        for (const download of downloads) {
          if (download.username === file.username && download.files) {
            for (const downloadFile of download.files) {
              const isOurFile = this.filesMatch(
                downloadFile.filename,
                file.filename
              );

              if (isOurFile) {
                downloadFound = true;
                const currentStatus = `${download.state}:${
                  downloadFile.state || "unknown"
                }`;

                if (currentStatus !== lastStatus) {
                  this.logger.info(
                    `📥 Status: ${download.state} | File: ${
                      downloadFile.state || "unknown"
                    }`
                  );
                  lastStatus = currentStatus;
                }

                // États de succès
                if (
                  download.state === "Completed" ||
                  download.state === "Succeeded" ||
                  downloadFile.state === "Completed" ||
                  downloadFile.state === "Succeeded"
                ) {
                  return true;
                }

                // États d'échec
                if (
                  download.state === "Cancelled" ||
                  download.state === "Failed" ||
                  download.state === "TimedOut" ||
                  downloadFile.state === "Cancelled" ||
                  downloadFile.state === "Failed" ||
                  downloadFile.state === "TimedOut"
                ) {
                  this.logger.warn(
                    `❌ Download failed: ${download.state}/${downloadFile.state}`
                  );
                  return false;
                }
                break;
              }
            }
          }
        }

        // Si pas trouvé après 30 secondes, échec
        if (!downloadFound && Date.now() - startTime > 30000) {
          this.logger.warn("❌ Download not found in queue after 30s");
          return false;
        }
      } catch (error) {
        this.logger.debug("Error checking download status:", error);
      }

      await this.sleep(checkInterval);
    }

    this.logger.warn(`⏰ Download timeout after ${maxWaitMinutes} minutes`);
    return false;
  }

  async getActiveDownloads(): Promise<any[]> {
    try {
      const response = await this.client.get("/api/v0/transfers/downloads");

      if (!response.data) {
        return [];
      }

      const downloads = Array.isArray(response.data)
        ? response.data
        : [response.data];

      // Filtrer les téléchargements actifs
      return downloads.filter(
        (download) =>
          download.state !== "Completed" &&
          download.state !== "Succeeded" &&
          download.state !== "Failed" &&
          download.state !== "Cancelled"
      );
    } catch (error) {
      this.logger.debug("Failed to get active downloads:", error);
      return [];
    }
  }

  async getDownloadStatus(): Promise<{
    active: number;
    completed: number;
    failed: number;
  }> {
    try {
      const response = await this.client.get("/api/v0/transfers/downloads");

      if (!response.data) {
        return { active: 0, completed: 0, failed: 0 };
      }

      const downloads = Array.isArray(response.data)
        ? response.data
        : [response.data];

      let active = 0,
        completed = 0,
        failed = 0;

      downloads.forEach((download) => {
        switch (download.state) {
          case "Completed":
          case "Succeeded":
            completed++;
            break;
          case "Failed":
          case "Cancelled":
          case "TimedOut":
            failed++;
            break;
          default:
            active++;
        }
      });

      return { active, completed, failed };
    } catch (error) {
      this.logger.debug("Failed to get download status:", error);
      return { active: 0, completed: 0, failed: 0 };
    }
  }

  async clearAllSearches(): Promise<void> {
    try {
      const searchesResponse = await this.client.get("/api/v0/searches");

      if (searchesResponse.data && Array.isArray(searchesResponse.data)) {
        for (const search of searchesResponse.data) {
          if (search.id) {
            await this.cleanupSearch(search.id);
          }
        }
        this.logger.info(
          `🧹 Cleaned up ${searchesResponse.data.length} searches`
        );
      }
    } catch (error) {
      this.logger.debug("Failed to clear all searches:", error);
    }
  }

  async cancelAllDownloads(): Promise<void> {
    try {
      this.logger.info("🛑 Cancelling all active downloads...");

      const downloads = await this.getActiveDownloads();

      for (const download of downloads) {
        try {
          await this.client.delete(
            `/api/v0/transfers/downloads/${encodeURIComponent(
              download.username
            )}/${encodeURIComponent(download.id)}`
          );
        } catch (error) {
          this.logger.debug(
            `Failed to cancel download from ${download.username}:`,
            error
          );
        }
      }

      this.logger.info(`Attempted to cancel ${downloads.length} downloads`);
    } catch (error) {
      this.logger.debug("Failed to cancel downloads:", error);
    }
  }

  // Méthode pour réinitialiser les caches (utile pour debug)
  resetDownloadTracking(): void {
    this.activeDownloads.clear();
    this.completedDownloads.clear();
    this.failedDownloads.clear();
    this.logger.info("🔄 Download tracking reset");
  }

  // Méthode pour obtenir les stats du cache
  getTrackingStats(): { active: number; completed: number; failed: number } {
    return {
      active: this.activeDownloads.size,
      completed: this.completedDownloads.size,
      failed: this.failedDownloads.size,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
