# Apple Shortcut template

`Ask Assistant.shortcut.json` is the credential-free source for the personal
Shortcut. It asks for a command, starts a Text Assistant session, polls while
work is running, captures clarification or confirmation answers in the same
voice turn, and speaks the terminal result.

`npm run shortcut:package` replaces the local-address placeholder only in a
temporary copy, signs the installable Shortcut for People Who Know Me, and
writes `dist/shortcuts/Ask Assistant.shortcut`. Generated output is
intentionally ignored by Git.

See [`../../docs/apple-shortcuts.md`](../../docs/apple-shortcuts.md) for setup.
