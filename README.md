<p align="center">
  <img src="https://github.com/1Lucas1apk/lab/blob/master/mwc2h6q%20-%20Imgur.png?raw=true" alt="NodeLink banner" />
</p>

<h1 align="center">NodeLink</h1>

<p align="center">
  An audio server for the things you're building.
</p>

<p align="center">
  <a href="https://nodelink.js.org">Documentation</a> ·
  <a href="https://nodelink.js.org/docs/api/rest">API Reference</a> ·
  <a href="https://nodelink.js.org/docs/config">Configuration</a> ·
  <a href="https://nodelink.js.org/docs/differences">NodeLink vs Lavalink</a> ·
  <a href="https://nodelink.js.org/docs/troubleshooting">Troubleshooting</a>
</p>

---

<table width="100%">
  <tr>
    <td width="126" align="center" valign="middle">
      <a href="https://tenor.com/view/hello-hey-hi-hello-there-greeting-gif-10513444760754524288">
        <img src="https://media1.tenor.com/m/kedCTqp3EIAAAAAd/hello-hey.gif" width="112" alt="Pudgy Penguin waving hello" />
      </a>
    </td>
    <td valign="middle">
      <h2>HELLOOOOOOOOOOO WORLD! 👋</h2>
      <p>Welcome to NodeLink!</p>
      <p>If you're here, you're probably building something that needs audio. Maybe it's a Discord bot, maybe it's a project you've been tinkering with for a while. You want tracks to play, sound to move, and the rest of your project to keep being <em>your</em> project.</p>
      <p>That's where NodeLink comes in.</p>
      <p>NodeLink is a standalone audio server built around the Node.js ecosystem. It has its own source system, playback workers and audio pipeline, while its standard HTTP and WebSocket interface is compatible with the <strong>Lavalink v4 protocol</strong> for clients that already support it.</p>
    </td>
  </tr>
</table>

## NodeLink? Why though? Seriously, why?

<table width="100%">
  <tr>
    <td valign="middle">
      <p>We like the tools that already exist. This isn't about pretending they don't.</p>
      <p>Sometimes you just want to build in the ecosystem you already work in. You want to open the source manager, follow a track through the audio pipeline, add a filter, fix something that broke, or understand why one stream behaves differently from another.</p>
      <p>NodeLink grew out of that curiosity. We wanted an audio server we could understand, change, and keep experimenting with — without leaving the Node.js world every time we wanted to look under the hood.</p>
      <p>It doesn't need to be mysterious. The code is there to explore, and there's room to make it your own.</p>
    </td>
    <td width="126" align="center" valign="middle">
      <a href="https://tenor.com/view/pudgy-penguin-pudgypenguins-contemplating-pondering-gif-3227962012062305123">
        <img src="https://media1.tenor.com/m/LMwGWPVty2MAAAAd/pudgy-penguin.gif" width="112" alt="Pudgy Penguin thinking" />
      </a>
    </td>
  </tr>
</table>

## Will my client work with NodeLink?

Your application connects directly to NodeLink through its HTTP API or WebSocket gateway. The standard player and session flow is compatible with the Lavalink v4 protocol, so existing clients can connect when they implement the expected requests, events and payloads. NodeLink also has its own additional capabilities, which need client-side support.

The matrix below keeps the structure and notes from the previous README. Its `v3 supported?`, `NodeLink Features?` and `NodeLink major version` columns are historical project notes, not a fresh compatibility test against the current NodeLink build. They should not be read as confirmation of current v4 support.

