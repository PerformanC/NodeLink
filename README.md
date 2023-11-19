# NodeLink

![NodeLink logo](images/Nodelink.png "NodeLink")

Lavalink protocol compatible music sending node using Node.js.

## Lavalink compatibility

- [x] All events and filters
- [x] All endpoints (Router planner API: no)
- [x] LoadTracks endpoint (Unsupported & additional: Pandora: yes, Deezer: yes, Vimeo: no, Twitch: no)
- [x] Track(s) encoding & loadCaptions (NodeLink-only endpoint)
- [x] Resume system

## Sources

- [x] BandCamp: Master
- [x] Deezer: Master
- [x] HTTP: Master
- [x] Local: Master
- [x] Pandora: Master dependant
- [x] SoundCloud: Master
- [x] Spotify: Master dependant
- [x] YouTube: Master
- [x] YouTube Music: Master

**Obs.:** Master means that it can directly play from the source, without using other source to get its stream.

## NodeLink vs Lavalink

NodeLink is a music-sending node that follows LavaLink protocols, it uses `@discordjs/voice` and `ffmpeg` to send audio to Discord, while LavaLink uses `Lavaplayer` and `Koe`.

### Performance

While NodeLink outperforms LavaLink in scenarios like filtering, LavaLink outperforms when it comes to loading tracks, but it's a negligible difference.

It comes to preference in this aspect, as NodeLink will be extremely faster than LavaLink in filtering, but LavaLink will be faster than NodeLink in loading tracks.

### Stability

Because of LavaLink is an older project, it's more stable than NodeLink, but NodeLink is still stable, and we're always working to make it more stable.

### Resource usage

Because of Java's memory management, LavaLink uses more resources than NodeLink, and it's more resource-intensive, while NodeLink is more resource-friendly, and it can be run on low-end machines.

### Features

NodeLink has more features than LavaLink, like the ability to encode tracks, and the ability to load captions from YouTube videos, and it's also more customizable than LavaLink.

Although LavaLink with plugins will have more features than NodeLink, NodeLink is more customizable than LavaLink, and it's easier to add features to NodeLink than LavaLink.

## Usage

### Minimum requirements

- [Node.js](https://nodejs.org) 16.6.0 or higher
- FFmpeg or ffmpeg-static
- v4 compatible Lavalink wrapper for usage

### Recommended requirements

- [Node.js](https://nodejs.org) latest
- FFmpeg
- [FastLink](https://github.com/PerformanC/FastLink)

### Installation

**Obs.:** node-crc, NodeLink dependency for audio receive, requires a `cargo` (`rustup`) installation.

To install NodeLink, you must clone the repository and install the dependencies.

```bash
$ git clone https://github.com/PerformanC/NodeLink
$ cd NodeLink
$ npm i
```

You can replace the [`sodium-native`](https://npmjs.com/package/sodium-native) dependency with alternatives like [`libsodium-wrappers`](https://npmjs.com/package/libsodium-wrappers) in the [`package.json`](package.json) file.

You can also replace the [`@discordjs/opus`](https://npmjs.com/package/@discordjs/opus) dependency with alternatives like [`opusscript`](https://npmjs.com/package/opusscript).

For filtering, you will need to install [`ffmpeg`](https://ffmpeg.org/) on your system, and you can install it using [`ffmpeg-static`](https://npmjs.com/package/ffmpeg-static) through npm.

### Running

To run NodeLink, you need to run the following command in the root directory of NodeLink.

```bash
$ npm start
```

And done, you have successfully started NodeLink, and you will be able to connect to it using any Lavalink wrapper.

## Discord Server & Feedback

If you have any questions about NodeLink or any other PerformanC project, or only want to give a feedback about our projects, join [our Discord server](https://discord.gg/uPveNfTuCJ).

## License

NodeLink is licensed under PerformanC's License, which is a modified version of the MIT License, focusing on the protection of the source code and the rights of the PerformanC team over the source code.

If you wish to use some part of the source code, you must contact us first, and if we agree, you can use the source code, but you must give us credit for the source code you use.

## Contributors

* [ThePedroo](https://github.com/ThePedroo) - PerformanC lead developer
* [TehPig](https://github.com/TehPig) - Tester and contributor
