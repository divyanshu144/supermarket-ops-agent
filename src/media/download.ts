import type { Context } from 'grammy';

/**
 * Fetches a file the owner sent. The download URL embeds the bot token, which is why the
 * redactor matches tokens inside URLs — an error here would otherwise log it.
 */
export async function downloadTelegramFile(ctx: Context, token: string): Promise<Buffer> {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the file (${response.status}).`);

  return Buffer.from(await response.arrayBuffer());
}
