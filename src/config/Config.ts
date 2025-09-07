export class Config {
  private static instance: Config;

  // LastFM Configuration
  public readonly lastfmApiKey: string;
  public readonly lastfmUsername: string;
  public readonly lastfmSharedSecret: string;

  // Navidrome Configuration
  public readonly navidromeUrl: string;
  public readonly navidromeUsername: string;
  public readonly navidromePassword: string;

  // Soulseek Configuration
  public readonly slskdUrl: string;
  public readonly slskdApiKey: string;

  // Beets Configuration
  public readonly beetsUrl: string;
  public readonly beetsConfigPath: string;

  // Cron Configuration
  public readonly cronSchedule: string;

  // Playlist Configuration
  public readonly playlistName: string;
  public readonly cleanPlaylistsOnRefresh: boolean;
  public readonly keepDownloadedTracks: boolean;

  // Download Configuration
  public readonly maxDownloadRetries: number;
  public readonly downloadTimeoutMinutes: number;
  public readonly concurrentDownloads: number;

  // Logging
  public readonly logLevel: string;
  public readonly logToFile: boolean;

  // Other
  public readonly dryRun: boolean;

  private constructor() {
    // LastFM
    this.lastfmApiKey = this.getEnvVar("LASTFM_API_KEY");
    this.lastfmUsername = this.getEnvVar("LASTFM_USERNAME");
    this.lastfmSharedSecret = this.getEnvVar("LASTFM_SHARED_SECRET");

    // Navidrome
    this.navidromeUrl = this.getEnvVar("NAVIDROME_URL");
    this.navidromeUsername = this.getEnvVar("NAVIDROME_USERNAME");
    this.navidromePassword = this.getEnvVar("NAVIDROME_PASSWORD");

    // Soulseek
    this.slskdUrl = this.getEnvVar("SLSKD_URL");
    this.slskdApiKey = this.getEnvVar("SLSKD_API_KEY");

    // Beets
    this.beetsUrl = this.getEnvVar("BEETS_URL", "http://beets:8337");
    this.beetsConfigPath = this.getEnvVar("BEETS_CONFIG_PATH", "/config");

    // Cron
    this.cronSchedule = this.getEnvVar("CRON_SCHEDULE", "0 */6 * * *");

    // Playlist
    this.playlistName = this.getEnvVar(
      "PLAYLIST_NAME",
      "LastFM Recommendations"
    );
    this.cleanPlaylistsOnRefresh = this.getBooleanEnvVar(
      "CLEAN_PLAYLISTS_ON_REFRESH",
      true
    );
    this.keepDownloadedTracks = this.getBooleanEnvVar(
      "KEEP_DOWNLOADED_TRACKS",
      true
    );

    // Download
    this.maxDownloadRetries = parseInt(
      this.getEnvVar("MAX_DOWNLOAD_RETRIES", "5")
    );
    this.downloadTimeoutMinutes = parseInt(
      this.getEnvVar("DOWNLOAD_TIMEOUT_MINUTES", "10")
    );
    this.concurrentDownloads = parseInt(
      this.getEnvVar("CONCURRENT_DOWNLOADS", "3")
    );

    // Logging
    this.logLevel = this.getEnvVar("LOG_LEVEL", "info");
    this.logToFile = this.getBooleanEnvVar("LOG_TO_FILE", true);

    // Other
    this.dryRun = this.getBooleanEnvVar("DRY_RUN", false);
  }

  public static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  private getEnvVar(name: string, defaultValue?: string): string {
    const value = process.env[name];
    if (!value) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Environment variable ${name} is required`);
    }
    return value;
  }

  private getBooleanEnvVar(name: string, defaultValue: boolean): boolean {
    const value = process.env[name];
    if (!value) {
      return defaultValue;
    }
    return value.toLowerCase() === "true";
  }
}