| Client | Platform | v3 supported? | NodeLink Features? | NodeLink major version | Notes |
| ------------------------------------------------------------------- | ------------ | ------------- | ------------------ | ---------------------- | ----- |
| [Lavalink-Client](https://github.com/lavalink-devs/Lavalink-Client) | JVM | unknown | No | v1 and v2 | |
| [Lavalink.kt](https://github.com/DRSchlaubi/Lavalink.kt) | Kotlin | unknown | No | v1 | |
| [DisGoLink](https://github.com/disgoorg/disgolink) | Go | unknown | No | v1 and v2 | |
| [Lavalink.py](https://github.com/devoxin/lavalink.py) | Python | Yes | No | v1, v2, v3 | |
| [Lavaplay.py](https://github.com/HazemMeqdad/lavaplay.py) | Python | Yes | No | v3 | |
| [Mafic](https://github.com/ooliver1/mafic) | Python | No | No | v1 and v2 | |
| [Wavelink](https://github.com/PythonistaGuild/Wavelink) | Python | Yes | No | v1, v2, v3 | |
| [Sonolink](https://github.com/sonolink/sonolink) | Python | Yes | No | v3 | |
| [Pomice](https://github.com/cloudwithax/pomice) | Python | unknown | No | v1 and v2 | |
| [lava-lyra](https://github.com/ParrotXray/lava-lyra) | Python | Yes | Yes | v3 | |
| [Hikari-ongaku](https://github.com/MPlatypus/hikari-ongaku) | Python | unknown | No | v1 and v2 | |
| [Moonlink.js](https://github.com/1Lucas1apk/moonlink.js) | TypeScript | Yes | Yes | v1, v2, v3 | |
| [Magmastream](https://github.com/Blackfort-Hosting/magmastream) | TypeScript | Yes | Yes | v1 and v3 | |
| [Lavacord](https://github.com/lavacord/Lavacord) | TypeScript | No | No | v1 and v2 | |
| [Shoukaku](https://github.com/Deivu/Shoukaku) | TypeScript | Yes | No | v1, v2, v3 | |
| [Hoshimi](https://github.com/Ganyu-Studios/Hoshimi) | TypeScript | Yes | No | v1, v2, v3 | ;P |
| [Lavalink-Client](https://github.com/tomato6966/Lavalink-Client) | TypeScript | Yes | Yes | v1, v3 | |
| [Rainlink](https://github.com/RainyXeon/Rainlink) | TypeScript | unknown | No | v1 and v2 | |
| [Poru](https://github.com/parasop/Poru) | TypeScript | unknown | No | v1 and v2 | |
| [Blue.ts](https://github.com/ftrapture/blue.ts) | TypeScript | unknown | No | v1 and v2 | |
| [FastLink](https://github.com/PerformanC/FastLink) | Node.js | Yes | No | v1, v2, v3 | |
| [Riffy](https://github.com/riffy-team/riffy) | Node.js | Yes | No | v1, v2, v3 | |
| [TsumiLink](https://github.com/Fyphen1223/TsumiLink) | Node.js | unknown | No | v1 and v2 | |
| [AquaLink](https://github.com/ToddyTheNoobDud/AquaLink) | JavaScript | Yes | Yes | v1, v2, v3 | |
| [DisCatSharp](https://github.com/Aiko-IT-Systems/DisCatSharp) | .NET | unknown | No | v1 and v2 | |
| [Lavalink4NET](https://github.com/angelobreuer/Lavalink4NET) | .NET | unknown | No | v1 and v2 | |
| [Nomia](https://github.com/DHCPCD9/Nomia) | .NET | unknown | No | v1 and v2 | |
| [CogLink](https://github.com/PerformanC/Coglink) | C | unknown | No | v1 and v2 | |
| [Lavalink-rs](https://gitlab.com/vicky5124/lavalink-rs) | Rust, Python | unknown | No | v1 and v2 | |
| [nyxx_lavalink](https://github.com/nyxx-discord/nyxx_lavalink) | Dart | unknown | No | v1 | |
| [Lavalink.lua](https://github.com/filispeen/lavalink.lua) | Lua | Yes | Yes | v1, v2, v3 | Mambo |

> The legacy columns above have not been revalidated against the current NodeLink build. For the requirements a client must implement to use NodeLink-specific capabilities, see [Minimum Client Requirements](https://nodelink.js.org/docs/minimum-client-requirements).

## What can it do?

Quite a bit happens between asking for a track and hearing it in a voice channel. NodeLink brings those pieces together, but you can start using it without learning the whole pipeline first.

- **Sources:** 52 source modules are present in the repository, with 49 enabled in the default configuration. Some provide playable streams directly; others resolve metadata and delegate audio retrieval. Credentials or provider-specific setup may still be required.
- **Audio processing:** decoding paths for Opus, AAC, MP3, FLAC, Ogg Vorbis, WAV/PCM and ALAC, followed by resampling and processing. The production runtime does not depend on FFmpeg.
- **Playback tools:** 19 filter implementations, layered audio mixing, ducking, fades and transition components. Their availability depends on the filter configuration and the relevant client support.
- **Worker-based execution:** in cluster mode, NodeLink distributes playback across workers. Each worker can own multiple players; it is not one process per player.
- **Extra capabilities:** lyrics, chapters, music meaning, SponsorBlock, incoming voice frames, YouTube live chat and stream access endpoints.
- **Monitoring:** Prometheus metrics and a built-in profiler interface for inspecting the running server.

The sections below show how these parts fit together. For the full set of options and feature-specific instructions, head to the [documentation](https://nodelink.js.org).

---

## Let's get you running

<table width="100%">
  <tr>
    <td width="126" align="center" valign="middle">
      <a href="https://tenor.com/view/lets-go-hype-penguin-pudgy-letsgo-gif-3716333242027244571">
        <img src="https://media1.tenor.com/m/M5MRZMYCfBsAAAAd/lets-go-hype.gif" width="112" alt="Pudgy Penguin cheering: let's go" />
      </a>
    </td>
    <td valign="middle">
      <p>Enough talking. Let's make some noise.</p>
      <p>NodeLink runs on Node.js and the default server port is <code>3000</code>. You can change the port and the rest of the server settings in your configuration file.</p>
    </td>
  </tr>
</table>

### Prerequisites

Before we start, make sure you have:

- **Node.js `>=22.22.2`**
- **Git**

### Clone the project

```bash
git clone https://github.com/PerformanC/NodeLink.git
cd NodeLink
```

### Install dependencies

```bash
npm install
```

### Create the configuration and start NodeLink

On Linux and macOS:

```bash
cp config.default.ts config.ts
npm run start
```

On Windows PowerShell:

```powershell
Copy-Item config.default.ts config.ts
npm run start
```

That's it. NodeLink will start using the settings in `config.ts`. To adjust sources, filters, workers, authentication or the listening address, take a look at the [Configuration Guide](https://nodelink.js.org/docs/config).

### Docker

The default container port is `3000`.

Using Docker Compose:

```bash
docker compose up -d
```

Or run a published image directly:

```bash
docker run -d --name nodelink -p 3000:3000 ghcr.io/performanc/nodelink:latest
```

For development builds:

```bash
docker run -d --name nodelink-dev -p 3000:3000 ghcr.io/performanc/nodelink:dev
```

For additional deployment details, use the [Configuration Guide](https://nodelink.js.org/docs/config).

---

## A little look under the hood

You don't need to know how every part works to use NodeLink. But if you're curious, here's the short version.

### Who does what?

NodeLink can run in a single process or in cluster mode. With clustering enabled, the work is split between the primary process and workers.

| Part | What happens there |
|---|---|
| **Primary process** | Handles HTTP, WebSocket connections, sessions, admission controls and worker coordination. |
| **Playback workers** | Own players and their audio pipelines, including decoding, DSP and Discord voice connections. One worker can handle multiple players. |
| **Specialized Source Worker** | An optional process for source-related work such as search, resolution and metadata tasks. |

The usual cluster path looks like this:

1. Your application connects to **NodeLink** through its HTTP API or WebSocket gateway.
2. In cluster mode, the primary process manages the session and routes player work to a **playback worker**.
3. The playback worker owns the player's audio pipeline and sends voice packets to **Discord**.
4. When enabled, the **Specialized Source Worker** handles supported search, resolution and metadata tasks, then returns the results to NodeLink.

The primary and playback workers communicate through local IPC sockets. Source-related tasks use the configured source-worker path when that component is enabled. In single-process mode, the server and playback components run together instead of being split across the cluster.

One important detail: restarting a worker is not the same as seamlessly recovering playback. The voice connection, decoder state and playback buffers live with the worker that owns the player. If that worker exits, audio in progress does not continue transparently; the client needs to reconnect voice and issue playback state again.

### Following a track through NodeLink

A track does not jump straight from a URL to Discord. NodeLink has to find the media, open the right kind of stream, extract its audio, turn it into a common processing format, and then prepare the output for a voice connection. Some sources take different routes through these stages, especially live streams and segmented media.

#### 1. Find and resolve the media

A request enters through NodeLink's API. The source manager selects a matching source module based on the identifier or search prefix. A source may return a playable stream itself, or it may return track information and hand audio retrieval to another source. Those are different jobs: resolving a title and its metadata does not necessarily mean that the same provider supplies the audio bytes.

When cluster mode and the specialized source worker are enabled, supported search, resolution, lyrics, chapters and other source-related tasks can be handled outside the playback worker. Otherwise, the work follows the configured in-process path.

#### 2. Open the stream

For ordinary HTTP media, NodeLink can read a progressive response or request specific byte ranges. The range path is used for seekable streams, so a seek does not always require downloading the entire file first. Local-file playback reads from the configured local base path.

Segmented streams have their own handling:

- **HLS:** NodeLink parses master and media playlists, fetches the referenced segments and includes an AES-128 decryption path for encrypted segments. The handler has paths for both VOD playlists and live playlists with a moving window.
- **DASH:** the DASH handler reads MPD manifests and handles fragmented MP4 media. The current implementation selects AAC-LC representations; do not assume every codec advertised by a DASH manifest is usable.

The stream processor also has to deal with buffering and backpressure. This keeps incoming data from being treated as if the complete media file were already available in memory.

#### 3. Read the container

A container is the package that holds the media tracks and their packets. NodeLink has separate demuxing paths for the containers it encounters:

- **MP4 / ISOBMFF / M4A / fragmented MP4:** handled with `mp4box`, including extraction of AAC and Opus samples.
- **WebM / Matroska:** the WebM demuxer extracts Opus packets from the container blocks.
- **FLV:** the FLV demuxer reads audio tags containing AAC or MP3 data.
- **Ogg:** packet handling is used for Ogg streams containing Vorbis or Opus.

This is why container and codec names should not be mixed. MP4, WebM, FLV and Ogg describe how media is packaged; AAC, Opus, MP3 and Vorbis describe how audio is encoded.

#### 4. Decode the audio

After demuxing, the encoded audio packets are sent to the decoder that handles that codec. The current code contains these decoding paths:

| Audio codec / format | Decoder used |
|---|---|
| Opus | `@toddynnn/voice-opus` |
| AAC | `@ecliptia/faad2-wasm` (FAAD2 compiled to WebAssembly) |
| MP3, FLAC, Ogg Vorbis, WAV/PCM and ALAC | `@toddynnn/symphonia-decoder` |

These are the implementations present in the codebase. The list is not a claim that every possible profile, malformed file or provider stream has been tested.

#### 5. Convert to the processing format

The processing path uses **48 kHz, stereo, signed 16-bit little-endian PCM**. Inputs with a different sample rate are resampled using `@alexanderolsen/libsamplerate-js`, which is compiled to WebAssembly. Bringing decoded audio to a common format lets the filters and mixer work on the same kind of samples instead of having to handle every source format separately.

#### 6. Apply playback processing

The PCM stream can pass through the enabled DSP filters and playback components. The filter engine includes equalization, timescale changes, tremolo, vibrato, karaoke, channel mixing, low-pass and high-pass filtering, chorus, compression, echo, phaser and other implementations. Timescale processing uses a WSOLA-based path; animated filter transitions can interpolate parameter changes instead of switching every value abruptly.

The playback path also contains layered audio mixing, ducking, fades and transition components. The mixer combines additional audio layers into a player's output. Ducking can reduce the music level when incoming voice activity is detected. Which components are available to a client depends on the server configuration and the client's implementation.

#### 7. Encode and send to Discord

The processed PCM is encoded to **Opus** using `@toddynnn/voice-opus`. The encoded frames are handed to NodeLink's voice transport, which handles the Discord voice connection and sends the packets over the encrypted UDP voice path.

At 48 kHz, a 20 ms PCM frame contains 960 samples per channel. In the internal 16-bit stereo format, that is 3,840 bytes before Opus compression. The stream processor's configured `highWaterMark` is 19,200 bytes — five of those PCM frames — and backpressure helps keep one stage from overwhelming the next. Opus encoder complexity can be adjusted through `playback.audio.opusComplexity` (default: `6`).

The production audio path is built from JavaScript/TypeScript, native modules and WebAssembly. **FFmpeg is not part of the production runtime.**

### Audio processing

The filter engine includes implementations for:

`Equalizer · Timescale · Tremolo · Vibrato · Rotation · Karaoke · Distortion · Channel Mix · Low-pass · High-pass · Chorus · Compressor · Echo · Phaser · Spatial · Reverb · Flanger · Phonograph · Tesseract`

The filter registry and the default configuration are not the same list. Some implementations are registered in the engine without appearing as default-enabled configuration options, so check the current configuration and API information before assuming a filter is exposed in a fresh installation.

NodeLink also contains components for layered mixing, ducking, fades and transitions. Features such as Audio Mixer, Voice Receive and SponsorBlock have their own configuration and client-side requirements; they are not automatically available to every client.

### Sources are not all the same

The source modules cover music services, video platforms, live streams, local files, HTTP URLs, podcasts and text-to-speech providers.

Some sources provide a playable stream directly. Others resolve a track's metadata and delegate audio retrieval to another source. Finding a track in a provider's catalog does not necessarily mean that provider is delivering the audio bytes.

The default configuration enables 49 of the 52 source modules in the repository. Providers may still require credentials, cookies, tokens, external services or extra configuration. Third-party changes can also affect availability. The [Configuration Guide](https://nodelink.js.org/docs/config) lists the provider-specific options.

---

## Beyond playing a single track

Playback is the main job, but it is not the only thing NodeLink can do. A few parts of the server work alongside the player and make it possible to build richer audio experiences.

### Music information

NodeLink can retrieve synchronized or plain lyrics through `/v4/loadlyrics`, request chapter information through `/v4/loadchapters`, and expose music-meaning information through `/v4/meaning`. Clients that implement the lyrics subscription flow can receive timed lyric updates over WebSocket instead of repeatedly polling for the next line.

### More than one audio layer

The **Audio Mixer** lets a client add and control extra audio layers in a player's output. That can be used for things like background audio or overlapping sounds without treating every layer as a separate Discord player. The playback components also include ducking, fades and transitions; availability depends on the relevant configuration and client support.

### Live audio and incoming voice

For supported YouTube streams, NodeLink can expose live-chat messages. The **Voice Receive** endpoint provides a way to receive incoming voice frames from a Discord voice connection. The client still needs to implement the receive-side WebSocket flow; opening the endpoint alone does not make an application process or record the audio.

### Streams, skipping and diagnostics

The `/v4/trackstream` and `/v4/loadstream` endpoints expose separate track and raw-stream paths. SponsorBlock can retrieve and skip configured segment categories for supported YouTube tracks. For debugging the server itself, the profiler endpoints and web interface provide runtime inspection tools.

These capabilities belong to NodeLink's extended API. Some need to be enabled in `config.ts`, and clients must implement the corresponding request, event or WebSocket behavior before they can use them.

## Monitoring and diagnostics

NodeLink exposes Prometheus metrics at `GET /v4/metrics`. The `prom-client` package is already included as a production dependency; there is no separate installation step.

Metrics availability is controlled by configuration, and the endpoint uses the configured authorization. The registry includes metrics related to API requests, sources, players, workers, memory, CPU and audio-frame counters.

The [Troubleshooting guide](https://nodelink.js.org/docs/troubleshooting) is a good place to start when something doesn't behave as expected.

---

## Dependencies

NodeLink uses a small set of focused packages for voice transport, decoding, resampling, stream handling and server utilities. Several are maintained by the people and projects around NodeLink; the rest are upstream libraries we build on.

- [`@performanc/pwsl-server`](https://github.com/PerformanC/internals/tree/PWSL-server) — PerformanC's WebSocket server layer. **Maintained by PerformanC.**
- [`@performanc/voice`](https://github.com/PerformanC/voice) — Discord voice connections and voice packet transport. **Maintained by PerformanC.**
- [`@ecliptia/faad2-wasm`](https://www.npmjs.com/package/@ecliptia/faad2-wasm) — AAC decoding through the FAAD2 WebAssembly build. **Published under the Ecliptia scope.**
- [`@ecliptia/seekable-stream`](https://github.com/1Lucas1apk/seekable-stream) — seekable HTTP streams and byte-range handling. **Ecliptia package; source maintained in the 1Lucas1apk repository.**
- [`@toddynnn/symphonia-decoder`](https://www.npmjs.com/package/@toddynnn/symphonia-decoder) — audio decoding for formats handled by the Symphonia-based module. **Published under the `@toddynnn` npm scope.**
- [`@toddynnn/voice-opus`](https://www.npmjs.com/package/@toddynnn/voice-opus) — Opus encoding and decoding used by the audio path. **Published under the `@toddynnn` npm scope.**
- [`@alexanderolsen/libsamplerate-js`](https://www.npmjs.com/package/@alexanderolsen/libsamplerate-js) — sample-rate conversion. **Upstream project:** [aolsenjazz/libsamplerate-js](https://github.com/aolsenjazz/libsamplerate-js).
- [`fastest-validator`](https://www.npmjs.com/package/fastest-validator) — configuration and data validation. **Upstream project:** [icebob/fastest-validator](https://github.com/icebob/fastest-validator).
- [`mp4box`](https://www.npmjs.com/package/mp4box) — MP4 / ISOBMFF parsing and sample extraction. **Upstream project:** [GPAC/MP4Box.js](https://github.com/gpac/mp4box.js).
- [`prom-client`](https://www.npmjs.com/package/prom-client) — Prometheus metrics collection and exposition. **Upstream project:** [siimon/prom-client](https://github.com/siimon/prom-client).
- [`proxy-agent`](https://www.npmjs.com/package/proxy-agent) — proxy-agent support for HTTP requests. **Upstream project:** [TooTallNate/proxy-agents](https://github.com/TooTallNate/proxy-agents).

All packages above are regular runtime dependencies in `package.json`; `prom-client` does not need to be installed separately. Development tools such as TypeScript, Biome, Husky and the Node.js/Bun type definitions are listed under `devDependencies`.

---

## Configuration, API, and more

The README is the starting point. The documentation goes deeper when you need the full list of options or request details.

- [Configuration](https://nodelink.js.org/docs/config) — server settings, sources, filters, workers, security and metrics.
- [API Reference](https://nodelink.js.org/docs/api/rest) — REST endpoints and request details.
- [Community Plugins](https://nodelink.js.org/docs/plugins) — extend NodeLink with community-maintained plugins.
- [NodeLink vs Lavalink](https://nodelink.js.org/docs/differences) — where the APIs and features differ.
- [Minimum Client Requirements](https://nodelink.js.org/docs/minimum-client-requirements) — what a client needs for official NodeLink compatibility.
- [Troubleshooting](https://nodelink.js.org/docs/troubleshooting) — common problems and things to check.

## Development

Want to run the project from source or help improve it? These are the scripts defined in `package.json`:

```bash
npm run start       # Start from source
npm run build       # Compile TypeScript
npm run type-check  # Check types without emitting build output
```

The project requires Node.js `>=22.22.2`. Source-specific test tooling is available under `scripts/`; check the script and provider setup before running live source checks.

## Contributing

Found something broken? Have an idea? Want to improve a source, add a filter, work on documentation, or just understand how a part of NodeLink works?

Issues and pull requests are welcome. Start with the [issue tracker](https://github.com/PerformanC/NodeLink/issues) or reach out through the community servers below.

A huge thank you to **@RainyXeon** for allowing us to incorporate NicoVideo streaming logic from [LunaStream](https://github.com/LunaStream/LunaStream).

## Community & support

- [PerformanC Discord](https://discord.gg/uPveNfTuCJ)
- [Ecliptia "Imagine" Discord](https://discord.gg/fzjksWS65v)
- [Official documentation](https://nodelink.js.org)

## License

NodeLink is open-source software released under the **GNU General Public License v3.0**. See [LICENSE](LICENSE) for the full text.

---

<p align="center">
  <strong>Made with love by Brazilian developers. 🇧🇷</strong><br />
  <sub>Curiosity brought us here. There's room for you too.</sub><br />
  <sub>Interested in joining the team? Get in touch through the <a href="https://discord.gg/uPveNfTuCJ">PerformanC Discord</a> or the <a href="https://discord.gg/fzjksWS65v">Ecliptia Discord</a>.</sub>
</p>

<p align="center">
  <a href="https://www.star-history.com/?type=date&legend=top-left&repos=PerformanC%2FNodeLink">
    <img src="https://api.star-history.com/chart?repos=PerformanC/NodeLink&type=date&legend=top-left&sealed_token=XCnlJLyDMBYhi2jvz_T_9ZG1JGfFOuLiQXVI2eYOAS-bnQo7aWEzdUoLIymUZfQ1aGvTWSpIdnARPvaUHJBHMC-7HJtJT5DbPVBJcGBl8p2lD3ckEEL84g" alt="NodeLink star history" />
  </a>
</p>

<p align="center">
  <sub>GIFs by Pudgy Penguins, embedded from Tenor. Click a GIF to visit its source.</sub>
</p>
