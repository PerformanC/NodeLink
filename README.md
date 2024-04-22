# NodeLink

Performant LavaLink replacement written in Node.js.

## Features

- Lightweight
- Real-time audio processing
- Direct source access
- Anonymous by default

## Dependencies

- [`@performanc/pwsl-server](https://github.com/PerformanC/internals/tree/PWSL-server)
- [`@performanc/voice`](https://npmjs.com/package/@performanc/voice)
- [`prism-media`](https://npmjs.com/package/prism-media)
- [`opusscript`](https://npmjs.com/package/opusscript) or [`@discordjs/opus`](https://npmjs.com/package/@discordjs/opus)
- [`libsodium-wrappers`](https://npmjs.com/package/libsodium-wrappers) or [`sodium-native`](https://npmjs.com/package/sodium-native) or [`tweetnacl`](https://npmjs.com/package/tweetnacl)

## Installation

### 1. Clone the repository

```shell
$ git clone https://github.com/PerformanC/NodeLink
$ cd NodeLink
```

### 2. Install the dependencies

```shell
$ npm i
```

> [!NOTE]
> If you to use pure JavaScript, replace `sodium-native` with `libsodium-wrappers`. Keep in mind that pure JavaScript will offer a worse performance.

### 3. Run NodeLink

```shell
$ npm start
```

### Using with Docker
For information on how to install NodeLink using Docker, see [the NodeLink Docker guide](docs/docker.md).

## Usage

NodeLink is compatible with most LavaLink clients, as it implements most of the LavaLink API. However, some clients may not be compatible with NodeLink, as it implements changes some behaviors and endpoints.

| Client                                                              | Platform     | v2 supported?   | NodeLink Features?  | NodeLink major version |
| --------------------------------------------------------------------|--------------|-----------------|---------------------|------------------------|
| [Lavalink-Client](https://github.com/lavalink-devs/Lavalink-Client) | JVM          | Yes             | No                  | v1 and v2              |
| [Lavalink.kt](https://github.com/DRSchlaubi/Lavalink.kt)            | Kotlin       | No              | No                  | v1                     |
| [DisGoLink](https://github.com/disgoorg/disgolink)                  | Go           | Yes             | No                  | v1 and v2              |
| [Lavalink.py](https://github.com/devoxin/lavalink.py)               | Python       | Yes             | No                  | v1 and v2              |
| [Mafic](https://github.com/ooliver1/mafic)                          | Python       | Yes             | No                  | v1 and v2              |
| [Wavelink](https://github.com/PythonistaGuild/Wavelink)             | Python       | Yes             | No                  | v1 and v2              |
| [Pomice](https://github.com/cloudwithax/pomice)                     | Python       | Yes             | No                  | v1 and v2              |
| [Hikari-ongaku](https://github.com/MPlatypus/hikari-ongaku)         | Python       | Yes             | No                  | v1 and v2              |
| [Moonlink.js](https://github.com/1Lucas1apk/moonlink.js)            | Typescript   | Yes             | Partial             | v1 and v2              |
| [Magmastream](https://github.com/Blackfort-Hosting/magmastream)     | Typescript   | No              | No                  | v1                     |
| [Lavacord](https://github.com/lavacord/Lavacord)                    | Typescript   | Yes             | No                  | v1 and v2              |
| [Shoukaku](https://github.com/Deivu/Shoukaku)                       | Typescript   | Yes             | No                  | v1 and v2              |
| [Lavalink-Client](https://github.com/tomato6966/Lavalink-Client)    | Typescript   | No              | No                  | v1                     |
| [FastLink](https://github.com/PerformanC/FastLink)                  | Node.js      | Yes             | Yes                 | v1 and v2              |
| [Rainlink](https://github.com/RainyXeon/Rainlink)                   | Node.js      | Yes             | Yes                 | v1 and v2              |
| [Riffy](https://github.com/riffy-team/riffy)                        | Node.js      | Yes             | No                  | v1 and v2              |
| [TsumiLink](https://github.com/Fyphen1223/TsumiLink)                | Node.js      | Yes             | Partial (No comp)   | v1 and v2              |
| [DisCatSharp](https://github.com/Aiko-IT-Systems/DisCatSharp)       | .NET         | Yes             | No                  | v1 and v2              |
| [Lavalink4NET](https://github.com/angelobreuer/Lavalink4NET)        | .NET         | Yes             | No                  | v1 and v2              |
| [Nomia](https://github.com/DHCPCD9/Nomia)                           | .NET         | Yes             | No                  | v1 and v2              |
| [CogLink](https://github.com/PerformanC/Coglink)                    | C            | Yes             | No                  | v1 and v2              |
| [Lavalink-rs](https://gitlab.com/vicky5124/lavalink-rs)             | Rust, Python | Yes             | No                  | v1 and v2              |
| [nyxx_lavalink](https://github.com/nyxx-discord/nyxx_lavalink)      | Dart         | No              | No                  | v1                     |

> [!NOTE]
> The data is gotten from [LavaLink documentation](https://lavalink.dev/clients#client-libraries), updated with manual checks.

## Documentation

NodeLink only [documents the differences between LavaLink and NodeLink](docs/API.md). For the rest of the documentation, please refer to [LavaLink's documentation](https://lavalink.dev/api/index.html).

## Troubleshoot

### "Expected 200, received 403." error

In some regions like Europe, you may receive a 403 error when trying to connect to YouTube. The real reason is unknown, but The PerformanC team managed to create a proper workaround for this issue.

To fix this issue, you must login to your Google/YouTube account. The proccess of retrieving the neccessary information is explained in [config.js](config.js) file.

## Support

Any question or issue related to NodeLink or other PerformanC projects can be can be made in [PerformanC's Discord server](https://discord.gg/uPveNfTuCJ).

For verified issues, please also create a GitHub issue for tracking the issue.

## Contributing & Code of Conduct

NodeLink follows the PerformanC's [contribution guidelines](https://github.com/PerformanC/contributing). It is necessary to follow the guidelines to contribute to NodeLink and other PerformanC projects.

## License

NodeLink is licensed under [BSD 2-Clause License](LICENSE). You can read more about it on [Open Source Initiative](https://opensource.org/licenses/BSD-2-Clause).

* This project is considered as: [standard compliant](https://github.com/PerformanC/contributing?tab=readme-ov-file#project-information).
