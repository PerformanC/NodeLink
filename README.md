# NodeLink

![alt text](images/Nodelink.png "NodeLink")

NodeLink is a fast and lightweight Lavalink based audio-sending node.

## Features

- Fast and light-weight
- Easy to modify
- Instant boot up

## Lavalink features coverage

- [x] Events (ALL)
- [x] LoadTracks endpoint (Spotify: yes, YouTube: yes, SoundCloud: yes, Deezer: yes, Bandcamp: yes, Pandora: yes, Vimeo: no, Twitch: no, HTTP: yes, Local: yes)
- [x] Track(s) encoding (NodeLink-only endpoint)
- [x] Version endpoint
- [x] Track(s) decoding
- [x] Resume system
- [x] Filters (ALL)
- [ ] Info endpoint
- [ ] Router planner API

## Recommended Lavalink wrappers

You can use any Lavalink wrapper that supports the Lavalink v4 API, but we recommend using our own wrapper, [Coglink](https://github.com/PerformanC/Coglink), which is a wrapper of NodeLink/Lavalink for the Concord library.

## Usage

### Before continuing

Before we continue, you need to have [Node.js](https://nodejs.org) installed on your machine, at least version 16.9.0 is required to run NodeLink.

### Installation

To install NodeLink, you need to clone the repository and install the dependencies.

```bash
$ git clone https://github.com/PerformanC/NodeLink
$ cd NodeLink
$ npm install @discordjs/voice @discordjs/opus libsodium-wrappers ws
```

And if you don't have `ffmpeg` installed on your environment:

```bash
$ npm install ffmpeg-static
```

### Running

To run NodeLink, you need to run the following command in the root directory of NodeLink.

```bash
$ node index.js
```

And done, you have successfully started NodeLink, and you will be able to connect to it using any Lavalink wrapper.

## License

NodeLink is licensed under PerformanC's License, which is a modified version of the MIT License, focusing on the protection of the source code and the rights of the PerformanC team over the source code.

If you wish to use some part of the source code, you must contact us first, and if we agree, you can use the source code, but you must give us credit for the source code you use.

## Contributors

* [ThePedroo](https://github.com/ThePedroo) - PerformanC lead developer
* [TehPig](https://github.com/TehPig) - Tester and contributor
