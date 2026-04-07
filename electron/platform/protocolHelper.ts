/**
 * local-file:// protocol 路徑解析
 *
 * 處理不同平台的路徑格式差異：
 * - macOS/Linux：路徑以 / 開頭，URL 解析後會產生雙斜線 //Users/...
 * - Windows：路徑以磁碟代號開頭，URL 解析後會產生 /C:/...
 */

/**
 * 將 URL pathname 轉為正確的本地檔案路徑
 *
 * @param pathname - decodeURIComponent 後的 URL pathname
 * @returns 可用於 pathToFileURL 的本地路徑
 *
 * @example
 * // macOS: //Users/foo/bar.vrm → /Users/foo/bar.vrm
 * // Windows: /C:/Users/foo/bar.vrm → C:/Users/foo/bar.vrm
 */
export function resolveLocalFilePath(pathname: string): string {
  let filePath = pathname;

  // macOS/Linux：移除前導雙斜線（//Users/... → /Users/...）
  while (filePath.startsWith('//')) {
    filePath = filePath.substring(1);
  }

  // Windows：移除磁碟代號前的斜線（/C:/path → C:/path）
  if (filePath.match(/^\/[A-Za-z]:\//)) {
    filePath = filePath.substring(1);
  }

  return filePath;
}
