import axios, { AxiosInstance, AxiosError } from "axios";
import { Config } from "../config/Config";
import { Logger } from "../utils/Logger";
import { Track } from "../types/Track";
import winston from "winston";

export class SlskdService {
  private config: Config;
  private logger: winston.Logger;
  private client: AxiosInstance;

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
    let retries = 0;
    const searchIds: string[] = []; // Garder trace de toutes les recherches créées

    while (retries < this.config.maxDownloadRetries) {
      let currentSearchId: string | null = null;

      try {
        this.logger.info(
          `⬇️ Attempting download: ${track.artist} - ${track.title} (attempt ${
            retries + 1
          })`
        );

        // Search for the track
        const { searchResults, searchId } = await this.searchTrack(track);
        currentSearchId = searchId;

        if (currentSearchId) {
          searchIds.push(currentSearchId); // Ajouter à la liste pour cleanup final
        }

        if (!searchResults || searchResults.length === 0) {
          this.logger.warn(
            `No search results for: ${track.artist} - ${track.title}`
          );
          retries++;
          continue;
        }

        // Find the best match and download
        this.logger.info(
          `🔍 Processing ${searchResults.length} search results for matching...`
        );
        const bestMatch = this.selectBestMatch(searchResults, track);

        if (!bestMatch) {
          this.logger.warn(
            `❌ No suitable match found for: ${track.artist} - ${track.title}`
          );
          this.logger.warn(`Available results were:`);
          searchResults.slice(0, 5).forEach((file, index) => {
            this.logger.warn(
              `  ${index + 1}. ${file.filename} (user: ${file.username})`
            );
          });
          retries++;
          continue;
        }

        this.logger.info(
          `✅ Selected best match: ${bestMatch.filename} from user ${bestMatch.username}`
        );
        this.logger.info(`📥 Initiating download...`);

        const downloadSuccess = await this.initiateDownload(bestMatch);

        if (downloadSuccess) {
          this.logger.info(
            "✅ Download initiated successfully, waiting for completion..."
          );

          // ✅ CORRECTION : Ne PAS supprimer la recherche avant la fin du téléchargement
          // Attendre que le téléchargement se termine AVANT de nettoyer
          const completed = await this.waitForDownloadCompletion(bestMatch);

          if (completed) {
            this.logger.info(
              `🎉 Successfully downloaded: ${track.artist} - ${track.title}`
            );

            // Nettoyer SEULEMENT après le succès du téléchargement
            await this.cleanupAllSearches(searchIds);
            return true;
          } else {
            this.logger.warn("❌ Download did not complete successfully");
          }
        } else {
          this.logger.error(
            "❌ Failed to initiate download - no download request was sent"
          );
        }

        retries++;
      } catch (error) {
        this.logger.error(
          `Download attempt ${retries + 1} failed for ${track.artist} - ${
            track.title
          }:`,
          error
        );
        retries++;
      }

      if (retries < this.config.maxDownloadRetries) {
        await this.sleep(2000 * retries);
      }
    }

    // Nettoyer toutes les recherches créées en cas d'échec final
    await this.cleanupAllSearches(searchIds);

