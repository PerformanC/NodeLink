# NodeLink

Performant LavaLink replacement, written in Node.js.

## LavaLink API coverage

- [x] Events
- [x] Filters
- [x] Endpoints, except route planner
- [x] LoadTracks endpoint, without Vimeo and Twitch.
- [x] Track(s) encoding & loadCaptions (NodeLink-only endpoint)
- [ ] Resume system

> [!NOTE]
> It's decided that resume support won't be added back to NodeLink. If you want to use resume system, use [the last commit containg it](https://github.com/PerformanC/NodeLink/commit/1f6ddc779253fbdcd1d5576d38402cb98d6d5afa). Be aware that it's an unmaintained version.

## Sources

- [x] BandCamp   *
- [x] Deezer     *
- [x] HTTP       *
- [x] Local      *
- [x] Pandora
- [x] SoundCloud *
- [x] Spotify
- [x] YouTube    *
- [x] YTMusic    *

> [!NOTE]
> \* means that it's a master source, which directly plays from the source, without using other source to get its stream (master dependant).

## LoadLyrics sources

- [x] Genius     *
- [x] MusixMatch *
- [x] Deezer (requires `arl`)
- [x] Spotify (requires `sp_dc`)
- [x] YouTube
- [x] YouTube Music

> [!NOTE]
> \* means that it's a generic source, which is used when the source is not supported by master sources.

## NodeLink vs Lavalink

### Performance

Due to NodeLink's design, executing audio processing in real-time and directly accessing sources with its built-in sources, NodeLink is faster than LavaLink in any aspect, especially for filtering.

> [!NOTE]
> It's recommended to do your benchmarks. The statement above is based on our benchmarks and all the feedback sent by the community.

### Stability

LavaLink as a modular project, using matured libraries and dependencies like LavaPlayer, is more stable than NodeLink, which is a new project, and it's not as mature as LavaLink.

> [!NOTE]
> While NodeLink is less stable than LavaLink, it's still stable enough to be used in production. If you find any bugs, create an issue on our GitHub repository.

### Resource usage

While it's true that JVM is faster than Node.js, JVM consumes more resources than Node.js. LavaLink, as a project written in Kotlin, uses JVM.

> [!NOTE]
> LavaPlayer has bindings using C, but it's limited for audio processing/transcoding. It's not used for networking, and other things that LavaLink does.

Here's a comparison between LavaLink and NodeLink resource usage with one player connected playing a YouTube track.

| Project                 | CPU usage | Memory usage | Comments       |
| ----------------------- | --------- | ------------ | -------------- |
| LavaLink v4.0.3         | 0,6 - 1%  | 300MB        | OpenJDK 17.0.9 |
| NodeLink v2.0.0 9448f4f | 1 - 1,3%  | 35MB         | Node.js 21.6.1 |

> [!IMPORTANT]
> Those informations are based on the total RAM & CPU usage of the system as it's based on the entire process.

> [!NOTE]
> Resource usage can be improved by using different JS runtime, like Bun or Deno, or by using different JVM runtime, like GraalVM.

> [!WARNING]
> Bun isn't supported by NodeLink as as it [leaks `node:dgram` support](https://github.com/oven-sh/bun/issues/1630)

### Features

NodeLink implements [most LavaLink API](#lavalink-api-coverage) and includes more sources and endpoints/systems, like `/v4/loadLyrics` and `/connection/data` (voice receive) endpoints.

> [!NOTE]
> This is considering the base LavaLink, not its forks or plugins.

## Usage

### Minimum requirements

- [Node.js](https://nodejs.org) 14.0.0
- FFmpeg or ffmpeg-static

### Recommended requirements

- [Node.js](https://nodejs.org) latest
- FFmpeg

### Installation

To install NodeLink, you must clone the repository and install the dependencies.

```bash
$ git clone https://github.com/PerformanC/NodeLink
$ cd NodeLink
$ npm i -f
```

> [!WARNING]
> You must use `-f` flag to force the installation of the dependencies. `prism-media` uses an outdated `opusscript` version. This will not affect the usage of NodeLink.

> [!NOTE]
> If you to use pure JavaScript, replace `sodium-native` with `libsodium-wrappers`. Keep in mind that pure JavaScript will offer a worse performance.

### Running

To run NodeLink, you need to run the following command in the root directory of NodeLink.

```bash
$ npm start
```

Now you can connect to NodeLink using the LavaLink API, using a `v4` LavaLink client.

> [!WARNING]
> Never run NodeLink outside its root directory with auto-updater enabled. It will nuke the directory it's running on while updating.

## Supported clients

NodeLink is compatible with most LavaLink clients, as it implements most of the LavaLink API. However, some clients may not be compatible with NodeLink, as it implements changes some behaviors and endpoints.

| Client                                                              | Platform     | v2 supported?   | NodeLink Features?  | NodeLink major version |
| --------------------------------------------------------------------|--------------|-----------------|---------------------|------------------------|
| [Lavalink-Client](https://github.com/lavalink-devs/Lavalink-Client) | JVM          | Yes             | No                  | v1 and v2              |
| [Lavalink.kt](https://github.com/DRSchlaubi/Lavalink.kt)            | Kotlin       | No              | No                  | v1                     |
| [DisGoLink](https://github.com/disgoorg/disgolink)                  | Go           | Yes             | No                  | v1 and v2              |
| [Lavalink.py](https://github.com/devoxin/lavalink.py)               | Python       | Yes             | No                  | v1 and v2              |
| [Mafic](https://github.com/ooliver1/mafic)                          | Python       | Yes             | No                  | v1 and v2              |
| [Wavelink](https://github.com/PythonistaGuild/Wavelink)             | Python       | Yes             | No                  | v1 and v2              |
| [Moonlink.js](https://github.com/1Lucas1apk/moonlink.js)            | Node.js      | Yes             | No                  | v1 and v2              |
| [Magmastream](https://github.com/Blackfort-Hosting/magmastream)     | Node.js      | No              | No                  | v1                     |
| [Lavacord](https://github.com/lavacord/Lavacord)                    | Node.js      | Yes             | No                  | v1 and v2              |
| [Shoukaku](https://github.com/Deivu/Shoukaku)                       | Node.js      | Yes             | No                  | v1 and v2              |
| [Lavalink-Client](https://github.com/tomato6966/Lavalink-Client)    | Node.js      | No              | No                  | v1                     |
| [FastLink](https://github.com/PerformanC/FastLink)                  | Node.js      | Yes             | Yes                 | v1 and v2              |
| [Riffy](https://github.com/riffy-team/riffy)                        | Node.js      | Yes             | No                  | v1 and v2              |
| [DisCatSharp](https://github.com/Aiko-IT-Systems/DisCatSharp)       | .NET         | Yes             | No                  | v1 and v2              |
| [Lavalink4NET](https://github.com/angelobreuer/Lavalink4NET)        | .NET         | Yes             | No                  | v1 and v2              |
| [Nomia](https://github.com/DHCPCD9/Nomia)                           | .NET         | Yes             | No                  | v1 and v2              |
| [CogLink](https://github.com/PerformanC/Coglink)                    | C            | Yes             | No                  | v1 and v2              |
| [Lavalink-rs](https://gitlab.com/vicky5124/lavalink-rs)             | Rust, Python | Yes             | No                  | v1 and v2              |
| [nyxx_lavalink](https://github.com/nyxx-discord/nyxx_lavalink)      | Dart         | No              | No                  | v1                     |

> [!NOTE]
> The data is gotten from [LavaLink documentation](https://lavalink.dev/clients#client-libraries), updated with manual checks.

## Support & Feedback

If you have any questions, or only want to give a feedback, about NodeLink or any other PerformanC project, join [our Discord server](https://discord.gg/uPveNfTuCJ).

## License

NodeLink is licensed under PerformanC's License, which is a modified version of the MIT License, focusing on the protection of the source code and the rights of the PerformanC team over the source code.
