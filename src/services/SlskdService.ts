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
    let searchId: string | null = null;

    while (retries < this.config.maxDownloadRetries) {
      try {
        this.logger.info(
          `⬇️ Attempting download: ${track.artist} - ${track.title} (attempt ${
            retries + 1
          })`
        );

        // Search for the track
        const { searchResults, searchId: currentSearchId } =
          await this.searchTrack(track);
        searchId = currentSearchId;

        if (!searchResults || searchResults.length === 0) {
          this.logger.warn(
            `No search results for: ${track.artist} - ${track.title}`
          );
          retries++;
          continue;
        }

        // Find the best match and download
        const bestMatch = this.selectBestMatch(searchResults, track);

        if (!bestMatch) {
          this.logger.warn(
            `No suitable match found for: ${track.artist} - ${track.title}`
          );
          retries++;
          continue;
        }

        const downloadSuccess = await this.initiateDownload(bestMatch);

        if (downloadSuccess) {
          // Wait for download to complete
          const completed = await this.waitForDownloadCompletion(bestMatch);

          if (completed) {
            this.logger.info(
              `✅ Successfully downloaded: ${track.artist} - ${track.title}`
            );
            return true;
          }
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
      } finally {
        // Clean up search regardless of success/failure
        if (searchId) {
          await this.cleanupSearch(searchId);
          searchId = null;
        }
      }

      if (retries < this.config.maxDownloadRetries) {
        await this.sleep(2000 * retries);
      }
    }

    this.logger.error(
      `❌ Failed to download after ${this.config.maxDownloadRetries} attempts: ${track.artist} - ${track.title}`
    );
    return false;
  }

  private async searchTrack(
    track: Track
  ): Promise<{ searchResults: any[]; searchId: string | null }> {
    try {
      const searchQuery = `${track.artist} ${track.title}`;
      this.logger.debug(`Searching for: "${searchQuery}"`);

      // Initiate search
      const searchResponse = await this.client.post("/api/v0/searches", {
        searchText: searchQuery,
        timeout: 15000,
      });

      this.logger.debug(
        `Search response:`,
        JSON.stringify(searchResponse.data, null, 2)
      );

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

      // Wait for search results with progressive checks
      let attempts = 0;
      const maxAttempts = 6; // 3 seconds * 6 = 18 seconds max wait

      while (attempts < maxAttempts) {
        await this.sleep(3000);
        attempts++;

        try {
          const resultsResponse = await this.client.get(
            `/api/v0/searches/${searchId}`
          );

          this.logger.debug(
            `Search results response (attempt ${attempts}):`,
            JSON.stringify(resultsResponse.data, null, 2)
          );

          // Check if search is complete
          if (resultsResponse.data?.state === "InProgress") {
            this.logger.debug(
              `Search still in progress (attempt ${attempts}/${maxAttempts})`
            );
            continue;
          }

          if (!resultsResponse.data?.responses) {
            if (attempts < maxAttempts) {
              this.logger.debug(
                `No responses yet (attempt ${attempts}/${maxAttempts})`
              );
              continue;
            }
            this.logger.debug(
              "No responses in search results after all attempts"
            );
            return { searchResults: [], searchId };
          }

          // Process results
          const allFiles: any[] = [];

          for (const response of resultsResponse.data.responses) {
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

          this.logger.debug(`Found ${allFiles.length} files in search results`);
          return { searchResults: allFiles, searchId };
        } catch (resultsError) {
          this.logger.debug(
            `Error getting search results (attempt ${attempts}):`,
            resultsError
          );
          if (attempts >= maxAttempts) {
            throw resultsError;
          }
        }
      }

      this.logger.warn(`Search timeout after ${maxAttempts} attempts`);
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
    if (searchResults.length === 0) return null;

    // Score each result
    const scoredResults = searchResults.map((file) => ({
      file,
      score: this.calculateMatchScore(file, track),
    }));

    // Sort by score (highest first)
    scoredResults.sort((a, b) => b.score - a.score);

    // Log top results for debugging
    this.logger.debug("Top 5 search results:");
    scoredResults.slice(0, 5).forEach((result, index) => {
      this.logger.debug(
        `${index + 1}. ${result.file.filename} (score: ${result.score.toFixed(
          2
        )}, bitrate: ${result.file.bitRate || "unknown"})`
      );
    });

    // Filter by minimum quality
    const qualityFiltered = scoredResults.filter(
      (result) =>
        result.score > 0.5 && // Minimum match score
        this.isAcceptableQuality(result.file)
    );

    if (qualityFiltered.length > 0) {
      this.logger.debug(`Selected: ${qualityFiltered[0].file.filename}`);
      return qualityFiltered[0].file;
    }

    // If no quality matches, try with lower score threshold
    const fallbackFiltered = scoredResults.filter(
      (result) => result.score > 0.3 && this.isAcceptableQuality(result.file)
    );

    if (fallbackFiltered.length > 0) {
      this.logger.debug(
        `Using fallback match: ${fallbackFiltered[0].file.filename}`
      );
      return fallbackFiltered[0].file;
    }

    this.logger.debug("No files passed quality filter");
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
    // Check file extension
    if (!file.filename?.match(/\.(mp3|flac|wav|m4a|ogg|aac)$/i)) {
      this.logger.debug(`Rejected file (bad extension): ${file.filename}`);
      return false;
    }

    // Check bitrate (if available)
    if (file.bitRate && file.bitRate < 128) {
      this.logger.debug(
        `Rejected file (low bitrate ${file.bitRate}): ${file.filename}`
      );
      return false;
    }

    // Check file size (avoid extremely small files)
    if (file.size && file.size < 1024 * 1024) {
      // Less than 1MB
      this.logger.debug(
        `Rejected file (too small ${file.size} bytes): ${file.filename}`
      );
      return false;
    }

    return true;
  }

  private async initiateDownload(file: any): Promise<boolean> {
    try {
      const downloadRequest = {
        username: file.username,
        files: [
          {
            filename: file.filename,
            size: file.size || 0,
          },
        ],
      };

      this.logger.debug(`Initiating download for user ${file.username}:`);
      this.logger.debug(`- File: ${file.filename}`);
      this.logger.debug(`- Size: ${file.size || "unknown"} bytes`);
      this.logger.debug(
        `- Full request:`,
        JSON.stringify(downloadRequest, null, 2)
      );

      const response = await this.client.post(
        "/api/v0/transfers/downloads",
        downloadRequest
      );

      this.logger.debug(`Download initiation response:`, {
        status: response.status,
        statusText: response.statusText,
        data: response.data,
      });

      const success =
        response.status === 200 ||
        response.status === 201 ||
        response.status === 204;

      if (success) {
        this.logger.info(`✅ Download request sent successfully`);
        // Give slskd a moment to process the request
        await this.sleep(1000);
      } else {
        this.logger.warn(
          `Download initiation returned unexpected status: ${response.status}`
        );
      }

      return success;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error("Failed to initiate download (Axios Error):");
        this.logger.error(`- Status: ${error.response?.status}`);
        this.logger.error(
          `- Response: ${JSON.stringify(error.response?.data)}`
        );
      } else {
        this.logger.error("Failed to initiate download:", error);
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