    this.logger.error(
      `❌ Failed to download after ${this.config.maxDownloadRetries} attempts: ${track.artist} - ${track.title}`
    );
    return false;
  }

  private async cleanupAllSearches(searchIds: string[]): Promise<void> {
    for (const searchId of searchIds) {
      await this.cleanupSearch(searchId);
    }
  }

  private async searchTrack(
    track: Track
  ): Promise<{ searchResults: any[]; searchId: string | null }> {
    try {
      const searchQuery = `${track.artist} ${track.title}`;
      this.logger.info(`🔍 Searching for: "${searchQuery}"`);

      // Initiate search with longer timeout for slskd network discovery
      this.logger.info(`📡 Sending search request to slskd...`);
      const searchResponse = await this.client.post("/api/v0/searches", {
        searchText: searchQuery,
        timeout: 45000, // Augmenté à 45 secondes pour laisser le temps au réseau P2P
      });

      this.logger.info(`📡 Search initiation response:`);
      this.logger.info(`  Status: ${searchResponse.status}`);
      this.logger.info(`  Status Text: ${searchResponse.statusText}`);
      this.logger.info(`  Response type: ${typeof searchResponse.data}`);
      this.logger.info(`  Response data:`, searchResponse.data);

      // Vérifier si on a les données de base
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
        this.logger.error(
          "Unexpected search response format:",
          searchResponse.data
        );
        throw new Error("No search ID returned - unexpected response format");
      }

      this.logger.debug(`Search initiated with ID: ${searchId}`);

      // Wait for search results with progressive checks - longer timeout for P2P network
      let attempts = 0;
      const maxAttempts = 12; // 5 seconds * 12 = 60 seconds max wait (pour le réseau P2P)

      while (attempts < maxAttempts) {
        await this.sleep(5000); // Attendre 5 secondes entre chaque vérification
        attempts++;

        this.logger.debug(
          `Checking search results (attempt ${attempts}/${maxAttempts})...`
        );

        try {
          // Vérifier d'abord le statut de la recherche
          const statusResponse = await this.client.get(
            `/api/v0/searches/${searchId}`
          );

          this.logger.info(
            `🔍 Search status check (attempt ${attempts}/${maxAttempts}):`
          );
          this.logger.info(`  Status: ${statusResponse.status}`);
          this.logger.info(
            `  Search state: ${statusResponse.data?.state || "unknown"}`
          );
          this.logger.info(
            `  Is complete: ${statusResponse.data?.isComplete || false}`
          );
          this.logger.info(
            `  Response count: ${statusResponse.data?.responseCount || 0}`
          );

          // Check if search is still in progress
          if (statusResponse.data?.state === "InProgress") {
            this.logger.info(
              `⏳ Search still in progress (attempt ${attempts}/${maxAttempts})`
            );
            continue;
          }

          if (!statusResponse.data?.isComplete) {
            if (attempts < maxAttempts) {
              this.logger.info(
                `⏳ Search not complete yet (attempt ${attempts}/${maxAttempts}), continuing...`
              );
              continue;
            }
            this.logger.warn(`❌ Search did not complete after all attempts`);
            return { searchResults: [], searchId };
          }

          // Maintenant récupérer les vraies réponses avec l'endpoint correct
          this.logger.info(`📡 Fetching actual search responses...`);
          const responsesResponse = await this.client.get(
            `/api/v0/searches/${searchId}/responses`
          );

          this.logger.info(`📊 Responses endpoint result:`);
          this.logger.info(`  Status: ${responsesResponse.status}`);
          this.logger.info(
            `  Response count: ${
              Array.isArray(responsesResponse.data)
                ? responsesResponse.data.length
                : 0
            }`
          );

          if (
            !responsesResponse.data ||
            !Array.isArray(responsesResponse.data)
          ) {
            this.logger.warn(
              `❌ No valid responses data from /responses endpoint`
            );
            return { searchResults: [], searchId };
          }

          // Process results from the /responses endpoint
          const allFiles: any[] = [];

          this.logger.info(
            `🔄 Processing ${responsesResponse.data.length} user responses...`
          );

          for (const response of responsesResponse.data) {
            this.logger.info(
              `👤 Processing response from user: ${
                response.username || "unknown"
              }`
            );
            this.logger.info(
              `  Files in response: ${
                response.files ? response.files.length : 0
              }`
            );
            this.logger.info(
              `  Has free upload slot: ${response.hasFreeUploadSlot}`
            );
            this.logger.info(`  Queue length: ${response.queueLength || 0}`);

            if (response.files && Array.isArray(response.files)) {
              for (const file of response.files) {
                allFiles.push({
                  ...file,
                  username: response.username,
                  response: response,
                });
                this.logger.debug(
                  `  📁 Added file: ${file.filename || "unknown"} (${Math.round(
                    (file.size || 0) / (1024 * 1024)
                  )}MB, ${file.bitRate || "unknown"} kbps)`
                );
              }
            } else {
              this.logger.warn(
                `  ❌ No files array in response from ${response.username}`
              );
            }
          }

          this.logger.info(
            `✅ Found ${allFiles.length} total files in search results`
          );
          return { searchResults: allFiles, searchId };
        } catch (resultsError) {
          this.logger.error(
            `❌ Error getting search results (attempt ${attempts}/${maxAttempts}):`,
            resultsError
          );
          this.logger.error(`Error details:`, {
            message:
              resultsError instanceof Error
                ? resultsError.message
                : "Unknown error",
            status: axios.isAxiosError(resultsError)
              ? resultsError.response?.status
              : "N/A",
            data: axios.isAxiosError(resultsError)
              ? resultsError.response?.data
              : "N/A",
          });

          if (attempts >= maxAttempts) {
            this.logger.error(
              `❌ Max attempts reached, giving up on search results`
            );
            throw resultsError;
          }
        }
      }

      this.logger.warn(
        `⏰ Search timeout after ${
          maxAttempts * 5
        } seconds (${maxAttempts} attempts)`
      );
      this.logger.warn(
        `❌ Search ID ${searchId} did not return results in time`
      );
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
      this.logger.debug(`Cleaning up search: ${searchId}`);

      const response = await this.client.delete(`/api/v0/searches/${searchId}`);

      if (response.status >= 200 && response.status < 300) {
        this.logger.debug(`Search ${searchId} cleaned up successfully`);
      } else {
        this.logger.debug(`Search cleanup returned status ${response.status}`);
      }
    } catch (error) {
      // Don't fail the main operation if cleanup fails
      this.logger.debug(`Failed to cleanup search ${searchId}:`, error);
    }
  }

  private selectBestMatch(searchResults: any[], track: Track): any | null {
    if (searchResults.length === 0) {
      this.logger.warn("❌ No search results to process");
      return null;
    }

    this.logger.info(
      `🎯 Analyzing ${searchResults.length} search results for best match...`
    );

    // Score each result
    const scoredResults = searchResults.map((file) => ({
      file,
      score: this.calculateMatchScore(file, track),
    }));

    // Sort by score (highest first)
    scoredResults.sort((a, b) => b.score - a.score);

    // Log top results for debugging
    this.logger.info("📊 Top 5 search results:");
    scoredResults.slice(0, 5).forEach((result, index) => {
      this.logger.info(
        `  ${index + 1}. ${result.file.filename} (score: ${result.score.toFixed(
          2
        )}, bitrate: ${result.file.bitRate || "unknown"}, user: ${
          result.file.username
        })`
      );
    });

    // Filter by minimum quality
    const qualityFiltered = scoredResults.filter(
      (result) =>
        result.score > 0.5 && // Minimum match score
        this.isAcceptableQuality(result.file)
    );

    this.logger.info(
      `✅ ${qualityFiltered.length} files passed quality filter (score > 0.5)`
    );

    if (qualityFiltered.length > 0) {
      this.logger.info(
        `🎯 Selected: ${qualityFiltered[0].file.filename} from ${qualityFiltered[0].file.username}`
      );
      return qualityFiltered[0].file;
    }

    // If no quality matches, try with lower score threshold
    const fallbackFiltered = scoredResults.filter(
      (result) => result.score > 0.3 && this.isAcceptableQuality(result.file)
    );

    this.logger.info(
      `⚠️ Using fallback filter (score > 0.3): ${fallbackFiltered.length} files`
    );

    if (fallbackFiltered.length > 0) {
      this.logger.info(
        `🎯 Using fallback match: ${fallbackFiltered[0].file.filename} from ${fallbackFiltered[0].file.username}`
      );
      return fallbackFiltered[0].file;
    }

    this.logger.warn("❌ No files passed quality filter - all files rejected");
    // Log why files were rejected
    scoredResults.slice(0, 3).forEach((result, index) => {
      const qualityReason = this.isAcceptableQuality(result.file)
        ? "QUALITY OK"
        : "QUALITY REJECTED";
      const scoreReason = result.score > 0.3 ? "SCORE OK" : "SCORE TOO LOW";
      this.logger.warn(
        `  ${index + 1}. ${
          result.file.filename
        }: ${qualityReason}, ${scoreReason} (${result.score.toFixed(2)})`
      );
    });

    return null;
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

    // Exact artist match
    if (fileName.includes(searchArtist)) {
      score += 0.4;
    }

    // Exact title match
    if (fileName.includes(searchTitle)) {
      score += 0.4;
    }

    // Partial matches
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

    // Quality bonuses
    if (file.filename?.match(/\.(flac|wav)$/i)) {
      score += 0.1;
    } else if (file.filename?.match(/\.mp3$/i)) {
      score += 0.05;
    }

    if (file.bitRate) {
      if (file.bitRate >= 320) score += 0.05;
      else if (file.bitRate >= 256) score += 0.03;
      else if (file.bitRate >= 192) score += 0.01;
    }

    return Math.min(score, 1.0);
  }

  private isAcceptableQuality(file: any): boolean {
    const reasons: string[] = [];

    // Check file extension
    if (!file.filename?.match(/\.(mp3|flac|wav|m4a|ogg|aac)$/i)) {
      reasons.push(`bad extension: ${file.filename?.split(".").pop()}`);
      this.logger.debug(`❌ Rejected file (bad extension): ${file.filename}`);
      return false;
    } else {
      reasons.push("extension OK");
    }

    // Check bitrate (if available)
    if (file.bitRate && file.bitRate < 128) {
      reasons.push(`bitrate too low: ${file.bitRate}`);
      this.logger.debug(
        `❌ Rejected file (low bitrate ${file.bitRate}): ${file.filename}`
      );
      return false;
    } else if (file.bitRate) {
      reasons.push(`bitrate OK: ${file.bitRate}`);
    } else {
      reasons.push("bitrate unknown");
    }

    // Check file size (avoid extremely small files)
    if (file.size && file.size < 1024 * 1024) {
      // Less than 1MB
      reasons.push(`size too small: ${Math.round(file.size / 1024)}KB`);
      this.logger.debug(
        `❌ Rejected file (too small ${file.size} bytes): ${file.filename}`
      );
      return false;
    } else if (file.size) {
      reasons.push(`size OK: ${Math.round(file.size / (1024 * 1024))}MB`);
    } else {
      reasons.push("size unknown");
    }

    this.logger.debug(
      `✅ File quality acceptable: ${file.filename} (${reasons.join(", ")})`
    );
    return true;
  }

  private async initiateDownload(file: any): Promise<boolean> {
    try {
      // Vérifier que nous avons les informations nécessaires
      if (!file.username) {
        this.logger.error("❌ Cannot initiate download: missing username");
        return false;
      }

      if (!file.filename) {
        this.logger.error("❌ Cannot initiate download: missing filename");
        return false;
      }

      // Format correct pour l'API slskd : array de fichiers directement
      const downloadRequest = [
        {
          filename: file.filename,
          size: file.size || 0,
        },
      ];

      this.logger.info(`🚀 Initiating download from user: ${file.username}`);
      this.logger.info(`  📁 File: ${file.filename}`);
      this.logger.info(
        `  📏 Size: ${
          file.size ? Math.round(file.size / (1024 * 1024)) + "MB" : "unknown"
        }`
      );
      this.logger.debug(
        `📋 Request payload:`,
        JSON.stringify(downloadRequest, null, 2)
      );

      // URL correcte avec username dans le path
      const downloadUrl = `/api/v0/transfers/downloads/${encodeURIComponent(
        file.username
      )}`;
      this.logger.info(`📡 Request URL: ${downloadUrl}`);

      const response = await this.client.post(downloadUrl, downloadRequest);

      this.logger.info(`📡 Download API Response:`, {
        status: response.status,
        statusText: response.statusText,
        data: response.data,
      });

      const success =
        response.status === 200 ||
        response.status === 201 ||
        response.status === 204;

      if (success) {
        this.logger.info(
          `✅ Download request accepted by slskd (HTTP ${response.status})`
        );
        this.logger.info(
          `⏱️ Waiting 3 seconds for slskd to process the request...`
        );
        // Donner plus de temps à slskd pour traiter la demande
        await this.sleep(3000);

        // Vérifier immédiatement si le téléchargement apparaît dans la queue
        const downloads = await this.getActiveDownloads();
        this.logger.info(
          `🔍 Active downloads after request: ${downloads.length}`
        );
        downloads.forEach((download, index) => {
          this.logger.info(
            `  ${index + 1}. ${download.username} - ${download.state} - ${
              download.files?.length || 0
            } files`
          );
        });
      } else {
        this.logger.error(
          `❌ Download request rejected by slskd: HTTP ${response.status} - ${response.statusText}`
        );
        this.logger.error(`Response body:`, response.data);
      }

      return success;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error("❌ Failed to initiate download (Axios Error):");
        this.logger.error(`  🌐 URL: ${error.config?.url}`);
        this.logger.error(`  📊 Status: ${error.response?.status}`);
        this.logger.error(
          `  📄 Response: ${JSON.stringify(error.response?.data)}`
        );
        this.logger.error(
          `  🔧 Request payload: ${JSON.stringify(error.config?.data)}`
        );

        // Log plus de détails sur l'erreur
        if (error.response?.status === 400) {
          this.logger.error("❌ Bad Request - check request format");
        } else if (error.response?.status === 404) {
          this.logger.error("❌ User not found or endpoint incorrect");
        } else if (error.response?.status === 401) {
          this.logger.error("❌ Unauthorized - check API key");
        }
      } else {
        this.logger.error(
          "❌ Failed to initiate download (Unknown Error):",
          error
        );
      }
      return false;
    }
  }

  private async waitForDownloadCompletion(
    file: any,
    maxWaitMinutes?: number
  ): Promise<boolean> {
    const maxWait =
      (maxWaitMinutes || this.config.downloadTimeoutMinutes) * 60 * 1000;
    const startTime = Date.now();
    const checkInterval = 10000; // Check every 10 seconds

    this.logger.debug(
      `Waiting for download completion (max ${
        maxWaitMinutes || this.config.downloadTimeoutMinutes
      } minutes)`
    );

    let lastDownloadCount = -1;
    let downloadFound = false;

    while (Date.now() - startTime < maxWait) {
      try {
        const response = await this.client.get("/api/v0/transfers/downloads");

        if (!response.data) {
          await this.sleep(checkInterval);
          continue;
        }

        // Handle both array and object responses
        const downloads = Array.isArray(response.data)
          ? response.data
          : [response.data];

        // Log download status periodically
        if (downloads.length !== lastDownloadCount) {
          this.logger.debug(`Currently tracking ${downloads.length} downloads`);
          lastDownloadCount = downloads.length;

          downloads.forEach((download, index) => {
            this.logger.debug(
              `Download ${index + 1}: ${download.username} - State: ${
                download.state
              }`
            );
            if (download.files) {
              download.files.forEach((f: any, fIndex: number) => {
                this.logger.debug(
                  `  File ${fIndex + 1}: ${f.filename} (${
                    f.state || "unknown state"
                  })`
                );
              });
            }
          });
        }

        // Look for our specific download
        for (const download of downloads) {
          if (download.username === file.username) {
            // Check if any of the files in this download match our file
            if (
              download.files?.some((f: any) => f.filename === file.filename)
            ) {
              downloadFound = true;
              const matchingFile = download.files.find(
                (f: any) => f.filename === file.filename
              );

              this.logger.debug(`Found matching download: ${download.state}`);

              if (matchingFile) {
                this.logger.debug(
                  `File state: ${matchingFile.state || "unknown"}`
                );
              }

              if (
                download.state === "Completed" ||
                download.state === "Succeeded"
              ) {
                this.logger.info(`✅ Download completed successfully`);
                return true;
              } else if (
                download.state === "Cancelled" ||
                download.state === "Failed" ||
                download.state === "TimedOut"
              ) {
                this.logger.warn(
                  `Download failed with state: ${download.state}`
                );
                return false;
              }

              // Log progress if available
              if (
                matchingFile &&
                matchingFile.bytesTransferred &&
                matchingFile.size
              ) {
                const progress = (
                  (matchingFile.bytesTransferred / matchingFile.size) *
                  100
                ).toFixed(1);
                this.logger.debug(
                  `Download progress: ${progress}% (${matchingFile.bytesTransferred}/${matchingFile.size})`
                );
              }
            }
          }
        }

        // Si aucun téléchargement n'a été trouvé après 30 secondes, c'est probablement un échec
        if (!downloadFound && Date.now() - startTime > 30000) {
          this.logger.warn(
            "No matching download found after 30 seconds - download may have failed to start"
          );
          return false;
        }
      } catch (error) {
        this.logger.debug("Error checking download status:", error);
      }

      await this.sleep(checkInterval);
    }

    this.logger.warn(
      `Download timeout after ${
        maxWaitMinutes || this.config.downloadTimeoutMinutes
      } minutes`
    );
    return false;
  }

  async getActiveDownloads(): Promise<any[]> {
    try {
      const response = await this.client.get("/api/v0/transfers/downloads");
      return Array.isArray(response.data) ? response.data : [response.data];
    } catch (error) {
      this.logger.debug("Failed to get active downloads:", error);
      return [];
    }
  }

  async clearAllSearches(): Promise<void> {
    try {
      this.logger.info("🧹 Clearing all searches...");

      const searchesResponse = await this.client.get("/api/v0/searches");

      if (searchesResponse.data && Array.isArray(searchesResponse.data)) {
        for (const search of searchesResponse.data) {
          if (search.id) {
            await this.cleanupSearch(search.id);
          }
        }
        this.logger.info(`Cleaned up ${searchesResponse.data.length} searches`);
      }
    } catch (error) {
      this.logger.debug("Failed to clear all searches:", error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
