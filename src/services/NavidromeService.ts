import axios, { AxiosInstance } from "axios";
import { Config } from "../config/Config";
import { Logger } from "../utils/Logger";
import { NavidromeTrack } from "../types/Track";
import winston from "winston";
import crypto from "crypto";

export class NavidromeService {
  private config: Config;
  private logger: winston.Logger;
  private client: AxiosInstance;
  private authToken?: string;
  private salt?: string;
  private tokenExpiry?: number;

  constructor() {
    this.config = Config.getInstance();
    this.logger = Logger.getInstance();
    this.client = axios.create({
      baseURL: this.config.navidromeUrl,
      timeout: 15000,
    });
  }

  async testConnection(): Promise<void> {
    try {
      await this.ensureAuthenticated();

      // Test with a simple ping
      const response = await this.client.get("/rest/ping", {
        params: this.getSubsonicParams(),
      });

      const subsonicResponse = response.data["subsonic-response"];
      if (!subsonicResponse || subsonicResponse.status !== "ok") {
        throw new Error(
          `Navidrome ping failed: ${
            subsonicResponse?.error?.message || "Unknown error"
          }`
        );
      }

      this.logger.debug("Navidrome connection test successful", {
        version: subsonicResponse.version,
        type: subsonicResponse.type,
      });
    } catch (error) {
      this.logger.error("Navidrome connection test failed:", error);
      throw error;
    }
  }

  async ensureAuthenticated(): Promise<void> {
    // Check if token is still valid (assuming 1 hour expiry)
    if (this.authToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return;
    }

    try {
      // Generate salt for authentication
      this.salt = crypto.randomBytes(16).toString("hex");

      // Create MD5 hash of password + salt
      const passwordHash = crypto
        .createHash("md5")
        .update(this.config.navidromePassword + this.salt)
        .digest("hex");

      // Test authentication with getUser call
      const response = await this.client.get("/rest/getUser", {
        params: {
          u: this.config.navidromeUsername,
          t: passwordHash,
          s: this.salt,
          v: "1.15.0",
          c: "MusicSpree",
          f: "json",
          username: this.config.navidromeUsername,
        },
      });

      const subsonicResponse = response.data["subsonic-response"];
      if (!subsonicResponse || subsonicResponse.status !== "ok") {
        throw new Error(
          `Authentication failed: ${
            subsonicResponse?.error?.message || "Invalid credentials"
          }`
        );
      }

      // Store auth info
      this.authToken = passwordHash;
      this.tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 minutes

      this.logger.debug("Successfully authenticated with Navidrome", {
        user: subsonicResponse.user?.userName,
        adminRole: subsonicResponse.user?.adminRole,
      });
    } catch (error) {
      this.logger.error("Navidrome authentication failed:", error);
      this.authToken = undefined;
      this.salt = undefined;
      this.tokenExpiry = undefined;
      throw error;
    }
  }

  async searchTrack(
    artist: string,
    title: string
  ): Promise<NavidromeTrack | null> {
    try {
      await this.ensureAuthenticated();

      // Search using Subsonic API
      const searchQuery = `${artist} ${title}`;
      const response = await this.client.get("/rest/search3", {
        params: {
          ...this.getSubsonicParams(),
          query: searchQuery,
          songCount: 10,
          artistCount: 0,
          albumCount: 0,
        },
      });

      const subsonicResponse = response.data["subsonic-response"];

      if (subsonicResponse.status !== "ok") {
        this.logger.warn(`Search failed: ${subsonicResponse.error?.message}`);
        return null;
      }

      if (!subsonicResponse.searchResult3?.song) {
        return null;
      }

      const songs = Array.isArray(subsonicResponse.searchResult3.song)
        ? subsonicResponse.searchResult3.song
        : [subsonicResponse.searchResult3.song];

      // Find the best match using fuzzy matching
      let bestMatch: any = null;
      let bestScore = 0;

      for (const song of songs) {
        const score = this.calculateMatchScore(song, artist, title);
        if (score > bestScore && score > 0.6) {
          // Minimum threshold
          bestScore = score;
          bestMatch = song;
        }
      }

      if (bestMatch) {
        this.logger.debug(
          `Found match for "${artist} - ${title}" with score ${bestScore.toFixed(
            2
          )}`
        );
        return this.mapSubsonicTrackToNavidromeTrack(bestMatch);
      }

      return null;
    } catch (error) {
      this.logger.debug(`Search failed for ${artist} - ${title}:`, error);
      return null;
    }
  }

