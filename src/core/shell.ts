/** POSIX shell quoting for one word. The server's launch `line` and the popover's `--env` value
 *  both use it, so a path with a space is quoted the same way everywhere (v1.2 item 1).
 *  @offscreen: the ' here are shell quotes, not apostrophes; the word itself is shown as given. */
export const shellQuote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
