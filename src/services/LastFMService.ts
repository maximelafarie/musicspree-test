import axios, { AxiosInstance } from "axios";
import { Config } from "../config/Config";
import { Logger } from "../utils/Logger";
import { Track, LastFMTrack } from "../types/Track";
import winston from "winston";

export class LastFMService {
  private config: Config;
  private logger: winston.Logger;
  private client: AxiosInstance;

  constructor() {
    this.config = Config.getInstance();
    this.logger = Logger.getInstance();
    this.client = axios.create({
      baseURL: "http://ws.audioscrobbler.com/2.0/",
      timeout: 15000,
      params: {
        api_key: this.config.lastfmApiKey,
        format: "json",
      },
    });
  }

  async testConnection(): Promise<void> {
    try {
      const response = await this.client.get("/", {
        params: {
          method: "user.getinfo",
          user: this.config.lastfmUsername,
        },
      });

      if (response.data.error) {
        throw new Error(`LastFM API Error: ${response.data.message}`);
      }

      if (!response.data.user) {
        throw new Error("Invalid LastFM user response");
      }

      this.logger.debug("LastFM connection test successful", {
        user: response.data.user.name,
        playcount: response.data.user.playcount,
      });
    } catch (error) {
      this.logger.error("LastFM connection test failed:", error);
      throw error;
    }
  }

  async getRecommendations(limit: number = 50): Promise<Track[]> {
    try {
      this.logger.info(`📡 Fetching ${limit} recommendations from LastFM...`);

      // Try multiple sources for recommendations
      const recommendations: Track[] = [];

      // 1. Get user's loved tracks (most reliable for personal recommendations)
      try {
        const lovedTracks = await this.getUserLovedTracks(
          Math.ceil(limit * 0.4)
        );
        recommendations.push(...lovedTracks);
        this.logger.debug(`Got ${lovedTracks.length} loved tracks`);
      } catch (error) {
        this.logger.warn("Failed to get loved tracks:", error);
      }

      // 2. Get user's top tracks from recent periods
      try {
        const topTracks = await this.getUserTopTracks(
          "1month",
          Math.ceil(limit * 0.3)
        );
        recommendations.push(...topTracks);
        this.logger.debug(`Got ${topTracks.length} top tracks`);
      } catch (error) {
        this.logger.warn("Failed to get top tracks:", error);
      }

      // 3. Get similar tracks based on user's listening history
      if (recommendations.length > 0) {
        try {
          const similarTracks = await this.getSimilarTracksFromHistory(
            recommendations.slice(0, 5),
            Math.ceil(limit * 0.3)
          );
          recommendations.push(...similarTracks);
          this.logger.debug(`Got ${similarTracks.length} similar tracks`);
        } catch (error) {
          this.logger.warn("Failed to get similar tracks:", error);
        }
      }

      // 4. Fallback to chart tracks if we don't have enough
      if (recommendations.length < limit) {
        try {
          const chartTracks = await this.getChartTopTracks(
            limit - recommendations.length
          );
          recommendations.push(...chartTracks);
          this.logger.debug(`Got ${chartTracks.length} chart tracks`);
        } catch (error) {
          this.logger.warn("Failed to get chart tracks:", error);
        }
      }

      // Remove duplicates and limit results
      const uniqueRecommendations = this.removeDuplicates(
        recommendations
      ).slice(0, limit);

      this.logger.info(
        `📋 Retrieved ${uniqueRecommendations.length} unique recommendations`
      );
      return uniqueRecommendations;
    } catch (error) {
      this.logger.error("Failed to fetch LastFM recommendations:", error);
      throw error;
    }
  }

  async getUserLovedTracks(limit: number = 20): Promise<Track[]> {
    try {
      const response = await this.client.get("/", {
        params: {
          method: "user.getlovedtracks",
          user: this.config.lastfmUsername,
          limit: limit,
        },
      });

      if (response.data.error) {
        throw new Error(`LastFM API Error: ${response.data.message}`);
      }

      return this.parseLovedTracks(response.data);
    } catch (error) {
      this.logger.debug("Failed to fetch loved tracks:", error);
      return [];
    }
  }

  async getUserTopTracks(
    period:
      | "overall"
      | "7day"
      | "1month"
      | "3month"
      | "6month"
      | "12month" = "1month",
    limit: number = 20
  ): Promise<Track[]> {
    try {
      const response = await this.client.get("/", {
        params: {
          method: "user.gettoptracks",
          user: this.config.lastfmUsername,
          period: period,
          limit: limit,
        },
      });

      if (response.data.error) {
        throw new Error(`LastFM API Error: ${response.data.message}`);
      }

      return this.parseUserTopTracks(response.data);
    } catch (error) {
      this.logger.debug("Failed to fetch user top tracks:", error);
      return [];
    }
  }

