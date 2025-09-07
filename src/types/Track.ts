export interface Track {
  artist: string;
  title: string;
  album?: string;
  duration?: number;
  url?: string;
}

export interface NavidromeTrack extends Track {
  id: string;
  albumId?: string;
  artistId?: string;
  path: string;
  size?: number;
  bitRate?: number;
  year?: number;
  genre?: string;
}

export interface LastFMTrack {
  name: string;
  artist: {
    "#text": string;
    mbid?: string;
  };
  url?: string;
  duration?: string;
  streamable?: {
    "#text": string;
    fulltrack: string;
  };
  album?: {
    "#text": string;
    mbid?: string;
  };
  image?: Array<{
    "#text": string;
    size: string;
  }>;
}

export interface PlaylistSyncResult {
  totalRecommendations: number;
  alreadyInLibrary: number;
  newDownloads: number;
  failedDownloads: number;
  addedToPlaylist: number;
  errors: string[];
}

export interface DownloadResult {
  track: Track;
  success: boolean;
  error?: string;
  retries: number;
}
