# Contributing

## Code of Conduct

While contributing to this project, you must follow our [Code of Conduct](CODE_OF_CONDUCT.md), which is a set of rules that you must follow to ensure the quality of the project and the safety of the developers and users of any application made by it.

## Types of contributions

### Bug reports & feature requests

If you discover a bug or want to ask for a feature, you will want to create a new issue on the [issues](https://github.com/PerformanC/NodeLink/issues/new) and select the `Issue` or `Feature request` as the template.

### Security vulnerabilities

Security vulnerabilities are something serious, and while they're not fixed, they must be kept private, so if you discover a security vulnerability, you must report it privately through Github to ensure that the vulnerability is fixed before it's exploited. This can be done through the [Security Advisories](https://github.com/PerformanC/NodeLink/security/advisories/new).

## Code contribution

Any major contribution made by collaborators must be made through a pull request, and it must be approved by at least one of the collaborators. This also counts for users that want to contribute to the project.

Minor contributions, such as fixing typos, can be made directly through the GitHub interface and pushed directly to the `main` branch.

## Indentation

You must use the same indentation as the rest of the project to ensure the readability of the code, and the indentation is:

- 2 spaces
- camelCase for anything else than macros, and macros should be in SCREAMING_SNAKE_CASE
- No semicolons, except for when it's needed
- Always use const, unless you need to re-assign the variable, then use let

## Commit messages

The commit messages are standardized, and they must follow the style below:

```txt
add | update | remove | fix | improve: short description

Full description of the commit.

Co-authored-by: name <email> (optional)
```

## Pull Request & Issues

You must follow the pull request template when creating a pull request or an issue, and you must follow the pull request checklist.

Always be sure that you're using the latest branch, and that you're not creating a pull request or an issue that's already made.

## Reviewing

All reviews must check if the updated code follows the [PerformanC philosophy](#the-performanc-philosophy), and if it follows the [code quality](#code-quality) and [performance](#performance) rules. Also checking if the code works as intended.

## The PerformanC philosophy

The PerformanC philosophy is a set of rules that we follow to ensure that the project is the best it can be and that it follows the PerformanC philosophy.

Listed in priority order, the topics are:

### Security

Before everything, security is the most important thing, ensure that the code is impossible to exploit and hard to misuse.

### Portability

One code, multiple platforms. A good code can be used on multiple platforms, and it must be easy to port the code to other platforms.

### Code quality

Always make good code, that is easy to understand, maintain and re-use. Think like it will last forever.

### Performance

Don't wait for machines to get faster, make the code faster. Performance is never enough if you can make it faster without sacrificing code quality, security or portability.

### Innovation

Innovate the wheel if that will make it better. Don't be afraid to try new things, and don't be afraid to fail. Everything from this world was someone that went against the flow and tried something new.