  async getSimilarTracks(
    artist: string,
    track: string,
    limit: number = 10
  ): Promise<Track[]> {
    try {
      const response = await this.client.get("/", {
        params: {
          method: "track.getsimilar",
          artist: artist,
          track: track,
          limit: limit,
        },
      });

      if (response.data.error) {
        throw new Error(`LastFM API Error: ${response.data.message}`);
      }

      return this.parseSimilarTracks(response.data);
    } catch (error) {
      this.logger.debug(
        `Failed to fetch similar tracks for ${artist} - ${track}:`,
        error
      );
      return [];
    }
  }

  async getChartTopTracks(limit: number = 20): Promise<Track[]> {
    try {
      const response = await this.client.get("/", {
        params: {
          method: "chart.gettoptracks",
          limit: limit,
        },
      });

      if (response.data.error) {
        throw new Error(`LastFM API Error: ${response.data.message}`);
      }

      return this.parseTopTracks(response.data);
    } catch (error) {
      this.logger.debug("Failed to fetch chart top tracks:", error);
      return [];
    }
  }

  private async getSimilarTracksFromHistory(
    baseTracks: Track[],
    limit: number
  ): Promise<Track[]> {
    const similarTracks: Track[] = [];
    const tracksPerBase = Math.ceil(limit / baseTracks.length);

    for (const baseTrack of baseTracks) {
      try {
        const similar = await this.getSimilarTracks(
          baseTrack.artist,
          baseTrack.title,
          tracksPerBase
        );
        similarTracks.push(...similar);

        // Add small delay to avoid rate limiting
        await this.sleep(200);

        if (similarTracks.length >= limit) break;
      } catch (error) {
        this.logger.debug(
          `Failed to get similar tracks for ${baseTrack.artist} - ${baseTrack.title}:`,
          error
        );
      }
    }

    return similarTracks.slice(0, limit);
  }

  private parseTopTracks(data: any): Track[] {
    const tracks: Track[] = [];

    if (data.tracks && data.tracks.track) {
      const trackList = Array.isArray(data.tracks.track)
        ? data.tracks.track
        : [data.tracks.track];

      for (const track of trackList) {
        try {
          tracks.push(this.mapLastFMTrackToTrack(track));
        } catch (error) {
          this.logger.debug("Failed to parse track:", error);
        }
      }
    }

    return tracks;
  }

  private parseUserTopTracks(data: any): Track[] {
    const tracks: Track[] = [];

    if (data.toptracks && data.toptracks.track) {
      const trackList = Array.isArray(data.toptracks.track)
        ? data.toptracks.track
        : [data.toptracks.track];

      for (const track of trackList) {
        try {
          tracks.push(this.mapLastFMTrackToTrack(track));
        } catch (error) {
          this.logger.debug("Failed to parse user top track:", error);
        }
      }
    }

    return tracks;
  }

  private parseLovedTracks(data: any): Track[] {
    const tracks: Track[] = [];

    if (data.lovedtracks && data.lovedtracks.track) {
      const trackList = Array.isArray(data.lovedtracks.track)
        ? data.lovedtracks.track
        : [data.lovedtracks.track];

      for (const track of trackList) {
        try {
          tracks.push(this.mapLastFMTrackToTrack(track));
        } catch (error) {
          this.logger.debug("Failed to parse loved track:", error);
        }
      }
    }

    return tracks;
  }

  private parseSimilarTracks(data: any): Track[] {
    const tracks: Track[] = [];

    if (data.similartracks && data.similartracks.track) {
      const trackList = Array.isArray(data.similartracks.track)
        ? data.similartracks.track
        : [data.similartracks.track];

      for (const track of trackList) {
        try {
          tracks.push(this.mapLastFMTrackToTrack(track));
        } catch (error) {
          this.logger.debug("Failed to parse similar track:", error);
        }
      }
    }

    return tracks;
  }

  private mapLastFMTrackToTrack(lastfmTrack: any): Track {
    // Handle different LastFM API response formats
    const artist =
      typeof lastfmTrack.artist === "string"
        ? lastfmTrack.artist
        : lastfmTrack.artist?.name || lastfmTrack.artist?.["#text"];

    const title = lastfmTrack.name || lastfmTrack.title;
    const album = lastfmTrack.album?.name || lastfmTrack.album?.["#text"];

    if (!artist || !title) {
      throw new Error("Invalid track data: missing artist or title");
    }

    return {
      title: title.trim(),
      artist: artist.trim(),
      album: album?.trim(),
      url: lastfmTrack.url,
      duration: lastfmTrack.duration
        ? parseInt(lastfmTrack.duration)
        : undefined,
    };
  }

  private removeDuplicates(tracks: Track[]): Track[] {
    const seen = new Set<string>();
    return tracks.filter((track) => {
      const key = `${track.artist.toLowerCase()}_${track.title.toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
