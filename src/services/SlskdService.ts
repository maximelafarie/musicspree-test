import axios, { AxiosInstance } from "axios";
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
    });
  }

  async testConnection(): Promise<void> {
    try {
      const response = await this.client.get("/api/v0/session");

      if (!response.data || response.status !== 200) {
        throw new Error("Invalid response from slskd");
      }

      this.logger.debug("Slskd connection test successful");
    } catch (error) {
      this.logger.error("Slskd connection test failed:", error);
      throw error;
    }
  }

  async downloadTrack(track: Track): Promise<boolean> {
    let retries = 0;

    while (retries < this.config.maxDownloadRetries) {
      try {
        this.logger.info(
          `⬇️ Attempting download: ${track.artist} - ${track.title} (attempt ${
            retries + 1
          })`
        );

        // Search for the track
        const searchResults = await this.searchTrack(track);

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
      }

      if (retries < this.config.maxDownloadRetries) {
        // Wait before retry
        await this.sleep(2000 * retries);
      }
    }

    this.logger.error(
      `❌ Failed to download after ${this.config.maxDownloadRetries} attempts: ${track.artist} - ${track.title}`
    );
    return false;
  }

  private async searchTrack(track: Track): Promise<any[]> {
    try {
      const searchQuery = `${track.artist} ${track.title}`;

      const response = await this.client.post("/api/v0/searches", {
        searchText: searchQuery,
        timeout: 15000,
      });

      if (!response.data?.id) {
        throw new Error("No search ID returned");
      }

      const searchId = response.data.id;

      // Wait for search results
      await this.sleep(3000);

      const resultsResponse = await this.client.get(
        `/api/v0/searches/${searchId}`
      );

      if (!resultsResponse.data?.responses) {
        return [];
      }

      // Flatten all files from all responses
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

      return allFiles;
    } catch (error) {
      this.logger.error(
        `Search failed for ${track.artist} - ${track.title}:`,
        error
      );
      return [];
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

    // Filter by minimum quality
    const qualityFiltered = scoredResults.filter(
      (result) =>
        result.score > 0.5 && // Minimum match score
        this.isAcceptableQuality(result.file)
    );

    return qualityFiltered.length > 0 ? qualityFiltered[0].file : null;
  }

  private calculateMatchScore(file: any, track: Track): number {
    const normalize = (str: string) =>
      str
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .trim();

    const fileName = normalize(file.filename || "");
    const searchArtist = normalize(track.artist);
    const searchTitle = normalize(track.title);

    let score = 0;

    // Artist match
    if (fileName.includes(searchArtist)) {
      score += 0.4;
    }

    // Title match
    if (fileName.includes(searchTitle)) {
      score += 0.4;
    }

    // File type bonus
    if (file.filename?.match(/\.(flac|wav)$/i)) {
      score += 0.1;
    } else if (file.filename?.match(/\.mp3$/i)) {
      score += 0.05;
    }

    // Bitrate bonus
    if (file.bitRate && file.bitRate >= 320) {
      score += 0.05;
    }

    return Math.min(score, 1.0);
  }

  private isAcceptableQuality(file: any): boolean {
    // Check file extension
    if (!file.filename?.match(/\.(mp3|flac|wav|m4a|ogg)$/i)) {
      return false;
    }

    // Check bitrate (if available)
    if (file.bitRate && file.bitRate < 128) {
      return false;
    }

    // Check file size (avoid extremely small files)
    if (file.size && file.size < 1024 * 1024) {
      // Less than 1MB
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
            size: file.size,
          },
        ],
      };

      const response = await this.client.post(
        "/api/v0/transfers/downloads",
        downloadRequest
      );

      return response.status === 200 || response.status === 201;
    } catch (error) {
      this.logger.error("Failed to initiate download:", error);
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
    const checkInterval = 5000; // Check every 5 seconds

    while (Date.now() - startTime < maxWait) {
      try {
        const response = await this.client.get("/api/v0/transfers/downloads");

        if (!response.data) {
          continue;
        }

        // Look for our download
        const downloads = Array.isArray(response.data)
          ? response.data
          : [response.data];

        for (const download of downloads) {
          if (
            download.username === file.username &&
            download.files?.some((f: any) => f.filename === file.filename)
          ) {
            if (download.state === "Completed") {
              return true;
            } else if (
              download.state === "Cancelled" ||
              download.state === "Failed"
            ) {
              this.logger.warn(`Download failed with state: ${download.state}`);
              return false;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
