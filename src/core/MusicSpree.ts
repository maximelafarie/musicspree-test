import { Config } from "../config";
import { Logger } from "../utils";
import {
  BeetsService,
  LastFMService,
  NavidromeService,
  SlskdService,
} from "../services";
import { Track, NavidromeTrack, PlaylistSyncResult } from "../types";
import winston from "winston";

export class MusicSpree {
  private config: Config;
  private logger: winston.Logger;
  private _lastfmService: LastFMService;
  private _navidromeService: NavidromeService;
  private _slskdService: SlskdService;
  private _beetsService: BeetsService;

  constructor() {
    this.config = Config.getInstance();
    this.logger = Logger.getInstance();
    this._lastfmService = new LastFMService();
    this._navidromeService = new NavidromeService();
    this._slskdService = new SlskdService();
    this._beetsService = new BeetsService();
  }

  async validateConfig(): Promise<void> {
    this.logger.info("🔍 Validating configuration...");

    const validationErrors: string[] = [];

    // Test LastFM connection
    try {
      await this._lastfmService.testConnection();
      this.logger.debug("✅ LastFM connection OK");
    } catch (error) {
      const errorMsg = `LastFM connection failed: ${
        error instanceof Error ? error.message : error
      }`;
      validationErrors.push(errorMsg);
      this.logger.error(errorMsg);
    }

    // Test Navidrome connection
    try {
      await this._navidromeService.testConnection();
      this.logger.debug("✅ Navidrome connection OK");
    } catch (error) {
      const errorMsg = `Navidrome connection failed: ${
        error instanceof Error ? error.message : error
      }`;
      validationErrors.push(errorMsg);
      this.logger.error(errorMsg);
    }

    // Test Slskd connection
    try {
      await this._slskdService.testConnection();
      this.logger.debug("✅ Slskd connection OK");
    } catch (error) {
      const errorMsg = `Slskd connection failed: ${
        error instanceof Error ? error.message : error
      }`;
      validationErrors.push(errorMsg);
      this.logger.error(errorMsg);
    }

    // Test Beets connection (optional - warn but don't fail)
    try {
      await this._beetsService.testConnection();
      this.logger.debug("✅ Beets connection OK");
    } catch (error) {
      this.logger.warn(
        "⚠️ Beets connection failed (will continue without it):",
        error
      );
    }

    if (validationErrors.length > 0) {
      throw new Error(
        `Configuration validation failed:\n${validationErrors.join("\n")}`
      );
    }

    this.logger.info("✅ All critical services validated successfully");
  }

