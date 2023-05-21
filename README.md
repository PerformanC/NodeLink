# NodeLink

![alt text](images/Nodelink.png "NodeLink")

Performant and efficient audio-sending node using Node.js.

## Lavalink compatibility

- [x] All events and filters
- [x] All endpoints (Router planner API: no)
- [x] LoadTracks endpoint (Unsupported & additional: Pandora: yes, Vimeo: no, Twitch: no)
- [x] Track(s) encoding & loadCaptions (NodeLink-only endpoint)
- [x] Resume system

## NodeLink vs Lavalink

NodeLink is a Lavalink-compatible node, using [`@discordjs/voice`](https://npmjs.com/package/@discordjs/voice), [`ffmpeg`](https://ffmpeg.org/) to send audio to Discord, while Lavalink uses [`Java`](https://www.java.com), [`Lavaplayer`](https://github.com/sedmelluq/lavaplayer), and [`Koe`](https://github.com/KyokoBot/koe) to send audio.

NodeLink is built to be more efficient than LavaLink, and to be more resource-friendly, allowing it to be run on low-end machines, while LavaLink requires a machine with at least 200MB of ram to run without forcing the [GC](https://en.wikipedia.org/wiki/Garbage_collection_(computer_science)) to deallocate memory.

NodeLink uses its own systems to retrieve tracks, while LavaLink uses Lavaplayer to retrieve tracks, this allows NodeLink to be more efficient since it's built-in to NodeLink, and it's not an external dependency.

Lavalink was built for stability, NodeLink was for performance, and even then, we're limited by Node.js, since it doesn't support [QUIC](https://en.wikipedia.org/wiki/QUIC), which is crucial for NodeLink to be faster than Lavalink, but for resource-intensive actions, like filtering, NodeLink is faster than Lavalink.

Both have different goals and depending on your needs, you should use one or another.

## Usage

NodeLink is powered by [Node.js](https://nodejs.org), so you will need to have it installed on your system, with the minimum requirement of having version 16.6.0 installed.

### Installation

To install NodeLink, you need to clone the repository and install the dependencies.

```bash
$ git clone https://github.com/PerformanC/NodeLink
$ cd NodeLink
$ npm install @discordjs/voice @discordjs/opus sodium-native ws
```

You can replace the [`sodium-native`](https://npmjs.com/package/sodium-native) dependency with alternatives like [`libsodium-wrappers`](https://npmjs.com/package/libsodium-wrappers).

For filtering, you will need to install [`ffmpeg`](https://ffmpeg.org/) on your system, and you can install it using [`ffmpeg-static`](https://npmjs.com/package/ffmpeg-static) through npm.

### Running

To run NodeLink, you need to run the following command in the root directory of NodeLink.

```bash
$ npm start
```

And done, you have successfully started NodeLink, and you will be able to connect to it using any Lavalink wrapper.

## License

NodeLink is licensed under PerformanC's License, which is a modified version of the MIT License, focusing on the protection of the source code and the rights of the PerformanC team over the source code.

If you wish to use some part of the source code, you must contact us first, and if we agree, you can use the source code, but you must give us credit for the source code you use.

## Contributors

* [ThePedroo](https://github.com/ThePedroo) - PerformanC lead developer
* [TehPig](https://github.com/TehPig) - Tester and contributor
