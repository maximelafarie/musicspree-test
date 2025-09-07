import { Config } from "../config/Config";
import { Logger } from "../utils/Logger";
import { LastFMService } from "../services/LastFMService";
import { NavidromeService } from "../services/NavidromeService";
import { SlskdService } from "../services/SlskdService";
import { BeetsService } from "../services/BeetsService";
import { Track, NavidromeTrack, PlaylistSyncResult } from "../types/Track";

export class MusicSpree {
  private config: Config;
  private logger: winston.Logger;
  private lastfmService: LastFMService;
  private navidromeService: NavidromeService;
  private slskdService: SlskdService;
  private beetsService: BeetsService;

  constructor() {
    this.config = Config.getInstance();
    this.logger = Logger.getInstance();
    this.lastfmService = new LastFMService();
    this.navidromeService = new NavidromeService();
    this.slskdService = new SlskdService();
    this.beetsService = new BeetsService();
  }

  async validateConfig(): Promise<void> {
    this.logger.info("🔍 Validating configuration...");

    // Test LastFM connection
    try {
      await this.lastfmService.testConnection();
      this.logger.info("✅ LastFM connection OK");
    } catch (error) {
      throw new Error(`LastFM connection failed: ${error}`);
    }

    // Test Navidrome connection
    try {
      await this.navidromeService.testConnection();
      this.logger.info("✅ Navidrome connection OK");
    } catch (error) {
      throw new Error(`Navidrome connection failed: ${error}`);
    }

    // Test Slskd connection
    try {
      await this.slskdService.testConnection();
      this.logger.info("✅ Slskd connection OK");
    } catch (error) {
      throw new Error(`Slskd connection failed: ${error}`);
    }

    // Test Beets connection (optional)
    try {
      await this.beetsService.testConnection();
      this.logger.info("✅ Beets connection OK");
    } catch (error) {
      this.logger.warn(
        "⚠️ Beets connection failed, will continue without it:",
        error
      );
    }
  }

  async syncRecommendations(): Promise<PlaylistSyncResult> {
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
      const recommendations = await this.lastfmService.getRecommendations();
      result.totalRecommendations = recommendations.length;
      this.logger.info(`📋 Found ${recommendations.length} recommendations`);

      // 2. Check existing tracks in Navidrome
      this.logger.info("🔍 Checking existing tracks in Navidrome...");
      const existingTracks = await this.checkExistingTracks(recommendations);
      result.alreadyInLibrary = existingTracks.length;

      // 3. Identify tracks to download
      const tracksToDownload = recommendations.filter(
        (track) =>
          !existingTracks.some((existing) => this.isSameTrack(track, existing))
      );

      this.logger.info(
        `📥 ${tracksToDownload.length} tracks need to be downloaded`
      );

      if (this.config.dryRun) {
        this.logger.info("🏃‍♂️ Dry run mode - would download:", tracksToDownload);
        return result;
      }

      // 4. Download missing tracks
      if (tracksToDownload.length > 0) {
        this.logger.info("⬇️ Starting downloads...");
        const downloadResults = await this.downloadTracks(tracksToDownload);
        result.newDownloads = downloadResults.successful.length;
        result.failedDownloads = downloadResults.failed.length;
        result.errors.push(...downloadResults.errors);
      }

      // 5. Process with Beets
      if (result.newDownloads > 0) {
        this.logger.info("🏷️ Processing new tracks with Beets...");
        await this.beetsService.importNewTracks();
      }

      // 6. Create/update playlist
      this.logger.info("📝 Creating/updating playlist...");
      await this.updatePlaylist(recommendations, result);

      this.logger.info(
        `✅ Sync completed! Added ${result.addedToPlaylist} tracks to playlist`
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

  async dryRun(): Promise<Track[]> {
    this.logger.info("🏃‍♂️ Running dry run...");

    const recommendations = await this.lastfmService.getRecommendations();
    const existingTracks = await this.checkExistingTracks(recommendations);

    const tracksToDownload = recommendations.filter(
      (track) =>
        !existingTracks.some((existing) => this.isSameTrack(track, existing))
    );

    this.logger.info(
      `Would download ${tracksToDownload.length} tracks:`,
      tracksToDownload
    );
    return tracksToDownload;
  }

  async clearPlaylist(): Promise<void> {
    this.logger.info("🗑️ Clearing playlist...");
    await this.navidromeService.deletePlaylist(this.config.playlistName);
    this.logger.info("✅ Playlist cleared");
  }

  private async checkExistingTracks(
    tracks: Track[]
  ): Promise<NavidromeTrack[]> {
    const existing: NavidromeTrack[] = [];

    for (const track of tracks) {
      try {
        const found = await this.navidromeService.searchTrack(
          track.artist,
          track.title
        );
        if (found) {
          existing.push(found);
        }
      } catch (error) {
        this.logger.debug(
          `Error checking track ${track.artist} - ${track.title}:`,
          error
        );
      }
    }

    return existing;
  }

  private async downloadTracks(tracks: Track[]): Promise<{
    successful: Track[];
    failed: Track[];
    errors: string[];
  }> {
    const successful: Track[] = [];
    const failed: Track[] = [];
    const errors: string[] = [];

    // Process downloads with concurrency limit
    const chunks = this.chunkArray(tracks, this.config.concurrentDownloads);

    for (const chunk of chunks) {
      const promises = chunk.map(async (track) => {
        try {
          const success = await this.slskdService.downloadTrack(track);
          if (success) {
            successful.push(track);
          } else {
            failed.push(track);
            errors.push(`Failed to download: ${track.artist} - ${track.title}`);
          }
        } catch (error) {
          failed.push(track);
          errors.push(
            `Download error for ${track.artist} - ${track.title}: ${error}`
          );
        }
      });

      await Promise.all(promises);
    }

    return { successful, failed, errors };
  }

  private async updatePlaylist(
    tracks: Track[],
    result: PlaylistSyncResult
  ): Promise<void> {
    // Clean existing playlist if configured
    if (this.config.cleanPlaylistsOnRefresh) {
      try {
        await this.navidromeService.deletePlaylist(this.config.playlistName);
      } catch (error) {
        this.logger.debug("Playlist deletion failed (might not exist):", error);
      }
    }

    // Get all tracks that should be in the playlist
    const playlistTracks: NavidromeTrack[] = [];

    for (const track of tracks) {
      try {
        const found = await this.navidromeService.searchTrack(
          track.artist,
          track.title
        );
        if (found) {
          playlistTracks.push(found);
        }
      } catch (error) {
        this.logger.debug(
          `Track not found in library: ${track.artist} - ${track.title}`
        );
      }
    }

    if (playlistTracks.length > 0) {
      await this.navidromeService.createOrUpdatePlaylist(
        this.config.playlistName,
        playlistTracks
      );
      result.addedToPlaylist = playlistTracks.length;
    }
  }

  private isSameTrack(track1: Track, track2: NavidromeTrack): boolean {
    const normalize = (str: string) =>
      str
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .trim();
    return (
      normalize(track1.artist) === normalize(track2.artist) &&
      normalize(track1.title) === normalize(track2.title)
    );
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
