# Contributing

NodeLink is a big project, and highly easy to break, and for that, we made a few rules to make sure that the project is always in a good state.

## Indentation

It's extremely important that we keep the indentation consistent, so we use 2 spaces for indentation and no tabs.

The name of the variables should be in camelCase, and when a variable isn't re-assigned, it should be in const (var is not allowed).

## Commits

The name of the commits should follow the style below:

```txt
[UPDATED | ADDED | REMOVED] [SHORT DESCRIPTION]

[DESCRIPTION]

[IF THERE'S A CO-AUTHOR, ADD IT HERE (OPTIONAL)]
```

## Npms

While we love the idea of using npm, we don't want our project to be bloated with dependencies, and neither to depend on packages, so we use as few as possible. Although, feel free to use as many Node.js built-in npms as you want.

Here's a list of the packages we use, and you can use:

### ws

No dependencies

### @discord.js/voice

* discord-api-types
* prism-media
* tslib (soon to be removed)
* @types/ws (soon to be removed)

### prism-media

* opusscript
* @discordjs/opus
* node-opus

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

Security is a big issue, especially in big projects like NodeLink, to make sure that we keep NodeLink safe from attacks, we always make sure that we verify the input from the client, and we don't trust it, and we always make sure that we don't send any sensitive information to the client.

## End of the document

And that's it, you now know how to contribute to NodeLink, and if you have any questions, you can join PerformanC's [Discord server](https://discord.gg/uPveNfTuCJ) and ask for help in the #help channel.
