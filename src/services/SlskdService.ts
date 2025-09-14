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
      // Ajout de la validation des certificats SSL pour le debugging
      validateStatus: (status) => status < 500, // Accepter tous les codes < 500
    });

    // Log de la configuration pour debugging
    this.logger.debug(`SlskdService initialized with URL: ${this.config.slskdUrl}`);
    this.logger.debug(`API Key configured: ${this.config.slskdApiKey ? 'Yes' : 'No'}`);
  }

  async testConnection(): Promise<void> {
    try {
      this.logger.debug(`Testing connection to: ${this.config.slskdUrl}/api/v0/session`);
      
      const response = await this.client.get("/api/v0/session");

      this.logger.debug(`Response status: ${response.status}`);
      this.logger.debug(`Response headers:`, response.headers);
      this.logger.debug(`Response data:`, JSON.stringify(response.data, null, 2));

      // Vérification plus flexible de la réponse
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Vérifier si la réponse contient des données (même si c'est juste un objet vide)
      if (response.data === undefined || response.data === null) {
        throw new Error("Empty response from slskd");
      }

      this.logger.info("✅ Slskd connection test successful");
      this.logger.debug(`Connected to slskd version: ${response.data.version || 'unknown'}`);
      
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        this.logger.error("Slskd connection test failed (Axios Error):");
        this.logger.error(`- URL: ${axiosError.config?.url}`);
        this.logger.error(`- Method: ${axiosError.config?.method}`);
        this.logger.error(`- Status: ${axiosError.response?.status}`);
        this.logger.error(`- Status Text: ${axiosError.response?.statusText}`);
        this.logger.error(`- Response Data:`, axiosError.response?.data);
        this.logger.error(`- Request Headers:`, axiosError.config?.headers);
        
        if (axiosError.code) {
          this.logger.error(`- Error Code: ${axiosError.code}`);
        }
        
        if (axiosError.message) {
          this.logger.error(`- Error Message: ${axiosError.message}`);
        }

        // Erreurs réseau communes
        if (axiosError.code === 'ECONNREFUSED') {
          throw new Error(`Connection refused to ${this.config.slskdUrl}. Is slskd running and accessible?`);
        } else if (axiosError.code === 'ENOTFOUND') {
          throw new Error(`Host not found: ${this.config.slskdUrl}. Check the URL.`);
        } else if (axiosError.code === 'ETIMEDOUT') {
          throw new Error(`Connection timeout to ${this.config.slskdUrl}. Check network connectivity.`);
        } else if (axiosError.response?.status === 401) {
          throw new Error(`Unauthorized access to slskd. Check your API key.`);
        } else if (axiosError.response?.status === 403) {
          throw new Error(`Forbidden access to slskd. Check API key permissions.`);
        } else if (axiosError.response?.status === 404) {
          throw new Error(`Endpoint not found. Check slskd version and API compatibility.`);
        }
      } else {
        this.logger.error("Slskd connection test failed (General Error):", error);
      }
      
      throw error;
    }
  }

  async getApiInfo(): Promise<any> {
    try {
      // Essayer d'obtenir des informations sur l'API
      const response = await this.client.get("/api/v0/");
      return response.data;
    } catch (error) {
      this.logger.debug("Could not get API info:", error);
      return null;
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
      this.logger.debug(`Searching for: "${searchQuery}"`);

      const response = await this.client.post("/api/v0/searches", {
        searchText: searchQuery,
        timeout: 15000,
      });

      if (!response.data?.id) {
        throw new Error("No search ID returned");
      }

      const searchId = response.data.id;
      this.logger.debug(`Search initiated with ID: ${searchId}`);

      // Wait for search results
      await this.sleep(3000);

      const resultsResponse = await this.client.get(
        `/api/v0/searches/${searchId}`
      );

      if (!resultsResponse.data?.responses) {
        this.logger.debug("No responses in search results");
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

      this.logger.debug(`Found ${allFiles.length} files in search results`);
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

    // Log top results for debugging
    this.logger.debug("Top 3 search results:");
    scoredResults.slice(0, 3).forEach((result, index) => {
      this.logger.debug(
        `${index + 1}. ${result.file.filename} (score: ${result.score.toFixed(2)})`
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

    this.logger.debug("No files passed quality filter");
    return null;
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

      this.logger.debug(`Initiating download:`, downloadRequest);

      const response = await this.client.post(
        "/api/v0/transfers/downloads",
        downloadRequest
      );

      const success = response.status === 200 || response.status === 201;
      this.logger.debug(`Download initiation ${success ? 'successful' : 'failed'}`);
      
      return success;
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

    this.logger.debug(`Waiting for download completion (max ${maxWaitMinutes || this.config.downloadTimeoutMinutes} minutes)`);

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
            this.logger.debug(`Download state: ${download.state}`);
            
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