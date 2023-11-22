# Contributing

Because of NodeLink's size, it's easy to break it. To ensure its stability and maintainability, we have a few protocols to follow.

## Indentation

Firstly, for better readability, we keep the same indentation across all PerformanC projects, which is:

- 2 spaces
- camelCase for anything else than macros, and macros should be in SCREAMING_SNAKE_CASE
- No semicolons, except for when it's needed
- Always use const, unless you need to re-assign the variable

## Commits

The name of the commits **MUST** follow the style below:

```txt
add | update | remove | fix | improve: short description

Full description

If there are co-authors, add them here.
```

## NPMs

While the idea of using npm is great, they can slow down the project and create security issues, so we try to use as few as possible, and we don't use any packages that are not needed.

We enforce the idea of using built-in Node.js modules over third-party packages.

And because we do use some packages, we have a list of packages that we use (in this project), and that you can use:

### node-crc

- @napi-rs/cli

### @discord.js/voice (PerformanC's fork)

#### Required

- discord-api-types
- prism-media
- tslib (soon to be removed)

#### Optional

- libsodium-wrappers
- sodium-native

All of these packages are optional, but at least one of them is required.

### prism-media

- opusscript
- @discordjs/opus
- node-opus

All of these packages are optional, but at least one of them is required, to use them, you can use `prism.opus` instead.

### FFmpeg

FFmpeg is not a package, but a program, and it's required to use NodeLink, you can download it [here](https://ffmpeg.org/download.html), or you can use `ffmpeg-static` to use the static version of FFmpeg.

Those are available through `prism-media`, with the `FFmpeg` class.

## Functions

Functions should be only created when they are used more than once, and when duplicating the code would be a bad idea, if not, you should just copy the code, and paste it where it's needed.

## Customizable or not?

If you want to add a feature to NodeLink, you should allow the users to have a choice and transparency of what NodeLink is doing, for that, you should create options to disable it, change values and etc.

## Breaking changes

breaking changes are allowed, but only if they either are necessary or will improve performance, improve bandwidth usage. Those should be listed in the changelog.

## Security

To ensure NodeLink's security, always check the input from the client, and never trust it, and always make sure to not send any sensitive information to the client or give it access to any potentially dangerous functions.

## End of the document

And that's it, you now know how to contribute to NodeLink, and if you have any questions, you can join PerformanC's [Discord server](https://discord.gg/uPveNfTuCJ) and ask for help in the #help channel.