  async createOrUpdatePlaylist(
    name: string,
    tracks: NavidromeTrack[]
  ): Promise<void> {
    try {
      await this.ensureAuthenticated();

      if (tracks.length === 0) {
        this.logger.warn(`Cannot create playlist "${name}" with no tracks`);
        return;
      }

      // Check if playlist exists
      const existingPlaylist = await this.findPlaylist(name);

      if (existingPlaylist) {
        // Update existing playlist
        await this.updatePlaylist(existingPlaylist.id, tracks);
      } else {
        // Create new playlist
        await this.createPlaylist(name, tracks);
      }

      this.logger.info(
        `📝 Playlist "${name}" updated with ${tracks.length} tracks`
      );
    } catch (error) {
      this.logger.error(`Failed to create/update playlist "${name}":`, error);
      throw error;
    }
  }

  async deletePlaylist(name: string): Promise<void> {
    try {
      await this.ensureAuthenticated();

      const playlist = await this.findPlaylist(name);
      if (!playlist) {
        this.logger.debug(`Playlist "${name}" not found, nothing to delete`);
        return;
      }

      const response = await this.client.get("/rest/deletePlaylist", {
        params: {
          ...this.getSubsonicParams(),
          id: playlist.id,
        },
      });

      const subsonicResponse = response.data["subsonic-response"];
      if (subsonicResponse.status !== "ok") {
        throw new Error(`Delete failed: ${subsonicResponse.error?.message}`);
      }

      this.logger.info(`🗑️ Deleted playlist "${name}"`);
    } catch (error) {
      this.logger.error(`Failed to delete playlist "${name}":`, error);
      throw error;
    }
  }

  private async findPlaylist(
    name: string
  ): Promise<{ id: string; name: string } | null> {
    try {
      const response = await this.client.get("/rest/getPlaylists", {
        params: this.getSubsonicParams(),
      });

      const subsonicResponse = response.data["subsonic-response"];

      if (subsonicResponse.status !== "ok") {
        throw new Error(
          `Failed to get playlists: ${subsonicResponse.error?.message}`
        );
      }

      if (!subsonicResponse.playlists?.playlist) {
        return null;
      }

      const playlists = Array.isArray(subsonicResponse.playlists.playlist)
        ? subsonicResponse.playlists.playlist
        : [subsonicResponse.playlists.playlist];

      const found = playlists.find((playlist: any) => playlist.name === name);
      return found ? { id: found.id, name: found.name } : null;
    } catch (error) {
      this.logger.debug(`Failed to find playlist "${name}":`, error);
      return null;
    }
  }

  private async createPlaylist(
    name: string,
    tracks: NavidromeTrack[]
  ): Promise<void> {
    if (tracks.length === 0) {
      throw new Error("Cannot create playlist with no tracks");
    }

    const trackIds = tracks.map((track) => track.id);

    const response = await this.client.get("/rest/createPlaylist", {
      params: {
        ...this.getSubsonicParams(),
        name: name,
        songId: trackIds,
      },
    });

    const subsonicResponse = response.data["subsonic-response"];
    if (subsonicResponse.status !== "ok") {
      throw new Error(
        `Create playlist failed: ${subsonicResponse.error?.message}`
      );
    }

    this.logger.debug(
      `Created playlist "${name}" with ${tracks.length} tracks`
    );
  }

