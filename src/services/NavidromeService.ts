import axios, { AxiosInstance } from "axios";
import { Config } from "../config/Config";
import { Logger } from "../utils/Logger";
import { NavidromeTrack } from "../types/Track";
import winston from "winston";

export class NavidromeService {
  private config: Config;
  private logger: winston.Logger;
  private client: AxiosInstance;
  private authToken?: string;

  constructor() {
    this.config = Config.getInstance();
    this.logger = Logger.getInstance();
    this.client = axios.create({
      baseURL: this.config.navidromeUrl,
      timeout: 10000,
    });
  }

  async testConnection(): Promise<void> {
    try {
      await this.authenticate();

      // Test with a simple ping
      const response = await this.client.get("/rest/ping", {
        headers: this.getAuthHeaders(),
        params: this.getBaseParams(),
      });

      if (response.data["subsonic-response"]?.status !== "ok") {
        throw new Error("Navidrome ping failed");
      }

      this.logger.debug("Navidrome connection test successful");
    } catch (error) {
      this.logger.error("Navidrome connection test failed:", error);
      throw error;
    }
  }

  async authenticate(): Promise<void> {
    try {
      const response = await this.client.post("/auth/login", {
        username: this.config.navidromeUsername,
        password: this.config.navidromePassword,
      });

      this.authToken =
        response.data.token || response.headers["x-nd-authorization"];

      if (!this.authToken) {
        throw new Error("No auth token received from Navidrome");
      }

      this.logger.debug("Successfully authenticated with Navidrome");
    } catch (error) {
      this.logger.error("Navidrome authentication failed:", error);
      throw error;
    }
  }

  async searchTrack(
    artist: string,
    title: string
  ): Promise<NavidromeTrack | null> {
    try {
      if (!this.authToken) {
        await this.authenticate();
      }

      // Search using Subsonic API
      const searchQuery = `${artist} ${title}`;
      const response = await this.client.get("/rest/search3", {
        headers: this.getAuthHeaders(),
        params: {
          ...this.getBaseParams(),
          query: searchQuery,
          songCount: 10,
        },
      });

      const searchResult = response.data["subsonic-response"];

      if (searchResult.status !== "ok" || !searchResult.searchResult3?.song) {
        return null;
      }

      const songs = Array.isArray(searchResult.searchResult3.song)
        ? searchResult.searchResult3.song
        : [searchResult.searchResult3.song];

      // Find the best match
      for (const song of songs) {
        if (this.isTrackMatch(song, artist, title)) {
          return this.mapSubsonicTrackToNavidromeTrack(song);
        }
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
      if (!this.authToken) {
        await this.authenticate();
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
      if (!this.authToken) {
        await this.authenticate();
      }

      const playlist = await this.findPlaylist(name);
      if (!playlist) {
        this.logger.debug(`Playlist "${name}" not found, nothing to delete`);
        return;
      }

      await this.client.get("/rest/deletePlaylist", {
        headers: this.getAuthHeaders(),
        params: {
          ...this.getBaseParams(),
          id: playlist.id,
        },
      });

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
        headers: this.getAuthHeaders(),
        params: this.getBaseParams(),
      });

      const result = response.data["subsonic-response"];

      if (result.status !== "ok" || !result.playlists?.playlist) {
        return null;
      }

      const playlists = Array.isArray(result.playlists.playlist)
        ? result.playlists.playlist
        : [result.playlists.playlist];

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
    const trackIds = tracks.map((track) => track.id).join(",");

    await this.client.get("/rest/createPlaylist", {
      headers: this.getAuthHeaders(),
      params: {
        ...this.getBaseParams(),
        name: name,
        songId: trackIds,
      },
    });
  }

  private async updatePlaylist(
    playlistId: string,
    tracks: NavidromeTrack[]
  ): Promise<void> {
    // First, get current playlist to clear it
    const response = await this.client.get("/rest/getPlaylist", {
      headers: this.getAuthHeaders(),
      params: {
        ...this.getBaseParams(),
        id: playlistId,
      },
    });

    const result = response.data["subsonic-response"];
    if (result.status === "ok" && result.playlist?.entry) {
      // Clear existing entries
      const existingEntries = Array.isArray(result.playlist.entry)
        ? result.playlist.entry
        : [result.playlist.entry];

      for (const entry of existingEntries) {
        await this.client.get("/rest/updatePlaylist", {
          headers: this.getAuthHeaders(),
          params: {
            ...this.getBaseParams(),
            playlistId: playlistId,
            songIndexToRemove: 0, // Always remove first song until empty
          },
        });
      }
    }

    // Add new tracks
    if (tracks.length > 0) {
      const trackIds = tracks.map((track) => track.id).join(",");
      await this.client.get("/rest/updatePlaylist", {
        headers: this.getAuthHeaders(),
        params: {
          ...this.getBaseParams(),
          playlistId: playlistId,
          songIdToAdd: trackIds,
        },
      });
    }
  }

  private isTrackMatch(
    subsonicTrack: any,
    artist: string,
    title: string
  ): boolean {
    const normalize = (str: string) =>
      str
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .trim();

    const trackArtist = normalize(subsonicTrack.artist || "");
    const trackTitle = normalize(subsonicTrack.title || "");
    const searchArtist = normalize(artist);
    const searchTitle = normalize(title);

    return trackArtist === searchArtist && trackTitle === searchTitle;
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

  private getAuthHeaders(): Record<string, string> {
    return this.authToken
      ? {
          Authorization: `Bearer ${this.authToken}`,
          "X-ND-Authorization": this.authToken,
        }
      : {};
  }

  private getBaseParams(): Record<string, string> {
    return {
      u: this.config.navidromeUsername,
      v: "1.15.0",
      c: "MusicSpree",
      f: "json",
    };
  }
}
