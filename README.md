# NodeLink

![NodeLink logo](images/Nodelink.png "NodeLink")

LavaLink-protocol compatible standalone audio-sending node using Node.js.

 ## Star, Fork History and People
 
 <a href="https://star-history.com/#PerformanC/NodeLink&Date">
   <picture>
     <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=PerformanC/NodeLink&type=Date&theme=dark" />
     <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=PerformanC/NodeLink&type=Date" />
     <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=PerformanC/NodeLink&type=Date" />
   </picture> 
 </a>

 [![Stargazers repo roster for @PerformanC/NodeLink](http://reporoster.com/stars/dark/PerformanC/NodeLink)](https://github.com/PerformanC/NodeLink/stargazers)

 [![Forkers repo roster for @PerformanC/NodeLink](http://reporoster.com/forks/dark/PerformanC/NodeLink)](https://github.com/PerformanC/NodeLink/network/members)

## LavaLink API coverage

- [x] Events
- [x] Filters
- [x] Endpoints, except route planner
- [x] LoadTracks endpoint, without Vimeo and Twitch.
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

> [!NOTE]
> Master means that it can directly play from the source, without using other source to get its stream.

## NodeLink vs Lavalink

### Performance

Because of how NodeLink works, handling audio in real-time and directly accessing services, without using any external packages, NodeLink is faster than LavaLink in both filtering and track loading.

### Stability

LavaLink, as a modular project, is more stable than NodeLink. We're working on making NodeLink more stable, but this is a fact.

### Resource usage

JVM itself requires a lot of resources, but not only that, LavaLink caches a lot of data, and it's not very resource-friendly.

NodeLink is written in Node.js, using low-level libraries, which allows NodeLink to be more resource-friendly than LavaLink.

CPU usage is not a factor, because both NodeLink and LavaLink use the same amount of CPU.

### Features

As a new project, but already old enough to have all the features LavaLink has, NodeLink has all the features LavaLink has, and more.

LavaLink on the other hand, has plugins, which allows it to have more features than NodeLink, but NodeLink is more customizable than LavaLink, and it's easier to add features to NodeLink than LavaLink as everything is written in one place.

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
$ npm i
```

> [!WARNING]
> node-crc is one of the dependencies of NodeLink, and it requires a `cargo` installation.

> [!NOTE]
> [`sodium-native`](https://npmjs.com/package/sodium-native) dependency can be replaced with alternatives like [`libsodium-wrappers`](https://npmjs.com/package/libsodium-wrappers).
>
> [`opusscript`](https://npmjs.com/package/opusscript) dependency can be replaced with alternatives like [`@discordjs/opus`](https://npmjs.com/package/@discordjs/opus).
>
> [`ffmpeg`](https://ffmpeg.org/) is required. [`ffmpeg-static`](https://npmjs.com/package/ffmpeg-static) is also supported.

### Running

To run NodeLink, you need to run the following command in the root directory of NodeLink.

```bash
$ npm start
```

And done, you have successfully started NodeLink, and you will be able to connect to it using any Lavalink wrapper.

## Support & Feedback

If you have any questions, or only want to give a feedback, about NodeLink or any other PerformanC project, join [our Discord server](https://discord.gg/uPveNfTuCJ).

## License

NodeLink is licensed under PerformanC's License, which is a modified version of the MIT License, focusing on the protection of the source code and the rights of the PerformanC team over the source code.

## Contributors

* [ThePedroo](https://github.com/ThePedroo) - PerformanC lead developer
* [TehPig](https://github.com/TehPig) - Tester and contributor
