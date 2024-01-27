/*
Any of the settings below can be disabled by setting them to false, times are in milliseconds.

autoUpdate: [ beta?, autoUpdate?, interval, [tar, zip] ]
*/

export default {
  "version": {
    "major": "1",
    "minor": "15",
    "patch": "0",
    "preRelease": null
  },
  "server": {
    "port": 2333,
    "password": "youshallnotpass",
    "resumeTimeout": 10000,
  },
  "options": {
    "threshold": false,
    "playerUpdateInterval": false,
    "statsInterval": false,
    "autoUpdate": [ false, true, 3600000, "tar" ],
    "maxResultsLength": 200,
    "maxAlbumPlaylistLength": 200,
    "maxCaptionsLength": 3
  },
  "debug": {
    "pandora": {
      "success": true,
      "error": true
    },
    "deezer": {
      "success": true,
      "error": true
    },
    "spotify": {
      "success": true,
      "error": true
    },
    "soundcloud": {
      "success": true,
      "error": true
    },
    "musixmatch": true,
    "websocket": {
      "connect": true,
      "disconnect": true,
      "resume": true,
      "failedResume": true,
      "resumeTimeout": true,
      "error": true,
      "connectCD": true,
      "disconnectCD": true,
      "sentDataCD": true
    },
    "request": {
      "all": false, // Only enable for debugging purposes.
      "enabled": true,
      "error": true,
      "showBody": true,
      "showHeaders": true,
      "showParams": true
    },
    "track": {
      "start": true,
      "end": true,
      "exception": true,
      "stuck": true
    },
    "sources": {
      "retrieveStream": true,
      "loadtrack": {
        "request": true,
        "results": true,
        "exception": true
      },
      "search": {
        "request": true,
        "results": true,
        "exception": true
      },
      "loadlyrics": {
        "request": true,
        "results": true,
        "exception": true
      }
    }
  },
  "search": {
    "defaultSearchSource": "youtube",
    "fallbackSearchSource": "bandcamp",
    "lyricsFallbackSearchSource": "genius",
    "sources": {
      "youtube": true,
      "youtubeMusic": true,
      "bandcamp": true,
      "http": true,
      "local": true,
      "pandora": false,
      "spotify": {
        "enabled": true,
        "market": "BR",
        "sp_dc": "DISABLED" // Necessary for direct Spotify loadLyrics. Available in Spotify website cookies in "sp_dc" parameter.
      },
      "deezer": {
        "enabled": false,
        "decryptionKey": "DISABLED", // For legal reasons, this key is not provided.
        "apiKey": "DISABLED", // Available in Deezer website API requests in "api_token" parameter.
        "arl": "DISABLED" // Necessary for direct Deezer Lyrics. Available in Deezer website cookies in "arl" parameter.
      },
      "soundcloud": {
        "enabled": true,
        "clientId": "AUTOMATIC", // Available in SoundCloud website API requests in "client_id" parameter.
        "fallbackIfSnipped": true
      },
      "musixmatch": {
        "enabled": false,
        "signatureSecret": "DISABLED" // For legal reasons, this key is not provided.
      },
      "genius": {
        "enabled": true
      }
    }
  },
  "filters": {
    "enabled": true,
    "threads": 4,
    "list": {
      "volume": true,
      "equalizer": true,
      "karaoke": true,
      "timescale": true,
      "tremolo": true,
      "vibrato": true,
      "rotation": true,
      "distortion": true,
      "channelMix": true,
      "lowPass": true
    }
  },
  "audio": {
    "quality": "high",
    "encryption": "xsalsa20_poly1305_lite"
  },
  "voiceReceive": {
    "audioType": "ogg/opus" // ogg/opus or opus
  }
}