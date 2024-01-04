# NodeLink client development

## Differences from Lavalink

While we try to keep NodeLink as close to Lavalink as possible, sometimes we have to make changes to the API so we can add more features to NodeLink, or make it easier to use.

Here's a small list of differences between NodeLink and Lavalink which is important to know when developing a client for NodeLink, since can add more features to your client, and make it faster.

## Endpoints

### LoadTracks

The loadtracks have a small difference between NodeLink and Lavalink, while in Lavalink we have only `track`, `playlist`, `search`, `empty` and `error`, NodeLink has one more, `shorts`, `album`, `artist`, `show`, `episode`, so that you can differentiate tracks from others. This endpoint is available in all NodeLink versions.

### loadCaptions / loadLyrics

The `loadCaptions` endpoint is a NodeLink-only endpoint, which allows you to get the captions of a YouTube video, and it's only available for YouTube videos, for now. This endpoint is available since NodeLink 1.7.0.

In `v1.15.0` this endpoint was renamed to loadLyrics and the response was changed.

### EncodeTrack

NodeLink-only endpoint, which allows you to encode a track, so you can send it to the client. Available since NodeLink 1.1.0.

## GetRouterPlanner

This endpoint is not available in NodeLink, and it's not planned to be added.

## Requests

There's a big issue with Node.js, the fact that QUIC is not supported, and this causes to NodeLink be relatively slower than Lavalink, if it wasn't the support for compression.

The compression is not enabled in all endpoints, the /version endpoint doesn't support it, and neither 401 responses do.

For you to enable compression, you need to send the `Accept-Encoding` header with the value `br`, and NodeLink will send the response compressed, and for now, it only supports brotli compression.

## End of the document

And that's it, you now know the differences between NodeLink and Lavalink, and you can start developing your client for NodeLink, and if you have any questions, you can join PerformanC's [Discord server](https://discord.gg/uPveNfTuCJ) and ask for help in the #help channel.
