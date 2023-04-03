# NodeLink

[![Discord Server](https://img.shields.io/discord/1036045973039890522?color=5865F2&logo=discord&logoColor=white)](https://discord.gg/YcaK3puy49)

NodeLink is a fast and light-weight Lavalink based (v4) audio sending node.

## Features

- Fast and light-weight
- Easy to modify
- Instant boot up

## Lavalink features coverage

- [x] Events (ALL)
- [x] LoadTracks endpoint (Spotify: yes (built-in), YouTube: yes, SoundCloud: yes, Deezer: yes, Bandcamp: partial, Vimeo: no, Twitch: no, HTTP: yes, Local: yes)
- [x] Track(s) encoding (NodeLink-only endpoint)
- [x] Version endpoint
- [x] Track(s) decoding
- [x] Resume system
- [ ] Info endpoint
- [ ] Filters
- [ ] Router planner API

## Recommended Lavalink wrappers

You can use any Lavalink wrapper that supports the Lavalink v4 API, but we recommend using our own wrapper, [Coglink](https://github.com/PerformanC/Coglink), which is a wrapper for the Concord library.

## Usage

NodeLink is easy to use, just follow the steps below.

### Before continuing

Before we continue, you need to have [Node.js](https://nodejs.org/en/) installed on your machine, at least version 16.9.0 is required to run NodeLink.

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

### Configuration

A small list of configurable settings, config.js, can be located in the root directory of NodeLink.

#### Server

* Port: The port on which NodeLink will listen for connections.
* Password: The password that will be required to connect to NodeLink.

#### Options

* Threshold: How much time in milliseconds should NodeLink wait to do an action before disconnecting from a voice channel.
* playerUpdateInterval: How much time in milliseconds should NodeLink wait before sending state to the client.
* statsInterval: How much time in milliseconds should NodeLink wait before sending stats to the client.
* maxResults: The maximum number of results that NodeLink will return from a search.

#### Debug

* showReqBody: If true, NodeLink will log the received body from the requests.

#### Search

* defaultSearchSource: The default search source that will be used when searching for a track from a source that can't be played directly, supported are: youtube, SoundCloud and BandCamp.
* sources: A list of sources that NodeLink will use to search for tracks, you can enable or disable each source, and to enable SoundCloud, you need to get a client ID from [here](https://soundcloud.com/you/apps).

### Running

To run NodeLink, you need to run the following command in the root directory of NodeLink.

```bash
$ node index.js
```

And done, you have successfully started NodeLink, and you will be able to connect to it using any Lavalink wrapper.

**REMEMBER: NodeLink uses the endpoints and JSON responses of the Lavalink v4 API, so you need to use a Lavalink wrapper that supports v4.**

## License

NodeLink uses a customized license created by PerformanC, which has the same rights as a MIT license, except it includes a clause stating that you cannot use this software to train a neural network.
