/** PTY helper loader.
 *
 *  Exports the Python PTY helper script source as a string. At build time,
 *  esbuild's text loader embeds the .py file content here. Consumers then
 *  write the source to disk and invoke it via `python3 <path>`. */

// @ts-ignore — .py is not a known TS extension, esbuild text loader resolves it
import ptyHelperSource from "./pty-helper.py";

export const PTY_HELPER_SOURCE: string = ptyHelperSource as unknown as string;