  private async updatePlaylist(
    playlistId: string,
    tracks: NavidromeTrack[]
  ): Promise<void> {
    // First, clear the existing playlist
    await this.clearPlaylist(playlistId);

    // Then add new tracks if any
    if (tracks.length > 0) {
      const trackIds = tracks.map((track) => track.id);

      const response = await this.client.get("/rest/updatePlaylist", {
        params: {
          ...this.getSubsonicParams(),
          playlistId: playlistId,
          songIdToAdd: trackIds,
        },
      });

      const subsonicResponse = response.data["subsonic-response"];
      if (subsonicResponse.status !== "ok") {
        throw new Error(
          `Update playlist failed: ${subsonicResponse.error?.message}`
        );
      }
    }

    this.logger.debug(
      `Updated playlist ${playlistId} with ${tracks.length} tracks`
    );
  }

  private async clearPlaylist(playlistId: string): Promise<void> {
    // Get current playlist to see what's in it
    const response = await this.client.get("/rest/getPlaylist", {
      params: {
        ...this.getSubsonicParams(),
        id: playlistId,
      },
    });

    const subsonicResponse = response.data["subsonic-response"];
    if (subsonicResponse.status !== "ok") {
      throw new Error(
        `Get playlist failed: ${subsonicResponse.error?.message}`
      );
    }

    if (!subsonicResponse.playlist?.entry) {
      return; // Playlist is already empty
    }

    const existingEntries = Array.isArray(subsonicResponse.playlist.entry)
      ? subsonicResponse.playlist.entry
      : [subsonicResponse.playlist.entry];

    // Remove all entries (removing from index 0 each time)
    for (let i = 0; i < existingEntries.length; i++) {
      const removeResponse = await this.client.get("/rest/updatePlaylist", {
        params: {
          ...this.getSubsonicParams(),
          playlistId: playlistId,
          songIndexToRemove: 0, // Always remove first song
        },
      });

      const removeSubsonicResponse = removeResponse.data["subsonic-response"];
      if (removeSubsonicResponse.status !== "ok") {
        this.logger.warn(
          `Failed to remove song at index 0: ${removeSubsonicResponse.error?.message}`
        );
        break; // Don't fail the whole operation
      }
    }
  }

  private calculateMatchScore(
    subsonicTrack: any,
    artist: string,
    title: string
  ): number {
    const normalize = (str: string) =>
      str
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const trackArtist = normalize(subsonicTrack.artist || "");
    const trackTitle = normalize(subsonicTrack.title || "");
    const searchArtist = normalize(artist);
    const searchTitle = normalize(title);

    let score = 0;

    // Exact matches
    if (trackArtist === searchArtist) score += 0.5;
    if (trackTitle === searchTitle) score += 0.5;

    // Partial matches
    if (
      trackArtist.includes(searchArtist) ||
      searchArtist.includes(trackArtist)
    )
      score += 0.2;
    if (trackTitle.includes(searchTitle) || searchTitle.includes(trackTitle))
      score += 0.2;

    // Bonus for complete match
    if (trackArtist === searchArtist && trackTitle === searchTitle) {
      score = 1.0;
    }

    return Math.min(score, 1.0);
  }

  private mapSubsonicTrackToNavidromeTrack(subsonicTrack: any): NavidromeTrack {
    return {
      id: subsonicTrack.id,
      title: subsonicTrack.title,
      artist: subsonicTrack.artist,
      album: subsonicTrack.album,
      albumId: subsonicTrack.albumId,
      artistId: subsonicTrack.artistId,
      path: subsonicTrack.path || "",
      duration: subsonicTrack.duration
        ? parseInt(subsonicTrack.duration)
        : undefined,
      size: subsonicTrack.size ? parseInt(subsonicTrack.size) : undefined,
      bitRate: subsonicTrack.bitRate
        ? parseInt(subsonicTrack.bitRate)
        : undefined,
      year: subsonicTrack.year ? parseInt(subsonicTrack.year) : undefined,
      genre: subsonicTrack.genre,
    };
  }

  private getSubsonicParams(): Record<string, any> {
    if (!this.authToken || !this.salt) {
      throw new Error("Not authenticated - call ensureAuthenticated() first");
    }

    return {
      u: this.config.navidromeUsername,
      t: this.authToken,
      s: this.salt,
      v: "1.15.0",
      c: "MusicSpree",
      f: "json",
    };
  }
}