  async syncRecommendations(limit?: number): Promise<PlaylistSyncResult> {
    this.logger.info("🎵 Starting recommendation sync...");

    const result: PlaylistSyncResult = {
      totalRecommendations: 0,
      alreadyInLibrary: 0,
      newDownloads: 0,
      failedDownloads: 0,
      addedToPlaylist: 0,
      errors: [],
    };

    try {
      // 1. Get recommendations from LastFM
      this.logger.info("📡 Fetching LastFM recommendations...");
      const recommendations = await this._lastfmService.getRecommendations(
        limit || 50
      );
      result.totalRecommendations = recommendations.length;
      this.logger.info(`📋 Found ${recommendations.length} recommendations`);

      if (recommendations.length === 0) {
        this.logger.warn("No recommendations found from LastFM");
        return result;
      }

      // 2. Check existing tracks in Navidrome
      this.logger.info("🔍 Checking existing tracks in Navidrome...");
      const { existingTracks, missingTracks } =
        await this.categorizeTracksByAvailability(recommendations);
      result.alreadyInLibrary = existingTracks.length;

      this.logger.info(`📚 ${existingTracks.length} tracks already in library`);
      this.logger.info(
        `📥 ${missingTracks.length} tracks need to be downloaded`
      );

      if (this.config.dryRun) {
        this.logger.info(
          "🏃‍♂️ Dry run mode - would download:",
          missingTracks.map((t) => `${t.artist} - ${t.title}`)
        );
        return result;
      }

      // 3. Download missing tracks
      if (missingTracks.length > 0) {
        this.logger.info("⬇️ Starting downloads...");
        const downloadResults = await this.downloadTracks(missingTracks);
        result.newDownloads = downloadResults.successful.length;
        result.failedDownloads = downloadResults.failed.length;
        result.errors.push(...downloadResults.errors);

        this.logger.info(
          `✅ Downloaded: ${result.newDownloads}, Failed: ${result.failedDownloads}`
        );
      }

      // 4. Process with Beets if there were new downloads
      if (result.newDownloads > 0) {
        this.logger.info("🏷️ Processing new tracks with Beets...");
        try {
          await this._beetsService.importNewTracks();
          this.logger.info("✅ Beets processing completed");

          // Small delay to let Navidrome discover new files
          await this.sleep(5000);
        } catch (error) {
          this.logger.warn(
            "⚠️ Beets processing failed (continuing anyway):",
            error
          );
          result.errors.push(
            `Beets processing failed: ${
              error instanceof Error ? error.message : error
            }`
          );
        }
      }

      // 5. Create/update playlist
      this.logger.info("📝 Creating/updating playlist...");
      const playlistResult = await this.updatePlaylist(recommendations);
      result.addedToPlaylist = playlistResult.addedCount;

      if (playlistResult.errors.length > 0) {
        result.errors.push(...playlistResult.errors);
      }

      this.logger.info(
        `✅ Sync completed! Added ${result.addedToPlaylist} tracks to playlist "${this.config.playlistName}"`
      );
      return result;
    } catch (error) {
      this.logger.error("❌ Sync failed:", error);
      result.errors.push(
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  async dryRun(limit?: number): Promise<Track[]> {
    this.logger.info("🏃‍♂️ Running dry run...");

    try {
      const recommendations = await this._lastfmService.getRecommendations(
        limit || 50
      );

      if (recommendations.length === 0) {
        this.logger.info("No recommendations found from LastFM");
        return [];
      }

      const { missingTracks } = await this.categorizeTracksByAvailability(
        recommendations
      );

      this.logger.info(
        `Would download ${missingTracks.length} tracks:`,
        missingTracks.slice(0, 10).map((t) => `${t.artist} - ${t.title}`)
      );

      return missingTracks;
    } catch (error) {
      this.logger.error("❌ Dry run failed:", error);
      throw error;
    }
  }

  async clearPlaylist(): Promise<void> {
    this.logger.info("🗑️ Clearing playlist...");
    try {
      await this._navidromeService.deletePlaylist(this.config.playlistName);
      this.logger.info("✅ Playlist cleared");
    } catch (error) {
      this.logger.error("❌ Failed to clear playlist:", error);
      throw error;
    }
  }

  private async categorizeTracksByAvailability(
    tracks: Track[]
  ): Promise<{ existingTracks: NavidromeTrack[]; missingTracks: Track[] }> {
    const existingTracks: NavidromeTrack[] = [];
    const missingTracks: Track[] = [];

    this.logger.info(`Checking availability of ${tracks.length} tracks...`);

    // Process in chunks to avoid overwhelming Navidrome
    const chunkSize = 10;
    const chunks = this.chunkArray(tracks, chunkSize);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      this.logger.debug(
        `Processing chunk ${i + 1}/${chunks.length} (${chunk.length} tracks)`
      );

      const chunkPromises = chunk.map(async (track) => {
        try {
          const found = await this._navidromeService.searchTrack(
            track.artist,
            track.title
          );
          if (found) {
            existingTracks.push(found);
          } else {
            missingTracks.push(track);
          }
        } catch (error) {
          this.logger.debug(
            `Error checking track ${track.artist} - ${track.title}:`,
            error
          );
          // If we can't determine, assume it's missing and try to download
          missingTracks.push(track);
        }
      });

      await Promise.all(chunkPromises);

      // Small delay between chunks to be nice to Navidrome
      if (i < chunks.length - 1) {
        await this.sleep(1000);
      }
    }

    return { existingTracks, missingTracks };
  }

  private async downloadTracks(tracks: Track[]): Promise<{
    successful: Track[];
    failed: Track[];
    errors: string[];
  }> {
    const successful: Track[] = [];
    const failed: Track[] = [];
    const errors: string[] = [];

    if (tracks.length === 0) {
      return { successful, failed, errors };
    }

    this.logger.info(`Starting downloads for ${tracks.length} tracks...`);

    // Process downloads with concurrency limit
    const chunks = this.chunkArray(tracks, this.config.concurrentDownloads);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      this.logger.info(
        `Processing download chunk ${i + 1}/${chunks.length} (${
          chunk.length
        } tracks)`
      );

      const promises = chunk.map(async (track) => {
        try {
          this.logger.debug(
            `Attempting download: ${track.artist} - ${track.title}`
          );
          const success = await this._slskdService.downloadTrack(track);

          if (success) {
            successful.push(track);
            this.logger.info(`✅ Downloaded: ${track.artist} - ${track.title}`);
          } else {
            failed.push(track);
            const errorMsg = `Failed to download: ${track.artist} - ${track.title}`;
            errors.push(errorMsg);
            this.logger.warn(`❌ ${errorMsg}`);
          }
        } catch (error) {
          failed.push(track);
          const errorMsg = `Download error for ${track.artist} - ${
            track.title
          }: ${error instanceof Error ? error.message : error}`;
          errors.push(errorMsg);
          this.logger.error(`❌ ${errorMsg}`);
        }
      });

      await Promise.all(promises);

      // Progress logging
      const totalProcessed = (i + 1) * this.config.concurrentDownloads;
      const actualProcessed = Math.min(totalProcessed, tracks.length);
      this.logger.info(
        `Progress: ${actualProcessed}/${tracks.length} tracks processed`
      );

      // Small delay between chunks
      if (i < chunks.length - 1) {
        await this.sleep(2000);
      }
    }

    this.logger.info(
      `Download summary: ${successful.length} successful, ${failed.length} failed`
    );
    return { successful, failed, errors };
  }

  private async updatePlaylist(
    tracks: Track[]
  ): Promise<{ addedCount: number; errors: string[] }> {
    const errors: string[] = [];
    let addedCount = 0;

    try {
      // Clean existing playlist if configured
      if (this.config.cleanPlaylistsOnRefresh) {
        try {
          await this._navidromeService.deletePlaylist(this.config.playlistName);
          this.logger.debug(
            `Deleted existing playlist: ${this.config.playlistName}`
          );
        } catch (error) {
          this.logger.debug(
            "Playlist deletion failed (might not exist):",
            error
          );
        }
      }

      // Get all tracks that should be in the playlist
      const playlistTracks: NavidromeTrack[] = [];

      this.logger.info("Building playlist from available tracks...");

      // Process in chunks to avoid overwhelming Navidrome
      const chunks = this.chunkArray(tracks, 10);

      for (const chunk of chunks) {
        const chunkPromises = chunk.map(async (track) => {
          try {
            const found = await this._navidromeService.searchTrack(
              track.artist,
              track.title
            );
            if (found) {
              playlistTracks.push(found);
              this.logger.debug(
                `✅ Found in library: ${track.artist} - ${track.title}`
              );
            } else {
              this.logger.debug(
                `❌ Not found in library: ${track.artist} - ${track.title}`
              );
            }
          } catch (error) {
            const errorMsg = `Error searching for track ${track.artist} - ${track.title}: ${error}`;
            errors.push(errorMsg);
            this.logger.debug(errorMsg);
          }
        });

        await Promise.all(chunkPromises);
        await this.sleep(500); // Small delay between chunks
      }

      if (playlistTracks.length > 0) {
        try {
          await this._navidromeService.createOrUpdatePlaylist(
            this.config.playlistName,
            playlistTracks
          );
          addedCount = playlistTracks.length;
          this.logger.info(
            `📝 Playlist "${this.config.playlistName}" updated with ${addedCount} tracks`
          );
        } catch (error) {
          const errorMsg = `Failed to create/update playlist: ${
            error instanceof Error ? error.message : error
          }`;
          errors.push(errorMsg);
          this.logger.error(errorMsg);
        }
      } else {
        this.logger.warn("No tracks found to add to playlist");
      }
    } catch (error) {
      const errorMsg = `Playlist update failed: ${
        error instanceof Error ? error.message : error
      }`;
      errors.push(errorMsg);
      this.logger.error(errorMsg);
    }

    return { addedCount, errors };
  }

  private isSameTrack(track1: Track, track2: NavidromeTrack): boolean {
    const normalize = (str: string) =>
      str
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const artist1 = normalize(track1.artist);
    const title1 = normalize(track1.title);
    const artist2 = normalize(track2.artist);
    const title2 = normalize(track2.title);

    return artist1 === artist2 && title1 === title2;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Public getters for CLI access to services (for testing)
  public get lastfmService(): LastFMService {
    return this._lastfmService;
  }

  public get navidromeService(): NavidromeService {
    return this._navidromeService;
  }

  public get slskdService(): SlskdService {
    return this._slskdService;
  }

  public get beetsService(): BeetsService {
    return this._beetsService;
  }
}
