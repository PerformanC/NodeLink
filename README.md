# NodeLink

[![Discord Server](https://img.shields.io/discord/1036045973039890522?color=5865F2&logo=discord&logoColor=white)](https://discord.gg/YcaK3puy49)

NodeLink is a fast and light-weight Lavalink based (v4) audio sending node.

## Features

- Fast and light-weight
- Easy to modify
- Fast to boot up

## Lavalink features coverage

- [x] Stats event
- [x] Stats endpoint
- [x] State event
- [x] PlayerUpdate event
- [x] TrackStart event
- [x] TrackEnd event
- [x] TrackException event
- [x] TrackStuck event
- [x] WebSocketClosed event
- [x] LoadTracks endpoint (noReplace: yes, playlist & others: no)
- [x] Track(s) encoding (NodeLink-only endpoint)
- [x] Version endpoint
- [ ] Info endpoint
- [ ] Filters
- [ ] Resume system
- [ ] Track(s) decoding
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

### Configuration

A small list of configurable settings, config.js, located in the root directory of NodeLink.

* Port: The port on which NodeLink will listen for connections.
* Password: The password that will be required to connect to NodeLink.
* Threshold: How much time in milliseconds should NodeLink wait to do an action before disconnecting from a voice channel.
* stateInterval: How much time in milliseconds should NodeLink wait before sending state to the client.
* statsInterval: How much time in milliseconds should NodeLink wait before sending stats to the client.

### Running

To run NodeLink, you need to run the following command in the root directory of NodeLink.

```bash
$ node index.js
```

And done, you have successfully started NodeLink, and you will be able to connect to it using any Lavalink wrapper.

**REMEMBER: NodeLink uses the endpoints and JSON responses of the Lavalink v4 API, so you need to use a Lavalink wrapper that supports v4.**

## License

NodeLink uses a customized license created by PerformanC, which has the same rights as a MIT license, except it includes a clause stating that you cannot use this software to train a neural network.
