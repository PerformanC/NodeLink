# NodeLink

![alt text](images/Nodelink.png "NodeLink")

Performant and efficient audio-sending node using Node.js.

## Lavalink compatibility

- [x] All events and filters
- [x] All endpoints (Router planner API: no)
- [x] LoadTracks endpoint (...: yes, Bandcamp: yes, Pandora: yes, Vimeo: no, Twitch: no, HTTP: yes, Local: yes)
- [x] Track(s) encoding (NodeLink-only endpoint)
- [x] Resume system

## NodeLink vs Lavalink

NodeLink is a Lavalink-compatible node, using [`@discordjs/voice`](https://npmjs.com/package/@discordjs/voice), [`ffmpeg`](https://ffmpeg.org/) to send audio to Discord, while Lavalink uses Java, [`Lavaplayer`](https://github.com/sedmelluq/lavaplayer), and [`Koe`](https://github.com/KyokoBot/koe) to send audio.

NodeLink uses way less RAM than Lavalink, and this is a benefit for people who want to host a node on a machine with low RAM, but NodeLink is not as fast as Lavalink when the client doesn't completely support compression, and NodeLink isn't as stable as Lavalink.

NodeLink comes with more features and configurations than Lavalink, for example, the getCaptions endpoint, which allows directly to get the captions of a youtube track, without having to get them from other APIs.

Lavalink has a more stable filter system, but NodeLink has a way faster one (with a difference of 1-2s depending on the speed of the machine).

NodeLink can be easily modified, and easily understood, while Lavalink is a bit more complicated to understand, and to modify due to the number of dependencies it uses. 

## Usage

NodeLink is powered by [Node.js](https://nodejs.org), so you will need to have it installed on your system, with the minimum requirement of having version 16.9.0 installed.

### Installation

To install NodeLink, you need to clone the repository and install the dependencies.

```bash
$ git clone https://github.com/PerformanC/NodeLink
$ cd NodeLink
$ npm install @discordjs/voice @discordjs/opus libsodium-wrappers ws
```

You can also replace [`@discordjs/opus`](https://npmjs.com/package/@discordjs/opus) with [`opusscript`](https://npmjs.com/package/opusscript) if you don't want to use @discordjs/opus. (We can also use [`node-opus`](https://npmjs.com/package/node-opus), but since it's deprecated, the usage is not recommended)

For the [`libsodium-wrappers`](https://npmjs.com/package/libsodium-wrappers) dependency, you can also use its alternatives, like [`sodium-native`](https://npmjs.com/package/sodium-native).

For filtering, you will need to install [`ffmpeg`](https://ffmpeg.org/) on your system, and you can install it using [`ffmpeg-static`](https://npmjs.com/package/ffmpeg-static) through npm.

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
