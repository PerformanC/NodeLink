# API documentation

Documents the differences the API changes compared to LavaLink API, the API design used in NodeLink.

## Table of contents

- [Events](#events)
  - [TrackStartEvent](#trackstartevent)
- [Filters](#filters)
  - [Stack filters](#stack-filters)
- [Endpoints](#endpoints)
  - [Compression](#compression)
  - [Websocket connection](#websocket-connection)
  - [Errors](#errors)
  - [loadLyrics](#loadlyrics)
  - [Voice receive](#voice-receive)
    - [Connection](#connection)
    - [Messages](#messages)
      - [startSpeakingEvent](#startspeakingevent)
      - [endSpeakingEvent](#endspeakingevent)


## Events

While NodeLink has the same events as LavaLink to ensure the full compatibility, it emits in different times.

### TrackStartEvent

NodeLink, differently from LavaLink, emits the `TrackStartEvent` when the `@performanc/voice` starts sending the audio data to Discord, while LavaLink emits the event when receives the play request.

## Filters

NodeLink doesn't have any difference in filtering system, this section is here to show unknown information about the filters.

### Stack filters

Filters uses a pipeline to process the audio, allowing the stack of filters to be processed in parallel. For example, you can use both `equalizer` and `timescale` filters at the same time.

There aren't limitations on how many filters you can use at the same time, be aware of the performance impact of using too many filters at the same time.

## Endpoints

Endpoints covers most of the LavaLink endpoints, except the route planner. It also features new endpoints.

### Compression

NodeLink offers compression for multiple compression formats:

- Brotli
- Gzip
- Deflate

> [!NOTE]
> Brotli should be used be used whenever possible. `Gzip` and `Deflate` are meant to be used to ensure compression availability for all clients, systems and languages.

### Websocket connection

NodeLink enforces the header `Client-Name` to be sent to identify the client and to match `NAME/VERSION (comment - optional)` format. It's used to identify the client and to ensure that the client is compatible with the NodeLink's API.

> [!NOTE]
> The `Client-Name` header should be hardcoded in the client, as it will be used to identify the client and not the bot.

### Errors

It's important to wait for the response of the endpoint to check if there's an error. Both LavaLink and NodeLink gives informative error messages for proper debugging and handling.

As per documented in the [LavaLink documentation](https://lavalink.dev/api/rest.html#error-responses), the error response is a JSON object with the following keys:

- `timestamp`: The timestamp of the error in milliseconds since the Unix epoch
- `status`: The HTTP status code
- `error`: The HTTP status code message
- `trace?`: The stack trace of the error when `trace=true` as query param has been sent
- `message`: The error message
- `path`: The request path

However, NodeLink's error message always includes `trace` key, containing the stack trace of the error, using `new Error().stack` to get the stack trace.

### Resuming

NodeLink doesn't support resuming, as it's not needed. The client should always keep the connection alive and if the connection is lost, the client should reconnect and send the play request again.

### Stats

NodeLink, although follows most of the structure for `/v4/stats`, we made `frameStats` to be an object instead of `null`, so the client can always expect an object.

### loadTracks

For better identification of the tracks, NodeLink introduces more `loadType`s, which are used to identify the type of the URL.

- `album` (playlist-like)
- `artist` (playlist-like)
- `playlist` (playlist-like)
- `station` (playlist-like)
- `podcast` (playlist-like)
- `show` (playlist-like)
- `short` (track-like)

### loadLyrics

NodeLink features a new endpoint, `loadLyrics`, which is used to load lyrics for the track. It's used to load lyrics from the supported sources. Currently it supports the following sources:

- Genius (Generic)
- MusixMatch (Generic)
- Deezer
- Spotify
- YouTube
- YouTube Music

> [!NOTE]
> `Deezer` and `Spotify` requires `arl` and `sp_dc` respectively to be used.

## Voice receive

NodeLink offers a totally new websocket endpoint, `/connection/data`, which is used to receive the audio data from the voice connection.

### Connection

To properly connect to the WebSocket, clients should send the following headers:

- `Authorization`: The NodeLink's secret key
- `User-Id`: The user ID of the user who's connecting
- `Guild-Id`: The guild ID of the guild where the user is connecting
- `Client-Name`: `NAME/VERSION (comment - optional)` to identify the client

### Messages

Messages are sent in plain json. The base structure of the message is:

```json
{
  "op": "speak",
  "type": ...,
  "data": ...
}
```

#### startSpeakingEvent

NodeLink emits the `startSpeakingEvent` type message when the user starts speaking. The `data` field contains the following keys:

- `userId`: The user ID of the user who started speaking.
- `guildId`: The guild ID of the guild where the user started speaking.

#### endSpeakingEvent

The `endSpeakingEvent` type message is emitted when the user stops speaking and all data is processed. The `data` field contains the following keys:

- `userId`: The user ID of the user who stopped speaking.
- `guildId`: The guild ID of the guild where the user stopped speaking.
- `data`: The audio data received from the user in base64.
- `type`: The type of the audio data. For compability in newer versions, it is always `opus`, but in older versions can be `ogg/opus`.

### Router planner

NodeLink doesn't have a route planner, as it's not needed. It's recommended to use a load balancer to distribute the load between the nodes. It's also recommended to use a reverse proxy to ensure the security and the stability of the system.
